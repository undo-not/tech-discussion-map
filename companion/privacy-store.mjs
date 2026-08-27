import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open, readdir, readFile, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const maximumSessionPlaintextBytes = 1024 * 1024;
const maximumSessionCiphertextBytes = 8 * 1024 * 1024;
const maximumStoredSessions = 100;
const sessionIdPattern = /^[a-f0-9-]{36}$/;
const allowedRetentionDays = new Set([1, 7, 30, 90]);

function isWithin(parent, candidate) {
  const result = relative(parent, candidate);
  return result !== '' && !result.startsWith('..') && !isAbsolute(result);
}

function exactKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function containsForbiddenSessionKey(value) {
  if (typeof value !== 'object' || value === null) return false;
  const forbidden = /^(?:audio|pcm|samples|waveform|recording|media|blob|bytes|apiKey|authorization|secret|token)$/i;
  return Object.entries(value).some(([key, nested]) => forbidden.test(key) || containsForbiddenSessionKey(nested));
}

export function validateStoredSession(value) {
  if (typeof value !== 'object' || value === null) throw new Error('invalid-session');
  const allowed = new Set(['id', 'createdAt', 'updatedAt', 'expiresAt', 'retentionDays', 'consent', 'transcript', 'analysis', 'state']);
  if (!exactKeys(value, allowed) || !sessionIdPattern.test(value.id) || !allowedRetentionDays.has(value.retentionDays)) throw new Error('invalid-session');
  for (const field of ['createdAt', 'updatedAt', 'expiresAt']) if (typeof value[field] !== 'string' || !Number.isFinite(Date.parse(value[field]))) throw new Error('invalid-session-time');
  if (Date.parse(value.expiresAt) <= Date.parse(value.updatedAt)) throw new Error('invalid-session-retention');
  if (typeof value.consent !== 'object' || value.consent === null || !exactKeys(value.consent, new Set(['version', 'confirmed', 'confirmedAt', 'scope'])) || value.consent.version !== 1 || value.consent.confirmed !== true || value.consent.scope !== 'all-participants' || typeof value.consent.confirmedAt !== 'string' || !Number.isFinite(Date.parse(value.consent.confirmedAt))) throw new Error('invalid-session-consent');
  const utteranceKeys = new Set(['id', 'revision', 'phase', 'source', 'speaker', 'startMs', 'endMs', 'text']);
  if (!Array.isArray(value.transcript) || value.transcript.length > 10_000 || value.transcript.some((item) => typeof item !== 'object' || item === null || !exactKeys(item, utteranceKeys) || !/^[a-zA-Z0-9_-]{1,80}$/.test(item.id) || !Number.isSafeInteger(item.revision) || item.revision < 0 || item.phase !== 'final' || !['local', 'remote', 'synthetic'].includes(item.source) || !['self', 'remote-group', 'unknown'].includes(item.speaker) || !Number.isSafeInteger(item.startMs) || item.startMs < 0 || !Number.isSafeInteger(item.endMs) || item.endMs < item.startMs || typeof item.text !== 'string' || item.text.length === 0 || item.text.length > 8_000)) throw new Error('invalid-session-transcript');
  if (!Array.isArray(value.analysis) || value.analysis.length > 2_000) throw new Error('invalid-session-analysis');
  if (typeof value.state !== 'object' || value.state === null || !exactKeys(value.state, new Set(['capture', 'externalAnalysisAllowed', 'dataControlsAttested'])) || typeof value.state.capture !== 'string' || ('externalAnalysisAllowed' in value.state && typeof value.state.externalAnalysisAllowed !== 'boolean') || ('dataControlsAttested' in value.state && typeof value.state.dataControlsAttested !== 'boolean')) throw new Error('invalid-session-state');
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > maximumSessionPlaintextBytes || containsForbiddenSessionKey(value)) throw new Error('forbidden-session-data');
  return structuredClone(value);
}

function runNativeHelper(helperPath, command, input = Buffer.alloc(0)) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(helperPath, [command], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const chunks = [];
    let size = 0;
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > maximumSessionCiphertextBytes) child.kill();
      else chunks.push(chunk);
    });
    child.on('error', () => reject(new Error('privacy-helper-unavailable')));
    child.on('exit', (code) => code === 0 && size <= maximumSessionCiphertextBytes ? resolveRun(Buffer.concat(chunks)) : reject(new Error(`privacy-helper-${command}-failed`)));
    child.stdin.end(input);
  });
}

export function createPrivacyStore(options = {}) {
  const environment = options.environment ?? process.env;
  const localAppData = environment.LOCALAPPDATA;
  if (!localAppData || !isAbsolute(localAppData)) throw new Error('LOCALAPPDATA is required');
  const root = resolve(localAppData, 'TechMapLive', 'sessions');
  const scriptDirectory = fileURLToPath(new URL('.', import.meta.url));
  const helperPath = resolve(options.helperPath ?? environment.TECHMAP_PRIVACY_PATH ?? join(scriptDirectory, '..', 'native', 'privacy', 'build', 'Release', 'techmap-privacy.exe'));
  const runner = options.runner ?? ((command, input) => runNativeHelper(helperPath, command, input));
  let initialized = false;

  async function initialize() {
    if (initialized) return;
    const result = JSON.parse((await runner('provision-store')).toString('utf8'));
    if (result?.secure !== true) throw new Error('privacy-store-acl-unverified');
    initialized = true;
    try { await sweep(new Date()); }
    catch (error) { initialized = false; throw error; }
  }

  function sessionPath(id) {
    if (!sessionIdPattern.test(id)) throw new Error('invalid-session-id');
    const candidate = resolve(root, `${id}.tmps`);
    if (!isWithin(root, candidate)) throw new Error('invalid-session-path');
    return candidate;
  }

  async function save(value) {
    await initialize();
    const session = validateStoredSession(value);
    const existingNames = (await readdir(root)).filter((name) => /^[a-f0-9-]{36}\.tmps$/.test(name));
    if (!existingNames.includes(`${session.id}.tmps`) && existingNames.length >= maximumStoredSessions) throw new Error('privacy-session-limit');
    const clear = Buffer.from(JSON.stringify(session), 'utf8');
    let sealed;
    try { sealed = await runner('seal', clear); } finally { clear.fill(0); }
    if (!Buffer.isBuffer(sealed) || sealed.length === 0 || sealed.length > maximumSessionCiphertextBytes) throw new Error('privacy-seal-failed');
    const destination = sessionPath(session.id);
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(sealed); await handle.sync(); } finally { await handle.close(); sealed.fill(0); }
      await rename(temporary, destination);
    } catch (error) {
      sealed.fill(0);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    return { id: session.id, expiresAt: session.expiresAt };
  }

  async function load(id) {
    await initialize();
    const sealed = await readFile(sessionPath(id));
    if (sealed.length === 0 || sealed.length > maximumSessionCiphertextBytes) throw new Error('privacy-session-out-of-bounds');
    let clear;
    try { clear = await runner('unseal', sealed); } finally { sealed.fill(0); }
    try { return validateStoredSession(JSON.parse(clear.toString('utf8'))); } finally { clear.fill(0); }
  }

  async function list() {
    await initialize();
    const names = (await readdir(root)).filter((name) => /^[a-f0-9-]{36}\.tmps$/.test(name));
    if (names.length > maximumStoredSessions) throw new Error('privacy-session-limit');
    const metadata = [];
    for (const name of names) {
      const id = name.slice(0, -5);
      try {
        const session = await load(id);
        metadata.push({ id: session.id, updatedAt: session.updatedAt, expiresAt: session.expiresAt, transcriptCount: session.transcript.length, analysisCount: session.analysis.length, unreadable: false });
      } catch {
        metadata.push({ id, updatedAt: null, expiresAt: null, transcriptCount: 0, analysisCount: 0, unreadable: true });
      }
    }
    return metadata.sort((left, right) => (right.updatedAt ?? '').localeCompare(left.updatedAt ?? ''));
  }

  async function remove(id) {
    await initialize();
    try { await unlink(sessionPath(id)); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
  }

  async function sweep(now = new Date()) {
    const sessions = await list();
    const expired = sessions.filter((session) => session.expiresAt !== null && Date.parse(session.expiresAt) <= now.getTime());
    for (const session of expired) await remove(session.id);
    return expired.map((session) => session.id);
  }

  async function status() {
    await initialize();
    const key = JSON.parse((await runner('key-status')).toString('utf8'));
    return { secureStore: true, credentialConfigured: key?.configured === true, location: '%LOCALAPPDATA%\\TechMapLive\\sessions' };
  }

  return { initialize, list, load, remove, root, save, status, sweep };
}

export { allowedRetentionDays, maximumSessionCiphertextBytes, maximumSessionPlaintextBytes, maximumStoredSessions };
