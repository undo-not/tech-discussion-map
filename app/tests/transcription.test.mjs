import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { downmixAndResample48kStereoTo16kMono } from '../adapters/audio/pcm.ts';
import { isLoopbackRuntime } from '../adapters/audio/browser-microphone.ts';
import { companionUrl, maximumAudioChunkBytes, maximumQueuedAudioBytes } from '../adapters/transcription/local-companion-client.ts';
import { transitionTranscriptionSession } from '../domain/transcription/session.ts';
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

test('companion binds as an authenticated loopback-only PCM bridge', async () => {
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
  const server = createCompanionServer({ environment: { LOCALAPPDATA: root }, modelPath, workerPath, spawnWorker: () => worker });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  assert.equal(address.address, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  const blocked = await fetch(`${base}/v1/bootstrap`, { method: 'POST', headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(blocked.status, 403);
  const bootstrap = await fetch(`${base}/v1/bootstrap`, { method: 'POST', headers: { Origin: 'http://127.0.0.1:3000', 'Content-Type': 'application/json' }, body: '{}' });
  const { token } = await bootstrap.json();
  const headers = { Origin: 'http://127.0.0.1:3000', Authorization: `Bearer ${token}` };
  const started = await fetch(`${base}/v1/sessions`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'local', sampleRate: 16000, channels: 1, encoding: 'pcm-s16le' }) });
  const { sessionId } = await started.json();
  let input = Buffer.alloc(0);
  worker.stdin.on('data', (chunk) => { input = Buffer.concat([input, chunk]); });
  const accepted = await fetch(`${base}/v1/sessions/${sessionId}/audio`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: Buffer.from([0, 0, 1, 0]) });
  assert.equal(accepted.status, 202);
  assert.equal(input.subarray(0, 4).toString(), 'TMI1');

  await new Promise((resolveClose) => server.close(resolveClose));
  await rm(root, { recursive: true, force: true });
});
