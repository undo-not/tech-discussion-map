import { getLocalLaunchSecret } from '../companion/launch-secret.ts';
import { parseTranscriptUtterance, type TranscriptUtterance } from '../../domain/transcription/utterance.ts';

const zoomCompanionOrigin = 'http://127.0.0.1:43117';
const zoomStates = ['waiting', 'awaiting-confirmation', 'connecting', 'active', 'paused', 'degraded', 'stopped'] as const;
const zoomReasons = [
  'signed-stream-announced', 'transcript-stream-active', 'user-paused', 'user-resumed', 'user-stopped',
  'zoom-stream-stopped', 'invalid-rtms-message', 'rtms-connection-failed', 'rtms-connection-closed',
  'rtms-signaling-handshake-failed', 'rtms-signaling-handshake-rejected', 'rtms-media-connection-failed',
  'rtms-media-handshake-failed', 'rtms-media-handshake-rejected', 'event-buffer-overflow',
  'zoom-stream-interrupted', 'rtms-reconnect-failed', 'arm-expired',
  'signed-stream-awaiting-confirmation', 'stream-confirmation-expired', 'ambiguous-start-events',
] as const;

export type ZoomRtmsState = (typeof zoomStates)[number];
export type ZoomRtmsEvent =
  | { type: 'state'; state: ZoomRtmsState; reason: (typeof zoomReasons)[number] }
  | { type: 'utterance'; utterance: TranscriptUtterance };

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function zoomCompanionUrl(path: string): URL {
  const url = new URL(path, zoomCompanionOrigin);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port !== '43117') throw new Error('Zoom RTMS endpoint must remain loopback-only');
  return url;
}

function parseZoomRtmsEvent(value: unknown): ZoomRtmsEvent {
  if (typeof value !== 'object' || value === null) throw new Error('invalid-zoom-rtms-event');
  const event = value as Record<string, unknown>;
  if (event.type === 'state') {
    if (!exactKeys(event, ['reason', 'state', 'type']) || !zoomStates.includes(event.state as ZoomRtmsState) || !zoomReasons.includes(event.reason as (typeof zoomReasons)[number])) {
      throw new Error('invalid-zoom-rtms-state');
    }
    return event as ZoomRtmsEvent;
  }
  if (event.type === 'utterance' && exactKeys(event, ['type', 'utterance'])) {
    const utterance = parseTranscriptUtterance(event.utterance);
    if (utterance.source !== 'zoom-rtms' || utterance.phase !== 'final' || utterance.speaker !== 'displayed-alias' || !utterance.speakerAlias) {
      throw new Error('invalid-zoom-rtms-utterance');
    }
    return { type: 'utterance', utterance };
  }
  throw new Error('invalid-zoom-rtms-event');
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(`zoom-rtms-${response.status}`);
  return response.json();
}

export class LocalZoomRtmsClient {
  readonly #onEvent: (event: ZoomRtmsEvent) => void;
  #token = '';
  #sessionId = '';
  #cursor = 0;
  #closed = false;
  #paused = false;
  #connecting: Promise<void> | null = null;

  constructor(onEvent: (event: ZoomRtmsEvent) => void) { this.#onEvent = onEvent; }

  onFailure: (reason: string) => void = () => undefined;

  async status(): Promise<{ configured: boolean; webhookPath: '/zoom/webhook'; webhookPort: 43118 }> {
    await this.#connect();
    const value = await readJson(await this.#request('/v1/zoom-rtms/status', { method: 'GET', cache: 'no-store' })) as Record<string, unknown>;
    if (!exactKeys(value, ['configured', 'webhookPath', 'webhookPort']) || typeof value.configured !== 'boolean' ||
        value.webhookPath !== '/zoom/webhook' || value.webhookPort !== 43118) {
      throw new Error('invalid-zoom-rtms-status');
    }
    return value as { configured: boolean; webhookPath: '/zoom/webhook'; webhookPort: 43118 };
  }

  async start(): Promise<void> {
    await this.#connect();
    const started = await readJson(await this.#request('/v1/zoom-rtms-sessions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ consentConfirmed: true }),
    })) as Record<string, unknown>;
    if (!exactKeys(started, ['sessionId', 'state']) || typeof started.sessionId !== 'string' || !/^[a-f0-9-]{36}$/.test(started.sessionId) || started.state !== 'waiting') {
      throw new Error('invalid-zoom-rtms-session');
    }
    this.#sessionId = started.sessionId;
    void this.#poll();
  }

  async pause(): Promise<void> {
    if (this.#closed || this.#paused) return;
    await this.#control('pause');
    this.#paused = true;
  }

  async confirm(): Promise<void> {
    if (this.#closed || this.#paused) return;
    await this.#control('confirm');
  }

  async resume(): Promise<void> {
    if (this.#closed || !this.#paused) return;
    await this.#control('resume');
    this.#paused = false;
  }

  async stop(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#sessionId) await this.#control('stop');
  }

  async #control(action: 'confirm' | 'pause' | 'resume' | 'stop'): Promise<void> {
    if (!this.#sessionId) return;
    const response = await this.#request(`/v1/zoom-rtms-sessions/${this.#sessionId}/${action}`, { method: 'POST' });
    if (!response.ok) throw new Error(`zoom-rtms-${response.status}`);
  }

  async #connect(): Promise<void> {
    if (this.#token) return;
    if (!this.#connecting) this.#connecting = (async () => {
      const bootstrap = await readJson(await fetch(zoomCompanionUrl('/v1/bootstrap'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ launchSecret: await getLocalLaunchSecret() }), cache: 'no-store', credentials: 'omit',
      })) as Record<string, unknown>;
      if (!exactKeys(bootstrap, ['token']) || typeof bootstrap.token !== 'string' || !/^[a-f0-9]{64}$/.test(bootstrap.token)) throw new Error('invalid-zoom-rtms-bootstrap');
      this.#token = bootstrap.token;
    })().finally(() => { this.#connecting = null; });
    await this.#connecting;
  }

  async #poll(): Promise<void> {
    while (!this.#closed) {
      try {
        const value = await readJson(await this.#request(`/v1/zoom-rtms-sessions/${this.#sessionId}/events?after=${this.#cursor}`, {
          method: 'GET', cache: 'no-store',
        })) as Record<string, unknown>;
        if (this.#closed) return;
        if (!exactKeys(value, ['cursor', 'events', 'state', 'stopped']) || !Number.isSafeInteger(value.cursor) || !Array.isArray(value.events) ||
            !zoomStates.includes(value.state as ZoomRtmsState) || typeof value.stopped !== 'boolean') throw new Error('invalid-zoom-rtms-events');
        for (const event of value.events) {
          if (this.#closed) return;
          this.#onEvent(parseZoomRtmsEvent(event));
        }
        this.#cursor = value.cursor as number;
        this.#paused = value.state === 'paused';
        if (value.stopped && !this.#closed) this.#fail('zoom-rtms-stopped');
      } catch (error) {
        this.#fail(error instanceof Error ? error.message : 'zoom-rtms-failed');
      }
    }
  }

  async #request(path: string, init: RequestInit): Promise<Response> {
    let response = await fetch(zoomCompanionUrl(path), { ...init, credentials: 'omit', headers: { ...init.headers, Authorization: `Bearer ${this.#token}` } });
    if (response.status === 401) {
      this.#token = '';
      await this.#connect();
      response = await fetch(zoomCompanionUrl(path), { ...init, credentials: 'omit', headers: { ...init.headers, Authorization: `Bearer ${this.#token}` } });
    }
    return response;
  }

  #fail(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#sessionId) void this.#request(`/v1/zoom-rtms-sessions/${this.#sessionId}/stop`, { method: 'POST' }).catch(() => undefined);
    this.onFailure(reason);
  }
}

export { parseZoomRtmsEvent, zoomCompanionOrigin, zoomCompanionUrl };
