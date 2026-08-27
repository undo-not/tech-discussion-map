import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { transitionCaptureState } from '../domain/audio/capture.ts';
import { TeamsProcessAudioProtocolParser } from '../adapters/teams-process-audio-protocol.ts';
import { LocalTeamsAudioClient, parseTeamsAudioClientEvent, parseTeamsAudioProbeResponse, teamsAudioCompanionUrl } from '../adapters/audio/local-teams-audio-client.ts';
import { createCompanionServer, frameForWorker } from '../../companion/local-transcription-host.mjs';
import { attachTeamsAudioBridge, parseTeamsAudioProbeReport, runTeamsAudioProbe } from '../../companion/teams-audio-bridge.mjs';

function frame(type, payload) {
  const body = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
  const result = new Uint8Array(12 + body.byteLength);
  result.set([0x54, 0x4d, 0x41, 0x31, 1, type, 0, 0]);
  new DataView(result.buffer).setUint32(8, body.byteLength, true);
  result.set(body, 12);
  return result;
}

function outputFrame(value) {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(12);
  header.write('TMO1');
  header[4] = 1;
  header[5] = 1;
  header.writeUInt32LE(body.length, 8);
  return Buffer.concat([header, body]);
}

class FakeWorker extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  killed = false;
  kill() { this.killed = true; this.emit('exit', 0); }
}

test('binary IPC parser handles split state and PCM frames', () => {
  const parser = new TeamsProcessAudioProtocolParser();
  const state = frame(1, JSON.stringify({ state: 'active', reason: 'capture-started' }));
  const pcm = frame(2, new Uint8Array([1, 2, 3, 4]));
  const joined = new Uint8Array(state.byteLength + pcm.byteLength);
  joined.set(state);
  joined.set(pcm, state.byteLength);

  assert.deepEqual(parser.push(joined.slice(0, 7)), []);
  const parsed = parser.push(joined.slice(7));
  assert.deepEqual(parsed[0], { type: 'state', state: 'active', reason: 'capture-started' });
  assert.deepEqual([...parsed[1].bytes], [1, 2, 3, 4]);
});

test('degraded capture never returns to active without explicit reconnect', () => {
  let state = transitionCaptureState('active', { type: 'stream-failed' });
  assert.equal(state, 'degraded-microphone-only');
  state = transitionCaptureState(state, { type: 'remote-signal' });
  assert.equal(state, 'degraded-microphone-only');
  state = transitionCaptureState(state, { type: 'capture-started', explicitReconnect: false });
  assert.equal(state, 'degraded-microphone-only');
  state = transitionCaptureState(state, { type: 'capture-started', explicitReconnect: true });
  assert.equal(state, 'active');
});

test('binary IPC parser fails closed for malformed frames', () => {
  const invalidReason = frame(1, JSON.stringify({ state: 'active', reason: '../meeting-audio' }));
  assert.throws(() => new TeamsProcessAudioProtocolParser().push(invalidReason), /Invalid Teams audio state frame/);
  const extraMetadata = frame(1, JSON.stringify({ state: 'active', reason: 'capture-started', processName: 'forbidden' }));
  assert.throws(() => new TeamsProcessAudioProtocolParser().push(extraMetadata), /Invalid Teams audio state frame/);

  const unalignedPcm = frame(2, new Uint8Array([1, 2, 3]));
  assert.throws(() => new TeamsProcessAudioProtocolParser().push(unalignedPcm), /Invalid Teams PCM frame size/);
});

test('parser clear discards an incomplete remote audio frame before reuse', () => {
  const parser = new TeamsProcessAudioProtocolParser();
  assert.deepEqual(parser.push(frame(1, JSON.stringify({ state: 'active', reason: 'capture-started' })).slice(0, 8)), []);
  parser.clear();
  assert.deepEqual(parser.push(frame(1, JSON.stringify({ state: 'stopped', reason: 'capture-stopped' }))), [
    { type: 'state', state: 'stopped', reason: 'capture-stopped' },
  ]);
});

test('Teams audio probe accepts only the bounded exact metadata contract', async () => {
  const report = {
    windowsBuild: 26_100, minimumBuild: 20_348, supportedBuild: true, teamsProcessCount: 2,
    selectedProcessId: 4242, targetFound: true, activationAttempted: true, activationSucceeded: true,
    activationHresult: '0x00000000',
  };
  assert.deepEqual(parseTeamsAudioProbeReport(report), report);
  assert.deepEqual(parseTeamsAudioProbeResponse(report), report);
  assert.throws(() => parseTeamsAudioProbeReport({ ...report, windowTitle: 'forbidden' }), /invalid-teams-audio-probe-report/);
  assert.throws(() => parseTeamsAudioProbeResponse({ ...report, targetFound: false }), /inconsistent-teams-audio-probe/);

  const worker = new FakeWorker();
  const promise = runTeamsAudioProbe((args) => {
    assert.deepEqual(args, ['probe', '--activate']);
    return worker;
  }, 1_000);
  worker.stdout.end(`${JSON.stringify(report)}\n`);
  worker.emit('exit', 0);
  assert.deepEqual(await promise, report);
});

test('browser Teams audio adapter accepts only remote utterances and loopback URLs', () => {
  const utterance = { id: 'remote-2', revision: 1, phase: 'final', source: 'remote', speaker: 'remote-group', startMs: 1, endMs: 900, text: '合成の相手側発話' };
  assert.deepEqual(parseTeamsAudioClientEvent({ type: 'utterance', utterance }), { type: 'utterance', utterance });
  assert.deepEqual(parseTeamsAudioClientEvent({ type: 'capture-state', state: 'active', reason: 'capture-started' }), { type: 'capture-state', state: 'active', reason: 'capture-started' });
  assert.throws(() => parseTeamsAudioClientEvent({ type: 'utterance', utterance: { ...utterance, source: 'local', speaker: 'self' } }), /invalid-remote-utterance/);
  assert.equal(teamsAudioCompanionUrl('/v1/teams-audio/probe').origin, 'http://127.0.0.1:43117');
  assert.throws(() => teamsAudioCompanionUrl('https://example.com/audio'), /loopback-only/);
});

test('Teams audio client re-bootstraps once when an idle bearer expires', async () => {
  const originalFetch = globalThis.fetch;
  const report = {
    windowsBuild: 26_100, minimumBuild: 20_348, supportedBuild: true, teamsProcessCount: 1,
    selectedProcessId: 4242, targetFound: true, activationAttempted: true, activationSucceeded: true,
    activationHresult: '0x00000000',
  };
  let bootstrapCalls = 0;
  let probeCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === '/api/local-launch') return Response.json({ launchSecret: 'd'.repeat(64) });
    if (url.endsWith('/v1/bootstrap')) {
      bootstrapCalls += 1;
      return Response.json({ token: String(bootstrapCalls).repeat(64) });
    }
    if (url.endsWith('/v1/teams-audio/probe')) {
      probeCalls += 1;
      if (probeCalls === 1) return Response.json({ error: 'unauthorized' }, { status: 401 });
      assert.equal(init.headers.Authorization, `Bearer ${'2'.repeat(64)}`);
      return Response.json(report);
    }
    throw new Error(`unexpected synthetic fetch: ${url}`);
  };
  try {
    const client = new LocalTeamsAudioClient(() => undefined);
    assert.deepEqual(await client.probe(), report);
    assert.equal(bootstrapCalls, 2);
    assert.equal(probeCalls, 2);
    await client.stop();
  } finally { globalThis.fetch = originalFetch; }
});

test('process-scoped Teams PCM is downmixed into remote transcription without reaching the browser', async () => {
  const audioWorker = new FakeWorker();
  const transcriptionWorker = new FakeWorker();
  const captures = [];
  const utterances = [];
  const writes = [];
  transcriptionWorker.stdin.on('data', (chunk) => writes.push(Buffer.from(chunk)));
  const bridge = attachTeamsAudioBridge({
    audioWorker,
    transcriptionWorker,
    frameForWorker,
    parseWorkerEvents: (state, chunk) => {
      state.buffer = Buffer.concat([state.buffer, chunk]);
      if (state.buffer.length < 12) return [];
      const size = state.buffer.readUInt32LE(8);
      if (state.buffer.length < 12 + size) return [];
      const value = JSON.parse(state.buffer.subarray(12, 12 + size).toString('utf8'));
      state.buffer = state.buffer.subarray(12 + size);
      return [value];
    },
    onCaptureState: (event) => captures.push(event),
    onUtterance: (event) => utterances.push(event),
    onFailure: (reason) => assert.fail(`unexpected bridge failure: ${reason}`),
  });
  const format = frame(3, JSON.stringify({ sampleRate: 48_000, channels: 2, bitsPerSample: 16, encoding: 'pcm-s16le' }));
  const active = frame(1, JSON.stringify({ state: 'active', reason: 'capture-started' }));
  const pcm = new Uint8Array(12);
  const view = new DataView(pcm.buffer);
  [3000, 6000, 9000, 12000, 15000, 18000].forEach((sample, index) => view.setInt16(index * 2, sample, true));
  audioWorker.stdout.write(Buffer.concat([format, active, frame(2, pcm)]));
  await new Promise((resolveWait) => setImmediate(resolveWait));
  assert.deepEqual(captures, [{ type: 'state', state: 'active', reason: 'capture-started' }]);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].subarray(0, 4).toString(), 'TMI1');
  assert.equal(writes[0].readInt16LE(12), 10_500);

  const remote = { id: 'remote-1', revision: 1, phase: 'final', source: 'remote', speaker: 'remote-group', startMs: 0, endMs: 800, text: '合成リモート発話' };
  transcriptionWorker.stdout.write(outputFrame(remote));
  await new Promise((resolveWait) => setImmediate(resolveWait));
  assert.deepEqual(utterances, [remote]);
  bridge.stop();
  assert.equal(audioWorker.killed, true);
  if (!transcriptionWorker.stdin.writableEnded) await once(transcriptionWorker.stdin, 'finish');
});

test('remote transcription stdin EPIPE degrades only its bridge instead of crashing the companion', () => {
  const audioWorker = new FakeWorker();
  const transcriptionWorker = new FakeWorker();
  const failures = [];
  attachTeamsAudioBridge({
    audioWorker, transcriptionWorker, frameForWorker,
    parseWorkerEvents: () => [], onCaptureState: () => undefined, onUtterance: () => undefined,
    onFailure: (reason) => failures.push(reason),
  });
  transcriptionWorker.stdin.emit('error', new Error('synthetic-epipe'));
  assert.deepEqual(failures, ['remote-transcription-input-failed']);
  assert.equal(audioWorker.killed, true);
  assert.equal(transcriptionWorker.killed, true);
});

test('authenticated companion exposes only typed Teams audio events to the browser', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'techmap-teams-audio-test-'));
  const modelPath = join(root, 'TechMapLive', 'models', 'ggml-tiny.bin');
  const workerPath = join(root, 'transcriber.exe');
  const audioWorkerPath = join(root, 'techmap-audio.exe');
  await mkdir(join(root, 'TechMapLive', 'models'), { recursive: true });
  await Promise.all([writeFile(modelPath, 'synthetic'), writeFile(workerPath, 'synthetic'), writeFile(audioWorkerPath, 'synthetic')]);
  const launchSecret = 'b'.repeat(64);
  const captureWorker = new FakeWorker();
  const transcriptionWorker = new FakeWorker();
  const probeReport = {
    windowsBuild: 26_100, minimumBuild: 20_348, supportedBuild: true, teamsProcessCount: 1,
    selectedProcessId: 4242, targetFound: true, activationAttempted: true, activationSucceeded: true,
    activationHresult: '0x00000000',
  };
  const spawnAudioWorker = (args) => {
    if (args[0] === 'probe') {
      const worker = new FakeWorker();
      setImmediate(() => { worker.stdout.end(`${JSON.stringify(probeReport)}\n`); worker.emit('exit', 0); });
      return worker;
    }
    assert.deepEqual(args, ['capture', '--pid', '4242', '--consent-confirmed']);
    return captureWorker;
  };
  const server = createCompanionServer({
    environment: { LOCALAPPDATA: root }, modelPath, workerPath, audioWorkerPath, launchSecret,
    spawnAudioWorker, spawnWorker: (args) => {
      assert.deepEqual(args, ['--model', modelPath, '--source', 'remote', '--language', 'ja']);
      return transcriptionWorker;
    },
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

  const probe = await fetch(`${base}/v1/teams-audio/probe`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ consentConfirmed: true }),
  });
  assert.deepEqual(await probe.json(), probeReport);
  const started = await fetch(`${base}/v1/teams-audio-sessions`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ consentConfirmed: true, processId: 4242 }),
  });
  assert.equal(started.status, 201);
  const { sessionId } = await started.json();

  const format = frame(3, JSON.stringify({ sampleRate: 48_000, channels: 2, bitsPerSample: 16, encoding: 'pcm-s16le' }));
  const active = frame(1, JSON.stringify({ state: 'active', reason: 'capture-started' }));
  const pcm = new Uint8Array(12);
  new DataView(pcm.buffer).setInt16(0, 1200, true);
  captureWorker.stdout.write(Buffer.concat([format, active, frame(2, pcm)]));
  const remote = { id: 'remote-3', revision: 1, phase: 'final', source: 'remote', speaker: 'remote-group', startMs: 0, endMs: 700, text: '合成endpoint発話' };
  transcriptionWorker.stdout.write(outputFrame(remote));
  await new Promise((resolveWait) => setImmediate(resolveWait));

  const eventsResponse = await fetch(`${base}/v1/teams-audio-sessions/${sessionId}/events?after=0`, { headers });
  const events = await eventsResponse.json();
  assert.deepEqual(events.events, [
    { type: 'capture-state', state: 'active', reason: 'capture-started' },
    { type: 'utterance', utterance: remote },
  ]);
  assert.equal(JSON.stringify(events).includes('pcm'), false);
  assert.equal(JSON.stringify(events).includes('displayName'), false);

  const stopped = await fetch(`${base}/v1/teams-audio-sessions/${sessionId}/stop`, { method: 'POST', headers });
  assert.equal(stopped.status, 200);
  assert.equal(captureWorker.killed, true);
});

test('native helper has no file persistence or system-wide fallback path', async () => {
  const testDirectory = fileURLToPath(new URL('.', import.meta.url));
  const sourcePath = resolve(testDirectory, '..', '..', 'native', 'windows-audio', 'src', 'main.cpp');
  const source = await readFile(sourcePath, 'utf8');

  assert.match(source, /PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE/);
  assert.doesNotMatch(source, /PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE/);
  assert.doesNotMatch(source, /CreateFile[AW]?\s*\(/);
  assert.doesNotMatch(source, /std::ofstream|fopen\s*\(/);
  assert.match(source, /--consent-confirmed/);
  assert.match(source, /AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY/);
  assert.match(source, /"data-discontinuity"/);
  assert.ok(
    source.indexOf('captureClient->ReleaseBuffer') < source.indexOf('WriteFrame(FrameType::Pcm'),
    'WASAPI buffer must be released before IPC backpressure can block',
  );
});
