import { isCaptureState, type CaptureState } from '../domain/audio/capture.ts';

const headerSize = 12;
const maximumPayloadSize = 1024 * 1024;
const expectedMagic = [0x54, 0x4d, 0x41, 0x31] as const;

export type TeamsAudioFrame =
  | { type: 'state'; state: CaptureState; reason: string }
  | { type: 'pcm'; bytes: Uint8Array }
  | { type: 'format'; sampleRate: number; channels: number; bitsPerSample: number; encoding: 'pcm-s16le' };

function appendBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const combined = new Uint8Array(left.byteLength + right.byteLength);
  combined.set(left);
  combined.set(right, left.byteLength);
  return combined;
}

function parseJson(payload: Uint8Array): unknown {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
}

function parseState(payload: Uint8Array): TeamsAudioFrame {
  const value = parseJson(payload);
  if (
    typeof value !== 'object' ||
    value === null ||
    !('state' in value) ||
    !isCaptureState(value.state) ||
    !('reason' in value) ||
    typeof value.reason !== 'string' ||
    !/^[a-z0-9-]{1,64}$/.test(value.reason)
  ) {
    throw new Error('Invalid Teams audio state frame');
  }
  return { type: 'state', state: value.state, reason: value.reason };
}

function parseFormat(payload: Uint8Array): TeamsAudioFrame {
  const value = parseJson(payload);
  if (
    typeof value !== 'object' ||
    value === null ||
    !('sampleRate' in value) ||
    value.sampleRate !== 48_000 ||
    !('channels' in value) ||
    value.channels !== 2 ||
    !('bitsPerSample' in value) ||
    value.bitsPerSample !== 16 ||
    !('encoding' in value) ||
    value.encoding !== 'pcm-s16le'
  ) {
    throw new Error('Invalid Teams audio format frame');
  }
  return {
    type: 'format',
    sampleRate: value.sampleRate,
    channels: value.channels,
    bitsPerSample: value.bitsPerSample,
    encoding: value.encoding,
  };
}

export class TeamsProcessAudioProtocolParser {
  #buffer: Uint8Array<ArrayBufferLike> = new Uint8Array();

  push(chunk: Uint8Array): TeamsAudioFrame[] {
    if (chunk.byteLength > maximumPayloadSize + headerSize) {
      throw new Error('Teams audio IPC chunk exceeds the memory boundary');
    }
    this.#buffer = appendBytes(this.#buffer, chunk);
    const frames: TeamsAudioFrame[] = [];

    while (this.#buffer.byteLength >= headerSize) {
      for (let index = 0; index < expectedMagic.length; index += 1) {
        if (this.#buffer[index] !== expectedMagic[index]) throw new Error('Invalid Teams audio protocol magic');
      }
      if (this.#buffer[4] !== 1) throw new Error('Unsupported Teams audio protocol version');
      if (this.#buffer[6] !== 0 || this.#buffer[7] !== 0) throw new Error('Invalid Teams audio reserved bytes');

      const frameType = this.#buffer[5];
      const view = new DataView(this.#buffer.buffer, this.#buffer.byteOffset, this.#buffer.byteLength);
      const payloadSize = view.getUint32(8, true);
      if (payloadSize > maximumPayloadSize) throw new Error('Teams audio frame exceeds the memory boundary');
      if (this.#buffer.byteLength < headerSize + payloadSize) break;

      const payload = this.#buffer.slice(headerSize, headerSize + payloadSize);
      this.#buffer = this.#buffer.slice(headerSize + payloadSize);

      if (frameType === 1) frames.push(parseState(payload));
      else if (frameType === 2) {
        if (payload.byteLength === 0 || payload.byteLength % 4 !== 0) throw new Error('Invalid Teams PCM frame size');
        frames.push({ type: 'pcm', bytes: payload });
      }
      else if (frameType === 3) frames.push(parseFormat(payload));
      else throw new Error('Unknown Teams audio frame type');
    }

    return frames;
  }
}
