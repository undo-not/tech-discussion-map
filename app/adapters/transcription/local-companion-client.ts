import { parseTranscriptUtterance, type TranscriptUtterance, type UtteranceSource } from '../../domain/transcription/utterance.ts';
import { getLocalLaunchSecret } from '../companion/launch-secret.ts';

const companionOrigin = 'http://127.0.0.1:43117';
const maximumAudioChunkBytes = 128 * 1024;
const maximumQueuedAudioBytes = 512 * 1024;

function companionUrl(path: string): URL {
  const url = new URL(path, companionOrigin);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port !== '43117') {
    throw new Error('Local transcription endpoint must remain loopback-only');
  }
  return url;
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(`local-engine-${response.status}`);
  return response.json();
}

export class LocalCompanionTranscriptionClient {
  readonly #source: UtteranceSource;
  readonly #onUtterance: (utterance: TranscriptUtterance) => void;
  #token = '';
  #sessionId = '';
  #cursor = 0;
  #closed = false;
  #queuedAudioBytes = 0;
  #sendChain: Promise<void> = Promise.resolve();
  #connecting: Promise<void> | null = null;

  constructor(source: UtteranceSource, onUtterance: (utterance: TranscriptUtterance) => void) {
    this.#source = source;
    this.#onUtterance = onUtterance;
  }

  onFailure: (reason: string) => void = () => undefined;

  async start(): Promise<void> {
    await this.#connect();
    const started = await readJson(await this.#request('/v1/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: this.#source, sampleRate: 16_000, channels: 1, encoding: 'pcm-s16le' }),
    })) as { sessionId?: unknown };
    if (typeof started.sessionId !== 'string' || !/^[a-f0-9-]{36}$/.test(started.sessionId)) {
      throw new Error('local-engine-invalid-session');
    }
    this.#sessionId = started.sessionId;
    void this.#poll();
  }

  sendPcm(samples: Int16Array): Promise<void> {
    if (this.#closed || !this.#sessionId) return Promise.resolve();
    const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
    if (bytes.byteLength === 0 || bytes.byteLength > maximumAudioChunkBytes) {
      return Promise.reject(new Error('audio-chunk-out-of-bounds'));
    }
    const owned = bytes.slice();
    if (this.#queuedAudioBytes + owned.byteLength > maximumQueuedAudioBytes) {
      this.#fail('audio-backpressure');
      return Promise.reject(new Error('audio-backpressure'));
    }
    this.#queuedAudioBytes += owned.byteLength;
    const operation = this.#sendChain.then(async () => {
      const response = await this.#request(`/v1/sessions/${this.#sessionId}/audio`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: owned,
      });
      if (!response.ok) throw new Error(`local-engine-${response.status}`);
    }).finally(() => { this.#queuedAudioBytes -= owned.byteLength; });
    this.#sendChain = operation.catch((error) => { this.#fail(error instanceof Error ? error.message : 'local-engine-failed'); });
    return operation;
  }

  async pause(): Promise<void> { await this.#control('pause'); }
  async resume(): Promise<void> { await this.#control('resume'); }

  async stop(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#sendChain;
    if (this.#sessionId) await this.#control('stop');
  }

  async #control(action: 'pause' | 'resume' | 'stop'): Promise<void> {
    if (!this.#sessionId) return;
    const response = await this.#request(`/v1/sessions/${this.#sessionId}/${action}`, { method: 'POST' });
    if (!response.ok) throw new Error(`local-engine-${response.status}`);
  }

  async #connect(): Promise<void> {
    if (this.#token) return;
    if (!this.#connecting) this.#connecting = (async () => {
      const bootstrap = await readJson(await fetch(companionUrl('/v1/bootstrap'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ launchSecret: await getLocalLaunchSecret() }), cache: 'no-store', credentials: 'omit',
      })) as { token?: unknown };
      if (typeof bootstrap.token !== 'string' || !/^[a-f0-9]{64}$/.test(bootstrap.token)) throw new Error('local-engine-invalid-bootstrap');
      this.#token = bootstrap.token;
    })().finally(() => { this.#connecting = null; });
    await this.#connecting;
  }

  async #poll(): Promise<void> {
    while (!this.#closed) {
      try {
        const response = await this.#request(`/v1/sessions/${this.#sessionId}/events?after=${this.#cursor}`, {
          method: 'GET',
          cache: 'no-store',
        });
        const value = await readJson(response) as { cursor?: unknown; events?: unknown; stopped?: unknown };
        if (this.#closed) return;
        if (!Number.isSafeInteger(value.cursor) || !Array.isArray(value.events) || typeof value.stopped !== 'boolean') throw new Error('local-engine-invalid-events');
        for (const event of value.events) {
          if (this.#closed) return;
          this.#onUtterance(parseTranscriptUtterance(event));
        }
        this.#cursor = value.cursor as number;
        if (value.stopped && !this.#closed) {
          this.#fail('local-engine-stopped');
        }
      } catch (error) {
        this.#fail(error instanceof Error ? error.message : 'local-engine-failed');
      }
    }
  }

  async #request(path: string, init: RequestInit): Promise<Response> {
    let response = await fetch(companionUrl(path), {
      ...init,
      credentials: 'omit',
      headers: { ...init.headers, Authorization: `Bearer ${this.#token}` },
    });
    if (response.status === 401) {
      this.#token = '';
      await this.#connect();
      response = await fetch(companionUrl(path), {
        ...init, credentials: 'omit', headers: { ...init.headers, Authorization: `Bearer ${this.#token}` },
      });
    }
    return response;
  }

  #fail(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#sessionId) void this.#request(`/v1/sessions/${this.#sessionId}/stop`, { method: 'POST' }).catch(() => undefined);
    this.onFailure(reason);
  }
}

export { companionOrigin, companionUrl, maximumAudioChunkBytes, maximumQueuedAudioBytes };
