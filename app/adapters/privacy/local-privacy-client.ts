import type { ConsentRecord } from '../../domain/privacy/consent.ts';
import type { TranscriptUtterance } from '../../domain/transcription/utterance.ts';

const privacyCompanionOrigin = 'http://127.0.0.1:43117';
const sessionIdPattern = /^[a-f0-9-]{36}$/;

export type StoredSession = {
  id: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  retentionDays: 1 | 7 | 30 | 90;
  consent: ConsentRecord;
  transcript: TranscriptUtterance[];
  analysis: unknown[];
  state: Record<string, unknown>;
};

export type StoredSessionMetadata = Pick<StoredSession, 'id' | 'updatedAt' | 'expiresAt'> & { transcriptCount: number; analysisCount: number };

function privacyUrl(path: string): URL {
  const url = new URL(path, privacyCompanionOrigin);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port !== '43117') throw new Error('Privacy endpoint must remain loopback-only');
  return url;
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(`privacy-host-${response.status}`);
  return response.json();
}

export class LocalPrivacyClient {
  #token = '';

  async connect(): Promise<void> {
    const value = await readJson(await fetch(privacyUrl('/v1/bootstrap'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', cache: 'no-store', credentials: 'omit',
    })) as { token?: unknown };
    if (typeof value.token !== 'string' || !/^[a-f0-9]{64}$/.test(value.token)) throw new Error('privacy-invalid-bootstrap');
    this.#token = value.token;
  }

  async status(): Promise<{ secureStore: boolean; credentialConfigured: boolean; location: string }> {
    return readJson(await this.#request('/v1/privacy/status', { method: 'GET', cache: 'no-store' })) as Promise<{ secureStore: boolean; credentialConfigured: boolean; location: string }>;
  }

  async save(session: StoredSession): Promise<void> {
    if (!sessionIdPattern.test(session.id)) throw new Error('privacy-invalid-session-id');
    await readJson(await this.#request(`/v1/privacy/sessions/${session.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(session),
    }));
  }

  async list(): Promise<StoredSessionMetadata[]> {
    const value = await readJson(await this.#request('/v1/privacy/sessions', { method: 'GET', cache: 'no-store' })) as { sessions?: unknown };
    if (!Array.isArray(value.sessions)) throw new Error('privacy-invalid-session-list');
    return value.sessions as StoredSessionMetadata[];
  }

  async load(id: string): Promise<StoredSession> {
    if (!sessionIdPattern.test(id)) throw new Error('privacy-invalid-session-id');
    return readJson(await this.#request(`/v1/privacy/sessions/${id}`, { method: 'GET', cache: 'no-store' })) as Promise<StoredSession>;
  }

  async delete(id: string): Promise<boolean> {
    if (!sessionIdPattern.test(id)) throw new Error('privacy-invalid-session-id');
    const value = await readJson(await this.#request(`/v1/privacy/sessions/${id}`, { method: 'DELETE' })) as { deleted?: unknown };
    return value.deleted === true;
  }

  #request(path: string, init: RequestInit): Promise<Response> {
    if (!this.#token) return Promise.reject(new Error('privacy-client-not-connected'));
    return fetch(privacyUrl(path), { ...init, credentials: 'omit', headers: { ...init.headers, Authorization: `Bearer ${this.#token}` } });
  }
}

type SaveFilePickerWindow = Window & {
  showSaveFilePicker?: (options: { suggestedName: string; types: Array<{ description: string; accept: Record<string, string[]> }> }) => Promise<{ createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void>; abort(): Promise<void> }> }>;
};

export async function exportSessionToUserSelectedPath(session: StoredSession): Promise<void> {
  const picker = (window as SaveFilePickerWindow).showSaveFilePicker;
  if (!picker) throw new Error('local-export-unsupported');
  const handle = await picker({ suggestedName: `techmap-session-${session.id}.json`, types: [{ description: 'TechMap session JSON', accept: { 'application/json': ['.json'] } }] });
  const writable = await handle.createWritable();
  try { await writable.write(JSON.stringify(session, null, 2)); await writable.close(); }
  catch (error) { await writable.abort().catch(() => undefined); throw error; }
}

export { privacyCompanionOrigin, privacyUrl };
