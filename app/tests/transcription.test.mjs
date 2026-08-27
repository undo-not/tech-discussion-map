import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { downmixAndResample48kStereoTo16kMono } from '../adapters/audio/pcm.ts';
import { isLoopbackRuntime } from '../adapters/audio/browser-microphone.ts';
import { companionUrl, maximumAudioChunkBytes, maximumQueuedAudioBytes } from '../adapters/transcription/local-companion-client.ts';
import { createPrivacySafeStructuredResponsesRequest } from '../adapters/privacy/openai-request-policy.ts';
import { analysisStructuredOutput } from '../domain/analysis/schema.ts';
import { redactText } from '../domain/privacy/redaction.ts';
import { transitionTranscriptionSession } from '../domain/transcription/session.ts';
import {
  adoptStartedInput,
  beginInputStart,
  cancelInputStart,
  createInputStartGate,
  finishInputStart,
  inputAttemptControlsState,
  inputAttemptOwnsSession,
  releaseInputAttempt,
} from '../domain/transcription/input-start-gate.ts';
import { applyTranscriptEvent, emptyTranscriptState } from '../domain/transcription/utterance.ts';
import { createCompanionServer, frameForWorker, parseWorkerEvents } from '../../companion/local-transcription-host.mjs';

test('partial, duplicate, out-of-order, and corrected final events are deterministic', () => {
  const base = { id: 'local-1', source: 'local', speaker: 'self', startMs: 0, endMs: 800, text: '設計を確認' };
  let state = applyTranscriptEvent(emptyTranscriptState, { ...base, revision: 1, phase: 'partial' });
  state = applyTranscriptEvent(state, { ...base, revision: 1, phase: 'partial' });
  assert.equal(state.utterances.length, 1);
  state = applyTranscriptEvent(state, { ...base, revision: 3, phase: 'final', text: '設計を確認します' });
  state = applyTranscriptEvent(state, { ...base, revision: 2, phase: 'partial', text: '古い途中結果' });
  assert.equal(state.utterances[0].text, '設計を確認します');
  assert.equal(state.finalForAnalysis.length, 1);
  state = applyTranscriptEvent(state, { ...base, revision: 4, phase: 'final', text: '設計方針を確認します' });
  assert.equal(state.finalForAnalysis.length, 2, 'a corrected final is an explicit analyzer event');
});

test('session requires an explicit start before permission and engine transitions', () => {
  assert.equal(transitionTranscriptionSession('idle', { type: 'permission-granted' }), 'idle');
  let state = transitionTranscriptionSession('idle', { type: 'start-requested' });
  assert.equal(state, 'requesting-permission');
  state = transitionTranscriptionSession(state, { type: 'permission-granted' });
  assert.equal(state, 'starting-local-engine');
  state = transitionTranscriptionSession(state, { type: 'started' });
  assert.equal(state, 'listening');
  assert.equal(transitionTranscriptionSession('idle', { type: 'demo-started' }), 'listening');
  assert.equal(transitionTranscriptionSession('requesting-permission', { type: 'engine-unavailable' }), 'engine-unavailable');
  for (const failed of ['permission-denied', 'device-unavailable', 'engine-unavailable']) {
    let retry = transitionTranscriptionSession(failed, { type: 'start-requested' });
    assert.equal(retry, 'requesting-permission');
    retry = transitionTranscriptionSession(retry, { type: 'permission-granted' });
    retry = transitionTranscriptionSession(retry, { type: 'started' });
    assert.equal(retry, 'listening');
  }
});

test('only one input start can be pending and a cancelled completion is stopped instead of adopted', async () => {
  const gate = createInputStartGate();
  const first = beginInputStart(gate);
  assert.equal(typeof first, 'number');
  assert.equal(beginInputStart(gate), null);
  let stopped = 0;
  let adopted = 0;
  cancelInputStart(gate);
  assert.equal(await adoptStartedInput(gate, first, { async stop() { stopped += 1; } }, () => true, () => { adopted += 1; }), false);
  assert.equal(stopped, 1);
  assert.equal(adopted, 0);

  const retry = beginInputStart(gate);
  assert.equal(await adoptStartedInput(gate, retry, { async stop() { stopped += 1; } }, () => true, () => { adopted += 1; }), true);
  finishInputStart(gate, retry);
  assert.equal(inputAttemptOwnsSession(gate, retry), true);
  assert.equal(beginInputStart(gate), null, 'an adopted session remains exclusive after startup finishes');
  releaseInputAttempt(gate, retry);
  assert.equal(adopted, 1);
  assert.equal(stopped, 1);
});

test('a cancelled old attempt cannot mutate or deliver into its replacement session', async () => {
  const gate = createInputStartGate();
  const oldAttempt = beginInputStart(gate);
  const oldInput = { async stop() {} };
  assert.equal(await adoptStartedInput(gate, oldAttempt, oldInput, () => true, () => undefined), true);
  cancelInputStart(gate);

  const replacementAttempt = beginInputStart(gate);
  const replacementInput = { async stop() {} };
  let activeInput = replacementInput;
  assert.equal(await adoptStartedInput(gate, replacementAttempt, replacementInput, () => true, () => undefined), true);
  finishInputStart(gate, replacementAttempt);

  let state = 'replacement-listening';
  if (inputAttemptControlsState(gate, oldAttempt)) state = 'stopped-by-old-catch';
  let delivered = 0;
  if (inputAttemptOwnsSession(gate, oldAttempt) && activeInput === oldInput) delivered += 1;

  assert.equal(state, 'replacement-listening');
  assert.equal(delivered, 0);
  assert.equal(inputAttemptOwnsSession(gate, replacementAttempt), true);
  assert.equal(activeInput, replacementInput);
});

test('Teams PCM downmixes and decimates to the shared 16 kHz transcription port', () => {
  const bytes = new Uint8Array(12);
  const view = new DataView(bytes.buffer);
  [3000, 6000, 9000, 12000, 15000, 18000].forEach((sample, index) => view.setInt16(index * 2, sample, true));
  const output = downmixAndResample48kStereoTo16kMono(bytes);
  assert.equal(new DataView(output.buffer).getInt16(0, true), 10500);
});

test('transcription client refuses every non-loopback network target', () => {
  assert.equal(companionUrl('/v1/bootstrap').origin, 'http://127.0.0.1:43117');
  assert.throws(() => companionUrl('https://example.com/upload'), /loopback-only/);
  assert.equal(maximumAudioChunkBytes, 128 * 1024);
  assert.equal(maximumQueuedAudioBytes, 512 * 1024);
  assert.equal(isLoopbackRuntime({ protocol: 'http:', hostname: '127.0.0.1' }), true);
  assert.equal(isLoopbackRuntime({ protocol: 'https:', hostname: 'public.example' }), false);
});

test('microphone adapter has no network or persistence sink', async () => {
  const testDirectory = fileURLToPath(new URL('.', import.meta.url));
  const source = await readFile(resolve(testDirectory, '..', 'adapters', 'audio', 'browser-microphone.ts'), 'utf8');
  assert.match(source, /getUserMedia/);
  assert.doesNotMatch(source, /fetch\s*\(|WebSocket|sendBeacon|indexedDB|localStorage|FileSystem/);
});

test('stopped transcription clients discard delayed poll batches before callbacks', async () => {
  const testDirectory = fileURLToPath(new URL('.', import.meta.url));
  for (const file of ['local-companion-client.ts', 'local-caption-client.ts']) {
    const source = await readFile(resolve(testDirectory, '..', 'adapters', 'transcription', file), 'utf8');
    assert.match(source, /if \(this\.#closed\) return;[\s\S]{0,300}for \(const event of value\.events\)/);
    assert.match(source, /for \(const event of value\.events\) \{\s+if \(this\.#closed\) return;/);
  }
});

test('worker protocol parser handles split typed frames and rejects malformed data', () => {
  const event = { id: 'local-000001', revision: 1, phase: 'partial', source: 'local', speaker: 'self', startMs: 0, endMs: 2000, text: '合成テスト' };
  const body = Buffer.from(JSON.stringify(event));
  const header = Buffer.alloc(12);
  header.write('TMO1'); header[4] = 1; header[5] = 1; header.writeUInt32LE(body.length, 8);
  const parser = { buffer: Buffer.alloc(0) };
  assert.deepEqual(parseWorkerEvents(parser, header.subarray(0, 5)), []);
  assert.deepEqual(parseWorkerEvents(parser, Buffer.concat([header.subarray(5), body])), [event]);
  assert.throws(() => parseWorkerEvents({ buffer: Buffer.alloc(0) }, Buffer.from('BAD!\x01\x01\0\0\0\0\0\0')), /invalid-worker-protocol/);
  assert.equal(frameForWorker(1, Buffer.from([1, 2])).subarray(0, 4).toString(), 'TMI1');
});

test('companion binds as an authenticated loopback-only PCM bridge', async (context) => {
  const launchSecret = 'a'.repeat(64);
  const root = await mkdtemp(join(tmpdir(), 'techmap-transcription-test-'));
  const modelRoot = join(root, 'TechMapLive', 'models');
  const modelPath = join(modelRoot, 'ggml-tiny.bin');
  const workerPath = join(root, 'worker.exe');
  await mkdir(modelRoot, { recursive: true });
  await writeFile(modelPath, 'synthetic-model-placeholder');
  await writeFile(workerPath, 'synthetic-worker-placeholder');

  class FakeWorker extends EventEmitter {
    stdin = new PassThrough();
    stdout = new PassThrough();
    killed = false;
    kill() { this.killed = true; this.emit('exit', 0); }
  }
  const worker = new FakeWorker();
  let capturedAnalysisRequest;
  const privacyStore = { responses: async (request) => { capturedAnalysisRequest = request; return { status: 'completed', output: [{ content: [{ type: 'output_text', text: '{"contractVersion":1,"baseRevision":0,"operations":[]}' }] }] }; } };
  const server = createCompanionServer({ environment: { LOCALAPPDATA: root }, modelPath, workerPath, spawnWorker: () => worker, launchSecret, privacyStore });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  context.after(async () => {
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(root, { recursive: true, force: true });
  });
  const address = server.address();
  assert.equal(address.address, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  const reboundStatus = await new Promise((resolveRequest, rejectRequest) => {
    const request = httpRequest({ hostname: '127.0.0.1', port: address.port, path: '/v1/bootstrap', method: 'POST', headers: { Host: 'attacker.example', Origin: 'http://127.0.0.1:3000', 'Content-Type': 'application/json', 'Content-Length': 2 } }, (response) => {
      response.resume();
      response.on('end', () => resolveRequest(response.statusCode));
    });
    request.on('error', rejectRequest);
    request.end('{}');
  });
  assert.equal(reboundStatus, 403);
  const blocked = await fetch(`${base}/v1/bootstrap`, { method: 'POST', headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(blocked.status, 403);
  const missingSecret = await fetch(`${base}/v1/bootstrap`, { method: 'POST', headers: { Origin: 'http://127.0.0.1:3000', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(missingSecret.status, 401);
  const bootstrap = await fetch(`${base}/v1/bootstrap`, { method: 'POST', headers: { Origin: 'http://127.0.0.1:3000', 'Content-Type': 'application/json' }, body: JSON.stringify({ launchSecret }) });
  const { token } = await bootstrap.json();
  const headers = { Origin: 'http://127.0.0.1:3000', Authorization: `Bearer ${token}` };
  const redacted = redactText('合成された安全な分析window');
  assert.equal(redacted.ok, true);
  const analysisRequest = createPrivacySafeStructuredResponsesRequest('gpt-5-mini', redacted.text, analysisStructuredOutput);
  const analyzed = await fetch(`${base}/v1/analysis`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(analysisRequest) });
  assert.equal(analyzed.status, 200);
  assert.equal(capturedAnalysisRequest.store, false);
  const rejectedAnalysis = await fetch(`${base}/v1/analysis`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...analysisRequest, background: true }) });
  assert.equal(rejectedAnalysis.status, 400);
  for (let index = 0; index < 5; index += 1) {
    const response = await fetch(`${base}/v1/analysis`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(analysisRequest) });
    assert.equal(response.status, 200);
  }
  const rateLimited = await fetch(`${base}/v1/analysis`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(analysisRequest) });
  assert.equal(rateLimited.status, 429);
  const secondBootstrap = await fetch(`${base}/v1/bootstrap`, { method: 'POST', headers: { Origin: 'http://127.0.0.1:3000', 'Content-Type': 'application/json' }, body: JSON.stringify({ launchSecret }) });
  const secondHeaders = { Origin: 'http://127.0.0.1:3000', Authorization: `Bearer ${(await secondBootstrap.json()).token}` };
  const thirdBootstrap = await fetch(`${base}/v1/bootstrap`, { method: 'POST', headers: { Origin: 'http://127.0.0.1:3000', 'Content-Type': 'application/json' }, body: JSON.stringify({ launchSecret }) });
  const thirdHeaders = { Origin: 'http://127.0.0.1:3000', Authorization: `Bearer ${(await thirdBootstrap.json()).token}` };
  const concurrent = await Promise.all(Array.from({ length: 8 }, (_, index) => fetch(`${base}/v1/analysis`, {
    method: 'POST', headers: { ...(index % 2 === 0 ? secondHeaders : thirdHeaders), 'Content-Type': 'application/json' }, body: JSON.stringify(analysisRequest),
  })));
  assert.equal(concurrent.filter((response) => response.status === 200).length, 6);
  assert.equal(concurrent.filter((response) => response.status === 429).length, 2);
  const started = await fetch(`${base}/v1/sessions`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'local', sampleRate: 16000, channels: 1, encoding: 'pcm-s16le' }) });
  const { sessionId } = await started.json();
  let input = Buffer.alloc(0);
  worker.stdin.on('data', (chunk) => { input = Buffer.concat([input, chunk]); });
  const accepted = await fetch(`${base}/v1/sessions/${sessionId}/audio`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: Buffer.from([0, 0, 1, 0]) });
  assert.equal(accepted.status, 202);
  assert.equal(input.subarray(0, 4).toString(), 'TMI1');
  worker.stdin.emit('error', new Error('synthetic-epipe'));
  const companionStillAlive = await fetch(`${base}/v1/privacy/status`, { headers });
  assert.equal(companionStillAlive.status, 503, 'companion remains reachable; this fixture intentionally has no privacy status runner');

});

test('active local bearer sessions slide their idle expiry and eventually fail closed', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'techmap-token-test-'));
  const launchSecret = 'f'.repeat(64);
  let clock = 0;
  const privacyStore = {
    status: async () => ({ secureStore: true, credentialConfigured: false, location: 'synthetic' }),
  };
  const server = createCompanionServer({
    environment: { LOCALAPPDATA: root }, launchSecret, privacyStore,
    now: () => clock, tokenLifetimeMs: 1_000,
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  context.after(async () => {
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const origin = 'http://127.0.0.1:3000';
  const bootstrap = await fetch(`${base}/v1/bootstrap`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ launchSecret }),
  });
  const { token } = await bootstrap.json();
  const headers = { Origin: origin, Authorization: `Bearer ${token}` };
  clock = 900;
  assert.equal((await fetch(`${base}/v1/privacy/status`, { headers })).status, 200);
  clock = 1_800;
  assert.equal((await fetch(`${base}/v1/privacy/status`, { headers })).status, 200);
  clock = 2_801;
  assert.equal((await fetch(`${base}/v1/privacy/status`, { headers })).status, 401);
});
