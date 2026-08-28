import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createPrivacyStore } from './privacy-store.mjs';
import { attachTeamsAudioBridge, runTeamsAudioProbe } from './teams-audio-bridge.mjs';
import { createZoomCredentialSigner } from './zoom-credential-signer.mjs';
import { createZoomRtmsController } from './zoom-rtms-bridge.mjs';
import { createZoomWebhookServer, defaultZoomWebhookPort, zoomWebhookPath } from './zoom-webhook-host.mjs';
import { assertPrivacySafeResponsesRequest } from '../app/adapters/privacy/openai-request-policy.ts';
import { analysisStructuredOutput } from '../app/domain/analysis/schema.ts';

const loopbackHost = '127.0.0.1';
const defaultPort = 43117;
const maximumJsonBytes = 4 * 1024;
const maximumAudioBytes = 128 * 1024;
const maximumWorkerFrameBytes = 64 * 1024;
const maximumPrivacyRequestBytes = 1024 * 1024;
const maximumAnalysisRequestBytes = 32 * 1024;
const allowedOrigins = new Set(['http://127.0.0.1:3000', 'http://localhost:3000']);
const defaultTokenLifetimeMs = 10 * 60 * 1000;
const defaultTeamsAudioIdleTimeoutMs = 30 * 1000;

function sendJson(response, status, value, origin) {
  const encoded = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': encoded.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
  });
  response.end(encoded);
}

function readBody(request, maximumBytes) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > maximumBytes) {
        reject(new Error('request-too-large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolveBody(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function tokenMatches(expected, actual) {
  if (typeof actual !== 'string') return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

function frameForWorker(type, payload = Buffer.alloc(0)) {
  if (payload.length > maximumAudioBytes) throw new Error('audio-chunk-out-of-bounds');
  const frame = Buffer.alloc(12 + payload.length);
  frame.write('TMI1', 0, 'ascii');
  frame[4] = 1;
  frame[5] = type;
  frame.writeUInt32LE(payload.length, 8);
  payload.copy(frame, 12);
  return frame;
}

function parseWorkerEvents(state, chunk) {
  const previous = state.buffer;
  state.buffer = Buffer.concat([previous, chunk]);
  previous.fill(0);
  const parsed = [];
  try {
    while (state.buffer.length >= 12) {
      if (state.buffer.subarray(0, 4).toString('ascii') !== 'TMO1' || state.buffer[4] !== 1 || state.buffer[6] !== 0 || state.buffer[7] !== 0) {
        throw new Error('invalid-worker-protocol');
      }
      const size = state.buffer.readUInt32LE(8);
      if (size > maximumWorkerFrameBytes) throw new Error('worker-frame-too-large');
      if (state.buffer.length < 12 + size) break;
      const type = state.buffer[5];
      const consumed = state.buffer;
      const payload = consumed.subarray(12, 12 + size);
      const remaining = Buffer.from(consumed.subarray(12 + size));
      let value;
      try {
        if (type !== 1) throw new Error('unknown-worker-frame');
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
      } finally { consumed.fill(0); }
      state.buffer = remaining;
      parsed.push(value);
    }
  } catch (error) {
    state.buffer.fill(0);
    state.buffer = Buffer.alloc(0);
    throw error;
  }
  return parsed;
}

const captionStates = new Set(['selecting-target', 'active-ocr', 'degraded-caption-missing', 'degraded-low-confidence', 'stopped']);
const captionReasons = new Set([
  'user-selection-required', 'capture-started', 'selection-cancelled', 'teams-not-foreground', 'teams-not-visible',
  'teams-minimized', 'teams-window-unavailable', 'selection-invalid', 'selection-outside-client', 'selection-too-large',
  'selection-covered', 'dpi-changed', 'capture-unsupported', 'ocr-timeout', 'ocr-unavailable', 'low-confidence', 'user-stopped',
]);

function exactKeys(value, expected) {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function validateCaptionWorkerEvent(value) {
  if (typeof value !== 'object' || value === null || value.v !== 1 || typeof value.type !== 'string') throw new Error('invalid-caption-worker-event');
  if (value.type === 'state') {
    if (!exactKeys(value, ['reason', 'state', 'type', 'v']) || !captionStates.has(value.state) || !captionReasons.has(value.reason)) throw new Error('invalid-caption-state-event');
  } else if (value.type === 'observation') {
    const hasAlias = value.speaker === 'displayed-alias';
    const expected = hasAlias
      ? ['confidence', 'observedAtMs', 'revision', 'rowId', 'source', 'speaker', 'speakerAlias', 'text', 'type', 'v']
      : ['confidence', 'observedAtMs', 'revision', 'rowId', 'source', 'speaker', 'text', 'type', 'v'];
    if (!exactKeys(value, expected) || !/^ocr-[a-f0-9]{8}-[1-9][0-9]{0,8}$/.test(value.rowId) ||
        !Number.isSafeInteger(value.revision) || value.revision < 1 || value.source !== 'teams-ocr' ||
        !['displayed-alias', 'anonymous', 'unknown'].includes(value.speaker) ||
        (hasAlias ? typeof value.speakerAlias !== 'string' || !/^speaker-[1-9][0-9]{0,2}$/.test(value.speakerAlias) : value.speakerAlias !== undefined) ||
        !Number.isSafeInteger(value.observedAtMs) || value.observedAtMs < 0 || typeof value.text !== 'string' || value.text.length === 0 || value.text.length > 8_000 ||
        !Number.isInteger(value.confidence) || value.confidence < 85 || value.confidence > 100) throw new Error('invalid-caption-observation-event');
  } else if (value.type === 'row-disappeared') {
    if (!exactKeys(value, ['observedAtMs', 'rowId', 'type', 'v']) || !/^ocr-[a-f0-9]{8}-[1-9][0-9]{0,8}$/.test(value.rowId) || !Number.isSafeInteger(value.observedAtMs) || value.observedAtMs < 0) throw new Error('invalid-caption-row-event');
  } else if (value.type === 'tick') {
    if (!exactKeys(value, ['observedAtMs', 'type', 'v']) || !Number.isSafeInteger(value.observedAtMs) || value.observedAtMs < 0) throw new Error('invalid-caption-tick-event');
  } else throw new Error('unknown-caption-worker-event');
  return structuredClone(value);
}

function defaultPaths(environment) {
  const localAppData = environment.LOCALAPPDATA;
  if (!localAppData || !isAbsolute(localAppData)) throw new Error('LOCALAPPDATA is required');
  const modelRoot = resolve(localAppData, 'TechMapLive', 'models');
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  return {
    modelRoot,
    modelPath: resolve(modelRoot, 'ggml-tiny.bin'),
    workerPath: resolve(scriptDirectory, '..', 'native', 'transcription', 'build', 'Release', 'techmap-transcriber.exe'),
    captionWorkerPath: resolve(scriptDirectory, '..', 'native', 'teams-captions', 'build', 'Release', 'techmap-captions.exe'),
    audioWorkerPath: resolve(scriptDirectory, '..', 'native', 'windows-audio', 'build', 'Release', 'techmap-audio.exe'),
  };
}

function pathIsWithin(parent, candidate) {
  const result = relative(parent, candidate);
  return result !== '' && !result.startsWith('..') && !isAbsolute(result);
}

export function createCompanionServer(options = {}) {
  const environment = options.environment ?? process.env;
  const defaults = defaultPaths(environment);
  const modelPath = resolve(options.modelPath ?? defaults.modelPath);
  const workerPath = resolve(options.workerPath ?? environment.TECHMAP_TRANSCRIBER_PATH ?? defaults.workerPath);
  const captionWorkerPath = resolve(options.captionWorkerPath ?? environment.TECHMAP_CAPTIONS_PATH ?? defaults.captionWorkerPath);
  const audioWorkerPath = resolve(options.audioWorkerPath ?? environment.TECHMAP_AUDIO_PATH ?? defaults.audioWorkerPath);
  const spawnWorker = options.spawnWorker ?? ((args) => spawn(workerPath, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }));
  const spawnCaptionWorker = options.spawnCaptionWorker ?? ((args) => spawn(captionWorkerPath, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }));
  const spawnAudioWorker = options.spawnAudioWorker ?? ((args) => spawn(audioWorkerPath, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }));
  const privacyStore = options.privacyStore ?? createPrivacyStore({ environment });
  const zoomController = options.zoomController ?? createZoomRtmsController({
    credentials: options.zoomCredentials ?? createZoomCredentialSigner(),
    WebSocketImpl: options.WebSocketImpl,
  });
  const now = options.now ?? Date.now;
  const tokenLifetimeMs = options.tokenLifetimeMs ?? defaultTokenLifetimeMs;
  if (!Number.isSafeInteger(tokenLifetimeMs) || tokenLifetimeMs < 1_000 || tokenLifetimeMs > 24 * 60 * 60 * 1000) throw new Error('invalid-token-lifetime');
  const teamsAudioIdleTimeoutMs = options.teamsAudioIdleTimeoutMs ?? defaultTeamsAudioIdleTimeoutMs;
  if (!Number.isSafeInteger(teamsAudioIdleTimeoutMs) || teamsAudioIdleTimeoutMs < 100 || teamsAudioIdleTimeoutMs > 5 * 60 * 1000) throw new Error('invalid-teams-audio-idle-timeout');
  const launchSecret = options.launchSecret ?? randomBytes(32).toString('hex');
  if (!/^[a-f0-9]{64}$/.test(launchSecret)) throw new Error('invalid-launch-secret');
  const tokens = new Map();
  const sessions = new Map();
  const captionSessions = new Map();
  const teamsAudioSessions = new Map();
  const globalAnalysisBudget = { windowStart: now(), calls: 0 };

  if (!pathIsWithin(defaults.modelRoot, modelPath)) throw new Error('Model must remain under LocalAppData\\TechMapLive\\models');

  const server = createServer(async (request, response) => {
    const origin = request.headers.origin;
    const address = server.address();
    const expectedHost = typeof address === 'object' && address ? `${loopbackHost}:${address.port}` : `${loopbackHost}:${defaultPort}`;
    if (request.headers.host !== expectedHost) return sendJson(response, 403, { error: 'host-not-allowed' });
    if (!origin || !allowedOrigins.has(origin)) return sendJson(response, 403, { error: 'origin-not-allowed' });
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Max-Age': '600',
        Vary: 'Origin',
      });
      return response.end();
    }

    const url = new URL(request.url ?? '/', `http://${loopbackHost}`);
    if (request.method === 'POST' && url.pathname === '/v1/bootstrap') {
      const body = await readBody(request, maximumJsonBytes).catch(() => null);
      let configuration;
      try { configuration = body ? JSON.parse(body.toString('utf8')) : null; }
      catch { configuration = null; }
      if (!configuration || request.headers['content-type'] !== 'application/json' || Object.keys(configuration).length !== 1 || !tokenMatches(launchSecret, configuration.launchSecret)) return sendJson(response, 401, { error: 'launch-secret-required' }, origin);
      for (const [token, entry] of tokens) if (entry.expiresAt < now()) tokens.delete(token);
      while (tokens.size >= 32) tokens.delete(tokens.keys().next().value);
      const token = randomBytes(32).toString('hex');
      tokens.set(token, { origin, expiresAt: now() + tokenLifetimeMs, analysisWindowStart: now(), analysisCalls: 0 });
      return sendJson(response, 200, { token }, origin);
    }

    const authorization = request.headers.authorization;
    const actualToken = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
    const tokenEntry = [...tokens.entries()].find(([token]) => tokenMatches(token, actualToken));
    if (!tokenEntry || tokenEntry[1].origin !== origin || tokenEntry[1].expiresAt < now()) {
      return sendJson(response, 401, { error: 'unauthorized' }, origin);
    }
    tokenEntry[1].expiresAt = now() + tokenLifetimeMs;

    if (request.method === 'POST' && url.pathname === '/v1/analysis') {
      const tokenState = tokenEntry[1];
      const body = await readBody(request, maximumAnalysisRequestBytes).catch(() => null);
      let analysisRequest;
      try { analysisRequest = body && request.headers['content-type'] === 'application/json' ? JSON.parse(body.toString('utf8')) : null; assertPrivacySafeResponsesRequest(analysisRequest); }
      catch { return sendJson(response, 400, { error: 'analysis-request-rejected' }, origin); }
      if (JSON.stringify(analysisRequest.text?.format) !== JSON.stringify(analysisStructuredOutput)) return sendJson(response, 400, { error: 'analysis-schema-rejected' }, origin);
      const requestTime = now();
      if (requestTime - tokenState.analysisWindowStart >= 60_000) { tokenState.analysisWindowStart = requestTime; tokenState.analysisCalls = 0; }
      if (requestTime - globalAnalysisBudget.windowStart >= 60_000) { globalAnalysisBudget.windowStart = requestTime; globalAnalysisBudget.calls = 0; }
      if (tokenState.analysisCalls >= 6 || globalAnalysisBudget.calls >= 12) return sendJson(response, 429, { error: 'analysis-rate-limited' }, origin);
      // No await may occur between this check and reservation: concurrent validated requests are serialized by the event loop here.
      tokenState.analysisCalls += 1;
      globalAnalysisBudget.calls += 1;
      try { return sendJson(response, 200, await privacyStore.responses(analysisRequest), origin); }
      catch { return sendJson(response, 502, { error: 'analysis-upstream-unavailable' }, origin); }
    }

    if (request.method === 'GET' && url.pathname === '/v1/privacy/status') {
      try { return sendJson(response, 200, await privacyStore.status(), origin); }
      catch { return sendJson(response, 503, { error: 'privacy-store-unavailable' }, origin); }
    }

    if (request.method === 'GET' && url.pathname === '/v1/zoom-rtms/status') {
      try { return sendJson(response, 200, { ...(await zoomController.status()), webhookPath: zoomWebhookPath, webhookPort: defaultZoomWebhookPort }, origin); }
      catch { return sendJson(response, 503, { error: 'zoom-credential-status-unavailable' }, origin); }
    }

    if (request.method === 'POST' && url.pathname === '/v1/zoom-rtms-sessions') {
      const body = await readBody(request, maximumJsonBytes).catch(() => null);
      let configuration;
      try { configuration = body && request.headers['content-type'] === 'application/json' ? JSON.parse(body.toString('utf8')) : null; }
      catch { configuration = null; }
      if (!configuration || !exactKeys(configuration, ['consentConfirmed']) || configuration.consentConfirmed !== true) {
        return sendJson(response, 400, { error: 'zoom-rtms-consent-required' }, origin);
      }
      try { return sendJson(response, 201, await zoomController.createSession(), origin); }
      catch (error) {
        return sendJson(response, error?.message === 'zoom-session-already-active' ? 429 : 503, { error: error?.message ?? 'zoom-session-unavailable' }, origin);
      }
    }

    const zoomMatch = /^\/v1\/zoom-rtms-sessions\/([a-f0-9-]{36})(?:\/(events|confirm|pause|resume|stop))?$/.exec(url.pathname);
    if (zoomMatch) {
      const action = zoomMatch[2];
      try {
        if (request.method === 'GET' && action === 'events') {
          const after = Number(url.searchParams.get('after') ?? '0');
          let result = zoomController.getEvents(zoomMatch[1], after);
          if (result.events.length === 0 && !result.stopped) {
            await new Promise((resolveWait) => setTimeout(resolveWait, 200));
            result = zoomController.getEvents(zoomMatch[1], after);
          }
          return sendJson(response, 200, result, origin);
        }
        if (request.method === 'POST' && action === 'confirm') return sendJson(response, 200, zoomController.confirm(zoomMatch[1]), origin);
        if (request.method === 'POST' && action === 'pause') return sendJson(response, 200, zoomController.pause(zoomMatch[1]), origin);
        if (request.method === 'POST' && action === 'resume') return sendJson(response, 200, zoomController.resume(zoomMatch[1]), origin);
        if (request.method === 'POST' && action === 'stop') return sendJson(response, 200, zoomController.stop(zoomMatch[1]), origin);
      } catch (error) {
        return sendJson(response, error?.message === 'invalid-zoom-event-cursor' ? 400 : 404, { error: error?.message ?? 'zoom-session-not-found' }, origin);
      }
      return sendJson(response, 404, { error: 'not-found' }, origin);
    }
    if (request.method === 'GET' && url.pathname === '/v1/privacy/sessions') {
      try { return sendJson(response, 200, { sessions: await privacyStore.list() }, origin); }
      catch { return sendJson(response, 503, { error: 'privacy-store-unavailable' }, origin); }
    }
    if (request.method === 'POST' && url.pathname === '/v1/privacy/sweep') {
      try { return sendJson(response, 200, { deleted: await privacyStore.sweep() }, origin); }
      catch { return sendJson(response, 503, { error: 'privacy-store-unavailable' }, origin); }
    }
    const privacyMatch = /^\/v1\/privacy\/sessions\/([a-f0-9-]{36})$/.exec(url.pathname);
    if (privacyMatch && request.method === 'PUT') {
      const body = await readBody(request, maximumPrivacyRequestBytes).catch(() => null);
      let session;
      try { session = body ? JSON.parse(body.toString('utf8')) : null; }
      catch { session = null; }
      if (!session || session.id !== privacyMatch[1]) return sendJson(response, 400, { error: 'invalid-session' }, origin);
      try { return sendJson(response, 200, await privacyStore.save(session), origin); }
      catch { return sendJson(response, 400, { error: 'session-not-saved' }, origin); }
    }
    if (privacyMatch && request.method === 'GET') {
      try { return sendJson(response, 200, await privacyStore.load(privacyMatch[1]), origin); }
      catch { return sendJson(response, 404, { error: 'session-not-found' }, origin); }
    }
    if (privacyMatch && request.method === 'DELETE') {
      try { return sendJson(response, 200, { deleted: await privacyStore.remove(privacyMatch[1]) }, origin); }
      catch { return sendJson(response, 503, { error: 'session-not-deleted' }, origin); }
    }

    const clearCaptionSessionBuffers = (session) => {
      if (session.parser?.buffer) session.parser.buffer.fill(0);
      session.parser = { buffer: Buffer.alloc(0) };
      session.events.length = 0;
    };

    const detachCaptionWorker = (session) => {
      const worker = session.worker;
      session.worker = null;
      if (worker && !worker.killed) worker.kill();
    };

    const attachCaptionWorker = (session) => {
      detachCaptionWorker(session);
      clearCaptionSessionBuffers(session);
      const sessionProof = randomBytes(32).toString('hex');
      const worker = spawnCaptionWorker(['ocr-capture', '--consent-confirmed', '--session-proof', sessionProof]);
      session.worker = worker;
      session.stopped = false;
      session.paused = false;
      worker.stdin.on('error', () => {
        if (session.worker !== worker || session.paused || session.stopped) return;
        session.stopped = true;
        clearCaptionSessionBuffers(session);
        if (!worker.killed) worker.kill();
      });
      try { worker.stdin.end(sessionProof); }
      catch { worker.stdin.emit('error', new Error('caption-proof-write-failed')); }
      worker.stdout.on('data', (chunk) => {
        if (session.worker !== worker || session.paused || session.stopped) { chunk.fill(0); return; }
        try {
          for (const event of parseWorkerEvents(session.parser, chunk).map(validateCaptionWorkerEvent)) {
            session.cursor += 1;
            session.events.push({ cursor: session.cursor, value: event });
            if (session.events.length > 256) session.events.shift();
          }
        } catch {
          session.stopped = true;
          clearCaptionSessionBuffers(session);
          worker.kill();
        } finally {
          chunk.fill(0);
        }
      });
      worker.on('error', () => { if (session.worker === worker && !session.paused) session.stopped = true; });
      worker.on('exit', () => { if (session.worker === worker && !session.paused) session.stopped = true; });
    };

    if (request.method === 'POST' && url.pathname === '/v1/caption-sessions') {
      const body = await readBody(request, maximumJsonBytes).catch(() => null);
      let configuration;
      try { configuration = body && request.headers['content-type'] === 'application/json' ? JSON.parse(body.toString('utf8')) : null; }
      catch { configuration = null; }
      if (!configuration || !exactKeys(configuration, ['consentConfirmed']) || configuration.consentConfirmed !== true) {
        return sendJson(response, 400, { error: 'caption-consent-required' }, origin);
      }
      if (!existsSync(captionWorkerPath)) return sendJson(response, 503, { error: 'caption-engine-not-installed' }, origin);
      for (const [id, existing] of captionSessions) {
        if (!existing.stopped) continue;
        clearCaptionSessionBuffers(existing);
        detachCaptionWorker(existing);
        captionSessions.delete(id);
      }
      if (captionSessions.size >= 2) return sendJson(response, 429, { error: 'too-many-caption-sessions' }, origin);
      const id = randomUUID();
      const session = { id, worker: null, paused: false, stopped: false, cursor: 0, events: [], parser: { buffer: Buffer.alloc(0) } };
      captionSessions.set(id, session);
      attachCaptionWorker(session);
      return sendJson(response, 201, { sessionId: id }, origin);
    }

    const captionMatch = /^\/v1\/caption-sessions\/([a-f0-9-]{36})(?:\/(events|pause|resume|stop))?$/.exec(url.pathname);
    if (captionMatch) {
      const captionSession = captionSessions.get(captionMatch[1]);
      if (!captionSession) return sendJson(response, 404, { error: 'caption-session-not-found' }, origin);
      const action = captionMatch[2];
      if (request.method === 'GET' && action === 'events') {
        const after = Number(url.searchParams.get('after') ?? '0');
        if (!Number.isSafeInteger(after) || after < 0) return sendJson(response, 400, { error: 'invalid-cursor' }, origin);
        if (!captionSession.events.some((event) => event.cursor > after) && !captionSession.stopped && !captionSession.paused) await new Promise((resolveWait) => setTimeout(resolveWait, 200));
        return sendJson(response, 200, { cursor: captionSession.cursor, events: captionSession.events.filter((event) => event.cursor > after).map((event) => event.value), stopped: captionSession.stopped, paused: captionSession.paused }, origin);
      }
      if (request.method === 'POST' && action === 'pause') {
        if (captionSession.stopped) return sendJson(response, 409, { error: 'caption-session-stopped' }, origin);
        if (captionSession.paused) return sendJson(response, 200, { state: 'paused', reselectOnResume: true }, origin);
        captionSession.paused = true;
        clearCaptionSessionBuffers(captionSession);
        detachCaptionWorker(captionSession);
        return sendJson(response, 200, { state: 'paused', reselectOnResume: true }, origin);
      }
      if (request.method === 'POST' && action === 'resume') {
        if (captionSession.stopped) return sendJson(response, 409, { error: 'caption-session-stopped' }, origin);
        if (!captionSession.paused) return sendJson(response, 409, { error: 'caption-session-not-paused' }, origin);
        attachCaptionWorker(captionSession);
        return sendJson(response, 200, { state: 'selecting-target' }, origin);
      }
      if (request.method === 'POST' && action === 'stop') {
        captionSession.paused = false;
        captionSession.stopped = true;
        clearCaptionSessionBuffers(captionSession);
        detachCaptionWorker(captionSession);
        setTimeout(() => captionSessions.delete(captionSession.id), 60_000).unref();
        return sendJson(response, 200, { state: 'stopped' }, origin);
      }
      return sendJson(response, 404, { error: 'not-found' }, origin);
    }

    if (request.method === 'POST' && url.pathname === '/v1/teams-audio/probe') {
      const body = await readBody(request, maximumJsonBytes).catch(() => null);
      let configuration;
      try { configuration = body && request.headers['content-type'] === 'application/json' ? JSON.parse(body.toString('utf8')) : null; }
      catch { configuration = null; }
      if (!configuration || !exactKeys(configuration, ['consentConfirmed']) || configuration.consentConfirmed !== true) {
        return sendJson(response, 400, { error: 'teams-audio-consent-required' }, origin);
      }
      if (!existsSync(audioWorkerPath)) return sendJson(response, 503, { error: 'teams-audio-helper-not-installed' }, origin);
      try { return sendJson(response, 200, await runTeamsAudioProbe(spawnAudioWorker), origin); }
      catch { return sendJson(response, 503, { error: 'teams-audio-probe-failed' }, origin); }
    }

    if (request.method === 'POST' && url.pathname === '/v1/teams-audio-sessions') {
      const body = await readBody(request, maximumJsonBytes).catch(() => null);
      let configuration;
      try { configuration = body && request.headers['content-type'] === 'application/json' ? JSON.parse(body.toString('utf8')) : null; }
      catch { configuration = null; }
      if (!configuration || !exactKeys(configuration, ['consentConfirmed', 'processId']) || configuration.consentConfirmed !== true ||
          !Number.isSafeInteger(configuration.processId) || configuration.processId < 1 || configuration.processId > 0xffff_ffff) {
        return sendJson(response, 400, { error: 'invalid-teams-audio-session' }, origin);
      }
      if (!existsSync(audioWorkerPath) || !existsSync(modelPath) || !existsSync(workerPath)) {
        return sendJson(response, 503, { error: 'teams-audio-engine-not-installed' }, origin);
      }
      for (const [id, existing] of teamsAudioSessions) if (existing.stopped) teamsAudioSessions.delete(id);
      if (teamsAudioSessions.size >= 1) return sendJson(response, 429, { error: 'too-many-teams-audio-sessions' }, origin);
      let audioWorker;
      let transcriptionWorker;
      try {
        audioWorker = spawnAudioWorker(['capture', '--pid', String(configuration.processId), '--consent-confirmed']);
        transcriptionWorker = spawnWorker(['--model', modelPath, '--source', 'remote', '--language', 'ja']);
      } catch {
        if (audioWorker && !audioWorker.killed) audioWorker.kill();
        if (transcriptionWorker && !transcriptionWorker.killed) transcriptionWorker.kill();
        return sendJson(response, 503, { error: 'teams-audio-engine-start-failed' }, origin);
      }
      const id = randomUUID();
      const session = { id, stopped: false, cursor: 0, events: [], bridge: null, idleTimer: null, armIdleTimer: null };
      const pushEvent = (value) => {
        if (session.stopped) return;
        session.cursor += 1;
        session.events.push({ cursor: session.cursor, value });
        if (session.events.length > 256) session.events.shift();
      };
      session.bridge = attachTeamsAudioBridge({
        audioWorker,
        transcriptionWorker,
        frameForWorker,
        parseWorkerEvents,
        onCaptureState: (event) => pushEvent({ type: 'capture-state', state: event.state, reason: event.reason }),
        onUtterance: (utterance) => pushEvent({ type: 'utterance', utterance }),
        onFailure: (reason) => {
          pushEvent({ type: 'capture-state', state: 'degraded-microphone-only', reason });
          session.stopped = true;
          if (session.idleTimer) clearTimeout(session.idleTimer);
          setTimeout(() => teamsAudioSessions.delete(session.id), 60_000).unref();
        },
      });
      session.armIdleTimer = () => {
        if (session.stopped) return;
        if (session.idleTimer) clearTimeout(session.idleTimer);
        session.idleTimer = setTimeout(() => {
          if (session.stopped) return;
          session.stopped = true;
          session.events.length = 0;
          session.bridge.stop();
          teamsAudioSessions.delete(session.id);
        }, teamsAudioIdleTimeoutMs);
        session.idleTimer.unref?.();
      };
      teamsAudioSessions.set(id, session);
      session.armIdleTimer();
      return sendJson(response, 201, { sessionId: id }, origin);
    }

    const teamsAudioMatch = /^\/v1\/teams-audio-sessions\/([a-f0-9-]{36})(?:\/(events|stop))?$/.exec(url.pathname);
    if (teamsAudioMatch) {
      const teamsAudioSession = teamsAudioSessions.get(teamsAudioMatch[1]);
      if (!teamsAudioSession) return sendJson(response, 404, { error: 'teams-audio-session-not-found' }, origin);
      const action = teamsAudioMatch[2];
      if (request.method === 'GET' && action === 'events') {
        teamsAudioSession.armIdleTimer();
        const after = Number(url.searchParams.get('after') ?? '0');
        if (!Number.isSafeInteger(after) || after < 0) return sendJson(response, 400, { error: 'invalid-cursor' }, origin);
        if (!teamsAudioSession.events.some((event) => event.cursor > after) && !teamsAudioSession.stopped) await new Promise((resolveWait) => setTimeout(resolveWait, 200));
        return sendJson(response, 200, {
          cursor: teamsAudioSession.cursor,
          events: teamsAudioSession.events.filter((event) => event.cursor > after).map((event) => event.value),
          stopped: teamsAudioSession.stopped,
        }, origin);
      }
      if (request.method === 'POST' && action === 'stop') {
        teamsAudioSession.stopped = true;
        if (teamsAudioSession.idleTimer) clearTimeout(teamsAudioSession.idleTimer);
        teamsAudioSession.bridge.stop();
        teamsAudioSession.events.length = 0;
        setTimeout(() => teamsAudioSessions.delete(teamsAudioSession.id), 60_000).unref();
        return sendJson(response, 200, { state: 'stopped' }, origin);
      }
      return sendJson(response, 404, { error: 'not-found' }, origin);
    }

    if (request.method === 'POST' && url.pathname === '/v1/sessions') {
      const body = await readBody(request, maximumJsonBytes).catch(() => null);
      let configuration;
      try { configuration = body && request.headers['content-type'] === 'application/json' ? JSON.parse(body.toString('utf8')) : null; } catch { configuration = null; }
      if (
        !configuration || !['local', 'remote'].includes(configuration.source) ||
        configuration.sampleRate !== 16_000 || configuration.channels !== 1 || configuration.encoding !== 'pcm-s16le'
      ) return sendJson(response, 400, { error: 'invalid-audio-format' }, origin);
      if (!existsSync(modelPath) || !existsSync(workerPath)) return sendJson(response, 503, { error: 'local-engine-not-installed' }, origin);
      for (const [id, existing] of sessions) if (existing.stopped) sessions.delete(id);
      if (sessions.size >= 4) return sendJson(response, 429, { error: 'too-many-sessions' }, origin);

      const id = randomUUID();
      const worker = spawnWorker(['--model', modelPath, '--source', configuration.source, '--language', 'ja']);
      const session = { id, worker, source: configuration.source, paused: false, stopped: false, cursor: 0, events: [], parser: { buffer: Buffer.alloc(0) } };
      sessions.set(id, session);
      worker.stdout.on('data', (chunk) => {
        try {
          for (const event of parseWorkerEvents(session.parser, chunk)) {
            session.cursor += 1;
            session.events.push({ cursor: session.cursor, value: event });
            if (session.events.length > 256) session.events.shift();
          }
        } catch {
          session.stopped = true;
          worker.kill();
        }
      });
      worker.on('error', () => { session.stopped = true; });
      worker.on('exit', () => { session.stopped = true; });
      worker.stdin.on('error', () => {
        session.stopped = true;
        session.parser.buffer.fill(0);
        session.parser.buffer = Buffer.alloc(0);
        if (!worker.killed) worker.kill();
      });
      return sendJson(response, 201, { sessionId: id }, origin);
    }

    const match = /^\/v1\/sessions\/([a-f0-9-]{36})(?:\/(audio|events|pause|resume|stop))?$/.exec(url.pathname);
    const session = match ? sessions.get(match[1]) : undefined;
    if (!session) return sendJson(response, 404, { error: 'session-not-found' }, origin);
    const action = match[2];

    if (request.method === 'POST' && action === 'audio') {
      if (request.headers['content-type'] !== 'application/octet-stream') return sendJson(response, 415, { error: 'invalid-content-type' }, origin);
      const audio = await readBody(request, maximumAudioBytes).catch(() => null);
      if (!audio || audio.length === 0 || audio.length % 2 !== 0 || session.paused || session.stopped) {
        return sendJson(response, 409, { error: 'audio-not-accepted' }, origin);
      }
      const framed = frameForWorker(1, audio);
      try {
        await new Promise((resolveWrite, rejectWrite) => session.worker.stdin.write(framed, (error) => error ? rejectWrite(error) : resolveWrite()));
      } catch {
        session.stopped = true;
        return sendJson(response, 503, { error: 'local-engine-write-failed' }, origin);
      } finally { framed.fill(0); }
      return sendJson(response, 202, { accepted: true }, origin);
    }
    if (request.method === 'GET' && action === 'events') {
      const after = Number(url.searchParams.get('after') ?? '0');
      if (!Number.isSafeInteger(after) || after < 0) return sendJson(response, 400, { error: 'invalid-cursor' }, origin);
      if (!session.events.some((event) => event.cursor > after) && !session.stopped) await new Promise((resolveWait) => setTimeout(resolveWait, 200));
      return sendJson(response, 200, { cursor: session.cursor, events: session.events.filter((event) => event.cursor > after).map((event) => event.value), stopped: session.stopped }, origin);
    }
    if (request.method === 'POST' && action === 'pause') {
      session.paused = true;
      return sendJson(response, 200, { state: 'paused' }, origin);
    }
    if (request.method === 'POST' && action === 'resume') {
      if (session.stopped) return sendJson(response, 409, { error: 'session-stopped' }, origin);
      session.paused = false;
      return sendJson(response, 200, { state: 'listening' }, origin);
    }
    if (request.method === 'POST' && action === 'stop') {
      if (session.stopped) return sendJson(response, 200, { state: 'stopped' }, origin);
      session.stopped = true;
      const stopFrame = frameForWorker(2);
      session.worker.stdin.end(stopFrame, () => stopFrame.fill(0));
      setTimeout(() => { if (!session.worker.killed) session.worker.kill(); }, 3_000).unref();
      setTimeout(() => sessions.delete(session.id), 60_000).unref();
      return sendJson(response, 200, { state: 'stopped' }, origin);
    }
    return sendJson(response, 404, { error: 'not-found' }, origin);
  });

  server.on('close', () => {
    for (const session of sessions.values()) if (!session.worker.killed) session.worker.kill();
    for (const session of captionSessions.values()) {
      if (session.parser?.buffer) session.parser.buffer.fill(0);
      session.events.length = 0;
      if (session.worker && !session.worker.killed) session.worker.kill();
    }
    for (const session of teamsAudioSessions.values()) {
      if (session.idleTimer) clearTimeout(session.idleTimer);
      session.bridge.stop();
    }
    zoomController.close();
    sessions.clear();
    captionSessions.clear();
    teamsAudioSessions.clear();
    tokens.clear();
  });
  server.zoomController = zoomController;
  return server;
}

export function listen(options = {}) {
  const launchSecret = options.launchSecret ?? randomBytes(32).toString('hex');
  const server = createCompanionServer({ ...options, launchSecret });
  const zoomController = server.zoomController;
  const webhookServer = createZoomWebhookServer({ controller: zoomController });
  const port = options.port ?? defaultPort;
  const webhookPort = options.webhookPort ?? defaultZoomWebhookPort;
  server.listen(port, loopbackHost, () => process.stdout.write(`TechMap local companion ready on http://${loopbackHost}:${port}.\n`));
  webhookServer.listen(webhookPort, loopbackHost, () => process.stdout.write(`Zoom webhook listener ready on http://${loopbackHost}:${webhookPort}${zoomWebhookPath}.\n`));
  server.once('close', () => { if (webhookServer.listening) webhookServer.close(); });
  webhookServer.once('error', () => { if (server.listening) server.close(); });
  server.webhookServer = webhookServer;
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cliLaunchSecret = process.env.TECHMAP_LAUNCH_SECRET || undefined;
  delete process.env.TECHMAP_LAUNCH_SECRET;
  listen({
    launchSecret: cliLaunchSecret,
  });
}

export { allowedOrigins, defaultPort, frameForWorker, loopbackHost, maximumAudioBytes, parseWorkerEvents, validateCaptionWorkerEvent };
