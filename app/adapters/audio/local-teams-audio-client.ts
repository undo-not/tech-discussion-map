import { isCaptureState, type CaptureState } from '../../domain/audio/capture.ts';
import { parseTranscriptUtterance, type TranscriptUtterance } from '../../domain/transcription/utterance.ts';
import { getLocalLaunchSecret } from '../companion/launch-secret.ts';

const teamsAudioCompanionOrigin = 'http://127.0.0.1:43117';

export type TeamsAudioProbeReport = {
  windowsBuild: number;
  minimumBuild: number;
  supportedBuild: boolean;
  teamsProcessCount: number;
  selectedProcessId: number;
  targetFound: boolean;
  activationAttempted: boolean;
  activationSucceeded: boolean;
  activationHresult: string;
};

export type TeamsAudioClientEvent =
  | { type: 'capture-state'; state: CaptureState; reason: string }
  | { type: 'utterance'; utterance: TranscriptUtterance };

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

export function parseTeamsAudioProbeResponse(value: unknown): TeamsAudioProbeReport {
  const keys = [
    'activationAttempted', 'activationHresult', 'activationSucceeded', 'minimumBuild', 'selectedProcessId',
    'supportedBuild', 'targetFound', 'teamsProcessCount', 'windowsBuild',
  ];
  if (typeof value !== 'object' || value === null || !exactKeys(value as Record<string, unknown>, keys)) throw new Error('invalid-teams-audio-probe');
  const report = value as Record<string, unknown>;
  if (!Number.isSafeInteger(report.windowsBuild) || (report.windowsBuild as number) < 0 ||
      !Number.isSafeInteger(report.minimumBuild) || (report.minimumBuild as number) < 20_348 ||
      typeof report.supportedBuild !== 'boolean' || !Number.isSafeInteger(report.teamsProcessCount) ||
      (report.teamsProcessCount as number) < 0 || (report.teamsProcessCount as number) > 128 ||
      !Number.isSafeInteger(report.selectedProcessId) || (report.selectedProcessId as number) < 0 || (report.selectedProcessId as number) > 0xffff_ffff ||
      typeof report.targetFound !== 'boolean' || typeof report.activationAttempted !== 'boolean' ||
      typeof report.activationSucceeded !== 'boolean' || typeof report.activationHresult !== 'string' ||
      !/^0x[A-F0-9]{8}$/.test(report.activationHresult)) throw new Error('invalid-teams-audio-probe');
  if (report.targetFound !== ((report.selectedProcessId as number) > 0) || report.activationSucceeded && !report.activationAttempted) {
    throw new Error('inconsistent-teams-audio-probe');
  }
  return structuredClone(report) as TeamsAudioProbeReport;
}

export function parseTeamsAudioClientEvent(value: unknown): TeamsAudioClientEvent {
  if (typeof value !== 'object' || value === null || typeof (value as { type?: unknown }).type !== 'string') throw new Error('invalid-teams-audio-event');
  const event = value as Record<string, unknown>;
  if (event.type === 'capture-state') {
    if (!exactKeys(event, ['reason', 'state', 'type']) || !isCaptureState(event.state) || typeof event.reason !== 'string' || !/^[a-z0-9-]{1,64}$/.test(event.reason)) {
      throw new Error('invalid-teams-audio-state');
    }
    return { type: 'capture-state', state: event.state, reason: event.reason };
  }
  if (event.type === 'utterance' && exactKeys(event, ['type', 'utterance'])) {
    const utterance = parseTranscriptUtterance(event.utterance);
    if (utterance.source !== 'remote' || utterance.speaker !== 'remote-group') throw new Error('invalid-remote-utterance');
    return { type: 'utterance', utterance };
  }
  throw new Error('invalid-teams-audio-event');
}

export function teamsAudioCompanionUrl(path: string): URL {
  const url = new URL(path, teamsAudioCompanionOrigin);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port !== '43117') throw new Error('Teams audio endpoint must remain loopback-only');
  return url;
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(`teams-audio-${response.status}`);
  return response.json();
}

export class LocalTeamsAudioClient {
  readonly #onEvent: (event: TeamsAudioClientEvent) => void;
  #token = '';
  #sessionId = '';
  #cursor = 0;
  #closed = false;
  #polling = false;
  #connecting: Promise<void> | null = null;

  constructor(onEvent: (event: TeamsAudioClientEvent) => void) { this.#onEvent = onEvent; }

  onFailure: (reason: string) => void = () => undefined;

  async #connect(): Promise<void> {
    if (this.#token) return;
    if (!this.#connecting) this.#connecting = (async () => {
      const value = await readJson(await fetch(teamsAudioCompanionUrl('/v1/bootstrap'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ launchSecret: await getLocalLaunchSecret() }), cache: 'no-store', credentials: 'omit',
      })) as { token?: unknown };
      if (typeof value.token !== 'string' || !/^[a-f0-9]{64}$/.test(value.token)) throw new Error('teams-audio-invalid-bootstrap');
      this.#token = value.token;
    })().finally(() => { this.#connecting = null; });
    await this.#connecting;
  }

  async probe(): Promise<TeamsAudioProbeReport> {
    await this.#connect();
    return parseTeamsAudioProbeResponse(await readJson(await this.#request('/v1/teams-audio/probe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ consentConfirmed: true }),
    })));
  }

  async start(processId: number): Promise<void> {
    await this.#connect();
    const value = await readJson(await this.#request('/v1/teams-audio-sessions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ consentConfirmed: true, processId }),
    })) as { sessionId?: unknown };
    if (typeof value.sessionId !== 'string' || !/^[a-f0-9-]{36}$/.test(value.sessionId)) throw new Error('teams-audio-invalid-session');
    this.#sessionId = value.sessionId;
  }

  listen(): void {
    if (this.#closed || !this.#sessionId || this.#polling) return;
    this.#polling = true;
    void this.#poll();
  }

  async stop(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try { if (this.#sessionId) await this.#control('stop'); }
    finally { this.#token = ''; this.#sessionId = ''; }
  }

  async #control(action: 'stop'): Promise<void> {
    const response = await this.#request(`/v1/teams-audio-sessions/${this.#sessionId}/${action}`, { method: 'POST' });
    if (!response.ok) throw new Error(`teams-audio-${response.status}`);
  }

  async #poll(): Promise<void> {
    while (!this.#closed) {
      try {
        const value = await readJson(await this.#request(`/v1/teams-audio-sessions/${this.#sessionId}/events?after=${this.#cursor}`, {
          method: 'GET', cache: 'no-store',
        })) as { cursor?: unknown; events?: unknown; stopped?: unknown };
        if (this.#closed) return;
        if (!Number.isSafeInteger(value.cursor) || !Array.isArray(value.events) || typeof value.stopped !== 'boolean') throw new Error('teams-audio-invalid-events');
        for (const event of value.events) {
          if (this.#closed) return;
          this.#onEvent(parseTeamsAudioClientEvent(event));
        }
        this.#cursor = value.cursor as number;
        if (value.stopped && !this.#closed) this.#fail('teams-audio-stopped');
      } catch (error) {
        this.#fail(error instanceof Error ? error.message : 'teams-audio-failed');
      }
    }
  }

  async #request(path: string, init: RequestInit): Promise<Response> {
    let response = await fetch(teamsAudioCompanionUrl(path), {
      ...init, credentials: 'omit', headers: { ...init.headers, Authorization: `Bearer ${this.#token}` },
    });
    if (response.status === 401) {
      this.#token = '';
      await this.#connect();
      response = await fetch(teamsAudioCompanionUrl(path), {
        ...init, credentials: 'omit', headers: { ...init.headers, Authorization: `Bearer ${this.#token}` },
      });
    }
    return response;
  }

  #fail(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#sessionId) void this.#request(`/v1/teams-audio-sessions/${this.#sessionId}/stop`, { method: 'POST' }).catch(() => undefined);
    this.#token = '';
    this.#sessionId = '';
    this.onFailure(reason);
  }
}

export { teamsAudioCompanionOrigin };
