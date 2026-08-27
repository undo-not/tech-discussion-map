import { consumeLocalLaunchSecret } from '../companion/launch-secret.ts';
import { parseCaptionRuntimeEvent, type CaptionRuntimeEvent } from './teams-caption-frames.ts';

const captionCompanionOrigin = 'http://127.0.0.1:43117';

function captionCompanionUrl(path: string): URL {
  const url = new URL(path, captionCompanionOrigin);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port !== '43117') throw new Error('Caption endpoint must remain loopback-only');
  return url;
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(`caption-engine-${response.status}`);
  return response.json();
}

export class LocalCaptionClient {
  readonly #onEvent: (event: CaptionRuntimeEvent) => void;
  #token = '';
  #sessionId = '';
  #cursor = 0;
  #closed = false;
  #paused = false;
  #controlPending = false;

  constructor(onEvent: (event: CaptionRuntimeEvent) => void) { this.#onEvent = onEvent; }

  onFailure: (reason: string) => void = () => undefined;

  async start(): Promise<void> {
    const bootstrap = await readJson(await fetch(captionCompanionUrl('/v1/bootstrap'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ launchSecret: consumeLocalLaunchSecret() }), cache: 'no-store', credentials: 'omit',
    })) as { token?: unknown };
    if (typeof bootstrap.token !== 'string' || !/^[a-f0-9]{64}$/.test(bootstrap.token)) throw new Error('caption-engine-invalid-bootstrap');
    this.#token = bootstrap.token;
    const started = await readJson(await this.#request('/v1/caption-sessions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ consentConfirmed: true }),
    })) as { sessionId?: unknown };
    if (typeof started.sessionId !== 'string' || !/^[a-f0-9-]{36}$/.test(started.sessionId)) throw new Error('caption-engine-invalid-session');
    this.#sessionId = started.sessionId;
    void this.#poll();
  }

  async pause(): Promise<void> {
    if (this.#closed || this.#paused || this.#controlPending) return;
    this.#controlPending = true;
    try {
      await this.#control('pause');
      this.#paused = true;
    } finally {
      this.#controlPending = false;
    }
  }

  async resume(): Promise<void> {
    if (this.#closed || !this.#paused || this.#controlPending) return;
    this.#controlPending = true;
    try {
      await this.#control('resume');
      this.#paused = false;
    } finally {
      this.#controlPending = false;
    }
  }

  async stop(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#sessionId) await this.#control('stop');
  }

  async #control(action: 'pause' | 'resume' | 'stop'): Promise<void> {
    if (!this.#sessionId) return;
    const response = await this.#request(`/v1/caption-sessions/${this.#sessionId}/${action}`, { method: 'POST' });
    if (!response.ok) throw new Error(`caption-engine-${response.status}`);
  }

  async #poll(): Promise<void> {
    while (!this.#closed) {
      if (this.#paused) { await new Promise((resolve) => setTimeout(resolve, 100)); continue; }
      try {
        const value = await readJson(await this.#request(`/v1/caption-sessions/${this.#sessionId}/events?after=${this.#cursor}`, {
          method: 'GET', cache: 'no-store',
        })) as { cursor?: unknown; events?: unknown; stopped?: unknown; paused?: unknown };
        if (!Number.isSafeInteger(value.cursor) || !Array.isArray(value.events) || typeof value.stopped !== 'boolean' || typeof value.paused !== 'boolean') {
          throw new Error('caption-engine-invalid-events');
        }
        for (const event of value.events) this.#onEvent(parseCaptionRuntimeEvent(event));
        this.#cursor = value.cursor as number;
        this.#paused = value.paused;
        if (value.stopped && !this.#closed) this.#fail('caption-engine-stopped');
      } catch (error) {
        this.#fail(error instanceof Error ? error.message : 'caption-engine-failed');
      }
    }
  }

  #request(path: string, init: RequestInit): Promise<Response> {
    return fetch(captionCompanionUrl(path), { ...init, credentials: 'omit', headers: { ...init.headers, Authorization: `Bearer ${this.#token}` } });
  }

  #fail(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#sessionId) void this.#request(`/v1/caption-sessions/${this.#sessionId}/stop`, { method: 'POST' }).catch(() => undefined);
    this.onFailure(reason);
  }
}

export { captionCompanionOrigin, captionCompanionUrl };
