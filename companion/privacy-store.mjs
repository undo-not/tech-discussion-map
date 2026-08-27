import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open, readdir, readFile, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyAnalysisState, validateAnalysisState } from '../app/domain/analysis/contract.ts';

const maximumSessionPlaintextBytes = 1024 * 1024;
const maximumSessionCiphertextBytes = 8 * 1024 * 1024;
const maximumResponsesRequestBytes = 32 * 1024;
const maximumResponsesResponseBytes = 256 * 1024;
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

function isValidStoredUtterance(item) {
  if (typeof item !== 'object' || item === null) return false;
  const utteranceKeys = new Set(['id', 'revision', 'phase', 'source', 'speaker', 'speakerAlias', 'startMs', 'endMs', 'text']);
  const aliasIsValid = item.speaker === 'displayed-alias'
    ? typeof item.speakerAlias === 'string' && /^speaker-[1-9][0-9]{0,2}$/.test(item.speakerAlias)
    : item.speakerAlias === undefined;
  return exactKeys(item, utteranceKeys) &&
    /^[a-zA-Z0-9_-]{1,80}$/.test(item.id) &&
    Number.isSafeInteger(item.revision) && item.revision >= 0 &&
    item.phase === 'final' &&
    ['local', 'remote', 'teams-caption', 'synthetic'].includes(item.source) &&
    ['self', 'remote-group', 'displayed-alias', 'anonymous', 'unknown'].includes(item.speaker) &&
    aliasIsValid &&
    Number.isSafeInteger(item.startMs) && item.startMs >= 0 &&
    Number.isSafeInteger(item.endMs) && item.endMs >= item.startMs &&
    typeof item.text === 'string' && item.text.length > 0 && item.text.length <= 8_000;
}

export function validateStoredSession(value) {
  if (typeof value !== 'object' || value === null) throw new Error('invalid-session');
  const allowed = new Set(['id', 'createdAt', 'updatedAt', 'expiresAt', 'retentionDays', 'consent', 'transcript', 'analysis', 'state']);
  if (!exactKeys(value, allowed) || !sessionIdPattern.test(value.id) || !allowedRetentionDays.has(value.retentionDays)) throw new Error('invalid-session');
  for (const field of ['createdAt', 'updatedAt', 'expiresAt']) if (typeof value[field] !== 'string' || !Number.isFinite(Date.parse(value[field]))) throw new Error('invalid-session-time');
  if (Date.parse(value.expiresAt) <= Date.parse(value.updatedAt)) throw new Error('invalid-session-retention');
  if (typeof value.consent !== 'object' || value.consent === null || !exactKeys(value.consent, new Set(['version', 'confirmed', 'confirmedAt', 'scope'])) || value.consent.version !== 1 || value.consent.confirmed !== true || value.consent.scope !== 'all-participants' || typeof value.consent.confirmedAt !== 'string' || !Number.isFinite(Date.parse(value.consent.confirmedAt))) throw new Error('invalid-session-consent');
  if (!Array.isArray(value.transcript) || value.transcript.length > 10_000 || value.transcript.some((item) => !isValidStoredUtterance(item))) throw new Error('invalid-session-transcript');
  let analysis;
  try {
    const candidate = Array.isArray(value.analysis) && value.analysis.length === 0 ? emptyAnalysisState : value.analysis;
    analysis = validateAnalysisState(candidate, value.transcript);
  }
  catch { throw new Error('invalid-session-analysis'); }
  if (typeof value.state !== 'object' || value.state === null || !exactKeys(value.state, new Set(['capture', 'externalAnalysisAllowed', 'dataControlsAttested'])) || typeof value.state.capture !== 'string' || ('externalAnalysisAllowed' in value.state && typeof value.state.externalAnalysisAllowed !== 'boolean') || ('dataControlsAttested' in value.state && typeof value.state.dataControlsAttested !== 'boolean')) throw new Error('invalid-session-state');
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > maximumSessionPlaintextBytes || containsForbiddenSessionKey(value)) throw new Error('forbidden-session-data');
  return { ...structuredClone(value), analysis };
}

function runNativeHelper(helperPath, command, input = Buffer.alloc(0)) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(helperPath, [command], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const chunks = [];
    let size = 0;
    let settled = false;
    let oversized = false;
    const timeoutMilliseconds = command === 'responses' ? 55_000 : 10_000;
    const finish = (error, output) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error); else resolveRun(output);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error(`privacy-helper-${command}-timeout`));
    }, timeoutMilliseconds);
    timeout.unref();
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      const maximumOutputBytes = command === 'responses' ? maximumResponsesResponseBytes : maximumSessionCiphertextBytes;
      if (size > maximumOutputBytes) { oversized = true; child.kill(); }
      else chunks.push(chunk);
    });
    child.on('error', () => finish(new Error('privacy-helper-unavailable')));
    child.on('exit', (code) => code === 0 && !oversized ? finish(null, Buffer.concat(chunks)) : finish(new Error(`privacy-helper-${command}-failed`)));
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
        metadata.push({ id: session.id, updatedAt: session.updatedAt, expiresAt: session.expiresAt, transcriptCount: session.transcript.length, analysisCount: session.analysis.items.length, unreadable: false });
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

  async function responses(request) {
    const encoded = Buffer.from(JSON.stringify(request), 'utf8');
    if (encoded.length === 0 || encoded.length > maximumResponsesRequestBytes) { encoded.fill(0); throw new Error('privacy-responses-request-out-of-bounds'); }
    let result;
    try { result = await runner('responses', encoded); } finally { encoded.fill(0); }
    if (!Buffer.isBuffer(result) || result.length === 0 || result.length > maximumResponsesResponseBytes) throw new Error('privacy-responses-output-out-of-bounds');
    try { return JSON.parse(result.toString('utf8')); }
    finally { result.fill(0); }
  }

  return { initialize, list, load, remove, responses, root, save, status, sweep };
}

export { allowedRetentionDays, maximumResponsesRequestBytes, maximumResponsesResponseBytes, maximumSessionCiphertextBytes, maximumSessionPlaintextBytes, maximumStoredSessions };
