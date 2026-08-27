import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { captionCompanionUrl } from '../adapters/transcription/local-caption-client.ts';
import { parseCaptionRuntimeEvent } from '../adapters/transcription/teams-caption-frames.ts';
import { applyCaptionSourceEvent, captionSettleMilliseconds } from '../domain/transcription/caption-source.ts';
import { applyTranscriptEvent, emptyTranscriptState } from '../domain/transcription/utterance.ts';
import { createCompanionServer } from '../../companion/local-transcription-host.mjs';

const observationFrame = {
  v: 1, type: 'observation', rowId: 'ocr-a1b2c3d4-1', revision: 1, source: 'teams-ocr',
  speaker: 'displayed-alias', speakerAlias: 'speaker-1', observedAtMs: 1_000,
  text: '合成された字幕', confidence: 95,
};

function workerFrame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(12);
  header.write('TMO1'); header[4] = 1; header[5] = 1; header.writeUInt32LE(payload.length, 8);
  return Buffer.concat([header, payload]);
}

test('caption runtime parser rejects raw identity, unknown fields, and low confidence', () => {
  const parsed = parseCaptionRuntimeEvent(observationFrame);
  assert.equal(parsed.type, 'observation');
  assert.equal(parsed.observation.speakerAlias, 'speaker-1');
  assert.throws(() => parseCaptionRuntimeEvent({ ...observationFrame, rawDisplayName: 'Example Person' }), /invalid-caption-runtime-observation/);
  assert.throws(() => parseCaptionRuntimeEvent({ ...observationFrame, confidence: 84 }), /invalid-caption-runtime-observation/);
  assert.throws(() => parseCaptionRuntimeEvent({ ...observationFrame, speakerAlias: 'Example Person' }), /invalid-caption-runtime-observation/);
  const anonymousFrame = { ...observationFrame, speaker: 'anonymous' };
  delete anonymousFrame.speakerAlias;
  assert.equal(parseCaptionRuntimeEvent(anonymousFrame).observation.speaker, 'anonymous');
  assert.deepEqual(parseCaptionRuntimeEvent({ v: 1, type: 'state', state: 'selecting-target', reason: 'user-selection-required' }), {
    type: 'state', state: 'selecting-target', reason: 'user-selection-required',
  });
  assert.equal(captionCompanionUrl('/v1/caption-sessions').origin, 'http://127.0.0.1:43117');
  assert.throws(() => captionCompanionUrl('https://example.com/capture'), /loopback-only/);
});

test('synthetic native observation reaches the existing final transcript contract', () => {
  const runtime = parseCaptionRuntimeEvent(observationFrame);
  assert.equal(runtime.type, 'observation');
  let assembled = applyCaptionSourceEvent({ sourceState: 'active-ocr', rows: [] }, runtime);
  assert.equal(assembled.utterances[0].source, 'teams-caption');
  assembled = applyCaptionSourceEvent(assembled.state, { type: 'tick', observedAtMs: 1_000 + captionSettleMilliseconds });
  const transcript = applyTranscriptEvent(emptyTranscriptState, assembled.utterances[0]);
  assert.equal(transcript.finalForAnalysis[0].speakerAlias, 'speaker-1');
  assert.equal(transcript.finalForAnalysis[0].text, '合成された字幕');
});

test('caption companion requires consent and forwards only validated framed events', async (context) => {
  const localAppData = await mkdtemp(join(tmpdir(), 'techmap-caption-companion-'));
  const captionWorkerPath = join(localAppData, 'techmap-captions.exe');
  await writeFile(captionWorkerPath, 'synthetic-worker-placeholder');
  class FakeWorker extends EventEmitter {
    stdin = new PassThrough();
    stdout = new PassThrough();
    killed = false;
    kill() { if (this.killed) return; this.killed = true; this.emit('exit', 0); }
  }
  const workers = [];
  const workerArguments = [];
  const launchSecret = 'b'.repeat(64);
  const server = createCompanionServer({
    environment: { LOCALAPPDATA: localAppData }, captionWorkerPath, launchSecret,
    spawnCaptionWorker: (args) => { const worker = new FakeWorker(); workers.push(worker); workerArguments.push(args); return worker; },
    privacyStore: {},
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  context.after(async () => {
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(localAppData, { recursive: true, force: true });
  });
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const origin = 'http://127.0.0.1:3000';
  const bootstrap = await fetch(`${base}/v1/bootstrap`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ launchSecret }),
  });
  const token = (await bootstrap.json()).token;
  const headers = { Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const denied = await fetch(`${base}/v1/caption-sessions`, { method: 'POST', headers, body: JSON.stringify({ consentConfirmed: false }) });
  assert.equal(denied.status, 400);
  assert.equal(workers.length, 0);
  const started = await fetch(`${base}/v1/caption-sessions`, { method: 'POST', headers, body: JSON.stringify({ consentConfirmed: true }) });
  assert.equal(started.status, 201);
  const { sessionId } = await started.json();
  assert.deepEqual(workerArguments[0].slice(0, 3), ['ocr-capture', '--consent-confirmed', '--session-proof']);
  assert.match(workerArguments[0][3], /^[a-f0-9]{64}$/);
  const proofChunks = [];
  for await (const chunk of workers[0].stdin) proofChunks.push(chunk);
  assert.equal(Buffer.concat(proofChunks).toString('ascii'), workerArguments[0][3]);
  workers[0].stdout.write(workerFrame(observationFrame));
  const events = await fetch(`${base}/v1/caption-sessions/${sessionId}/events?after=0`, { headers: { Origin: origin, Authorization: `Bearer ${token}` } });
  const eventBody = await events.json();
  assert.deepEqual(eventBody.events, [observationFrame]);
  const duplicateResume = await fetch(`${base}/v1/caption-sessions/${sessionId}/resume`, { method: 'POST', headers: { Origin: origin, Authorization: `Bearer ${token}` } });
  assert.equal(duplicateResume.status, 409);
  assert.equal(workers.length, 1);
  const paused = await fetch(`${base}/v1/caption-sessions/${sessionId}/pause`, { method: 'POST', headers: { Origin: origin, Authorization: `Bearer ${token}` } });
  assert.equal((await paused.json()).reselectOnResume, true);
  assert.equal(workers[0].killed, true);
  const pausedEvents = await fetch(`${base}/v1/caption-sessions/${sessionId}/events?after=0`, { headers: { Origin: origin, Authorization: `Bearer ${token}` } });
  assert.deepEqual((await pausedEvents.json()).events, []);
  const resumed = await fetch(`${base}/v1/caption-sessions/${sessionId}/resume`, { method: 'POST', headers: { Origin: origin, Authorization: `Bearer ${token}` } });
  assert.equal((await resumed.json()).state, 'selecting-target');
  assert.equal(workers.length, 2);
  const secondResume = await fetch(`${base}/v1/caption-sessions/${sessionId}/resume`, { method: 'POST', headers: { Origin: origin, Authorization: `Bearer ${token}` } });
  assert.equal(secondResume.status, 409);
  assert.equal(workers.length, 2);
  workers[1].stdout.write(workerFrame({ ...observationFrame, rawDisplayName: 'Example Person' }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(workers[1].killed, true);
  const stoppedEvents = await fetch(`${base}/v1/caption-sessions/${sessionId}/events?after=0`, { headers: { Origin: origin, Authorization: `Bearer ${token}` } });
  assert.deepEqual((await stoppedEvents.json()).events, []);
});
