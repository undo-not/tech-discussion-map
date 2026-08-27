import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { transitionCaptureState } from '../domain/audio/capture.ts';
import { TeamsProcessAudioProtocolParser } from '../adapters/teams-process-audio-protocol.ts';

function frame(type, payload) {
  const body = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
  const result = new Uint8Array(12 + body.byteLength);
  result.set([0x54, 0x4d, 0x41, 0x31, 1, type, 0, 0]);
  new DataView(result.buffer).setUint32(8, body.byteLength, true);
  result.set(body, 12);
  return result;
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

  const unalignedPcm = frame(2, new Uint8Array([1, 2, 3]));
  assert.throws(() => new TeamsProcessAudioProtocolParser().push(unalignedPcm), /Invalid Teams PCM frame size/);
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
});
