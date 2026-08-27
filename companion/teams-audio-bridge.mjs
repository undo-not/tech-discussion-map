import { downmixAndResample48kStereoTo16kMono } from '../app/adapters/audio/pcm.ts';
import { TeamsProcessAudioProtocolParser } from '../app/adapters/teams-process-audio-protocol.ts';
import { parseTranscriptUtterance } from '../app/domain/transcription/utterance.ts';

const maximumProbeBytes = 4 * 1024;
const probeTimeoutMs = 12_000;

function exactKeys(value, expected) {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

export function parseTeamsAudioProbeReport(value) {
  const keys = [
    'activationAttempted', 'activationHresult', 'activationSucceeded', 'minimumBuild', 'selectedProcessId',
    'supportedBuild', 'targetFound', 'teamsProcessCount', 'windowsBuild',
  ];
  if (typeof value !== 'object' || value === null || !exactKeys(value, keys) ||
      !Number.isSafeInteger(value.windowsBuild) || value.windowsBuild < 0 ||
      !Number.isSafeInteger(value.minimumBuild) || value.minimumBuild < 20_348 ||
      typeof value.supportedBuild !== 'boolean' ||
      !Number.isSafeInteger(value.teamsProcessCount) || value.teamsProcessCount < 0 || value.teamsProcessCount > 128 ||
      !Number.isSafeInteger(value.selectedProcessId) || value.selectedProcessId < 0 || value.selectedProcessId > 0xffff_ffff ||
      typeof value.targetFound !== 'boolean' || typeof value.activationAttempted !== 'boolean' ||
      typeof value.activationSucceeded !== 'boolean' ||
      typeof value.activationHresult !== 'string' || !/^0x[A-F0-9]{8}$/.test(value.activationHresult)) {
    throw new Error('invalid-teams-audio-probe-report');
  }
  if (value.targetFound !== (value.selectedProcessId > 0) || value.activationSucceeded && !value.activationAttempted) {
    throw new Error('inconsistent-teams-audio-probe-report');
  }
  return structuredClone(value);
}

export function runTeamsAudioProbe(spawnAudioWorker, timeout = probeTimeoutMs) {
  return new Promise((resolve, reject) => {
    const worker = spawnAudioWorker(['probe', '--activate']);
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (error, report) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const chunk of chunks) chunk.fill(0);
      if (error) reject(error);
      else resolve(report);
    };
    const timer = setTimeout(() => {
      if (!worker.killed) worker.kill();
      finish(new Error('teams-audio-probe-timeout'));
    }, timeout);
    timer.unref?.();
    worker.stdout.on('data', (chunk) => {
      const owned = Buffer.from(chunk);
      chunk.fill(0);
      size += owned.length;
      if (size > maximumProbeBytes) {
        owned.fill(0);
        if (!worker.killed) worker.kill();
        finish(new Error('teams-audio-probe-too-large'));
        return;
      }
      chunks.push(owned);
    });
    worker.on('error', () => finish(new Error('teams-audio-probe-unavailable')));
    worker.on('exit', () => {
      if (settled) return;
      const body = Buffer.concat(chunks);
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(body).trim();
        body.fill(0);
        finish(null, parseTeamsAudioProbeReport(JSON.parse(text)));
      } catch {
        body.fill(0);
        finish(new Error('invalid-teams-audio-probe-output'));
      }
    });
  });
}

export function attachTeamsAudioBridge(options) {
  const {
    audioWorker,
    transcriptionWorker,
    frameForWorker,
    parseWorkerEvents,
    onCaptureState,
    onUtterance,
    onFailure,
  } = options;
  const audioParser = new TeamsProcessAudioProtocolParser();
  const transcriptParser = { buffer: Buffer.alloc(0) };
  let carry = Buffer.alloc(0);
  let formatConfirmed = false;
  let stopped = false;
  let failed = false;

  const clearBuffers = () => {
    audioParser.clear();
    carry.fill(0);
    carry = Buffer.alloc(0);
    transcriptParser.buffer.fill(0);
    transcriptParser.buffer = Buffer.alloc(0);
  };
  const fail = (reason) => {
    if (stopped || failed) return;
    failed = true;
    clearBuffers();
    if (!audioWorker.killed) audioWorker.kill();
    if (!transcriptionWorker.killed) transcriptionWorker.kill();
    onFailure(reason);
  };
  const writeRemotePcm = (bytes) => {
    const combined = Buffer.concat([carry, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)]);
    carry.fill(0);
    bytes.fill(0);
    const processBytes = combined.length - (combined.length % 12);
    if (processBytes === 0) {
      carry = Buffer.from(combined);
      combined.fill(0);
      return;
    }
    carry = Buffer.from(combined.subarray(processBytes));
    let downmixed;
    try {
      downmixed = downmixAndResample48kStereoTo16kMono(
        new Uint8Array(combined.buffer, combined.byteOffset, processBytes),
      );
    } finally {
      combined.fill(0);
    }
    const framed = frameForWorker(1, Buffer.from(downmixed));
    downmixed.fill(0);
    const accepted = transcriptionWorker.stdin.write(framed, () => framed.fill(0));
    if (!accepted && typeof audioWorker.stdout.pause === 'function') {
      audioWorker.stdout.pause();
      transcriptionWorker.stdin.once('drain', () => {
        if (!stopped && !failed && typeof audioWorker.stdout.resume === 'function') audioWorker.stdout.resume();
      });
    }
  };

  audioWorker.stdout.on('data', (chunk) => {
    if (stopped || failed) { chunk.fill(0); return; }
    try {
      const frames = audioParser.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      chunk.fill(0);
      for (const frame of frames) {
        if (frame.type === 'format') {
          formatConfirmed = true;
        } else if (frame.type === 'state') {
          onCaptureState(frame);
        } else {
          if (!formatConfirmed) { frame.bytes.fill(0); throw new Error('remote-audio-format-required'); }
          writeRemotePcm(frame.bytes);
        }
      }
    } catch {
      chunk.fill(0);
      fail('remote-audio-protocol-failed');
    }
  });
  transcriptionWorker.stdout.on('data', (chunk) => {
    if (stopped || failed) { chunk.fill(0); return; }
    try {
      for (const event of parseWorkerEvents(transcriptParser, chunk)) onUtterance(parseTranscriptUtterance(event));
    } catch {
      fail('remote-transcription-protocol-failed');
    } finally {
      chunk.fill(0);
    }
  });
  audioWorker.on('error', () => fail('remote-audio-worker-failed'));
  audioWorker.on('exit', () => { if (!stopped) fail('remote-audio-worker-exited'); });
  transcriptionWorker.on('error', () => fail('remote-transcription-worker-failed'));
  transcriptionWorker.on('exit', () => { if (!stopped) fail('remote-transcription-worker-exited'); });
  transcriptionWorker.stdin.on('error', () => fail('remote-transcription-input-failed'));

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearBuffers();
      if (!audioWorker.killed) audioWorker.kill();
      if (!transcriptionWorker.killed) {
        const stopFrame = frameForWorker(2);
        transcriptionWorker.stdin.end(stopFrame, () => stopFrame.fill(0));
        setTimeout(() => { if (!transcriptionWorker.killed) transcriptionWorker.kill(); }, 3_000).unref?.();
      }
    },
  };
}

export { maximumProbeBytes, probeTimeoutMs };
