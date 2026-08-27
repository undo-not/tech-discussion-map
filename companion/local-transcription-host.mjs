import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createPrivacyStore } from './privacy-store.mjs';
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
const tokenLifetimeMs = 10 * 60 * 1000;

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
  state.buffer = Buffer.concat([state.buffer, chunk]);
  const parsed = [];
  while (state.buffer.length >= 12) {
    if (state.buffer.subarray(0, 4).toString('ascii') !== 'TMO1' || state.buffer[4] !== 1 || state.buffer[6] !== 0 || state.buffer[7] !== 0) {
      throw new Error('invalid-worker-protocol');
    }
    const size = state.buffer.readUInt32LE(8);
    if (size > maximumWorkerFrameBytes) throw new Error('worker-frame-too-large');
    if (state.buffer.length < 12 + size) break;
    const type = state.buffer[5];
    const payload = state.buffer.subarray(12, 12 + size);
    state.buffer = state.buffer.subarray(12 + size);
    if (type !== 1) throw new Error('unknown-worker-frame');
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
    parsed.push(value);
  }
  return parsed;
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
  const spawnWorker = options.spawnWorker ?? ((args) => spawn(workerPath, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }));
  const privacyStore = options.privacyStore ?? createPrivacyStore({ environment });
  const launchSecret = options.launchSecret ?? randomBytes(32).toString('hex');
  if (!/^[a-f0-9]{64}$/.test(launchSecret)) throw new Error('invalid-launch-secret');
  const tokens = new Map();
  const sessions = new Map();
  const globalAnalysisBudget = { windowStart: Date.now(), calls: 0 };

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
      for (const [token, entry] of tokens) if (entry.expiresAt < Date.now()) tokens.delete(token);
      while (tokens.size >= 32) tokens.delete(tokens.keys().next().value);
      const token = randomBytes(32).toString('hex');
      tokens.set(token, { origin, expiresAt: Date.now() + tokenLifetimeMs, analysisWindowStart: Date.now(), analysisCalls: 0 });
      return sendJson(response, 200, { token }, origin);
    }

    const authorization = request.headers.authorization;
    const actualToken = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
    const tokenEntry = [...tokens.entries()].find(([token]) => tokenMatches(token, actualToken));
    if (!tokenEntry || tokenEntry[1].origin !== origin || tokenEntry[1].expiresAt < Date.now()) {
      return sendJson(response, 401, { error: 'unauthorized' }, origin);
    }

    if (request.method === 'POST' && url.pathname === '/v1/analysis') {
      const tokenState = tokenEntry[1];
      const body = await readBody(request, maximumAnalysisRequestBytes).catch(() => null);
      let analysisRequest;
      try { analysisRequest = body && request.headers['content-type'] === 'application/json' ? JSON.parse(body.toString('utf8')) : null; assertPrivacySafeResponsesRequest(analysisRequest); }
      catch { return sendJson(response, 400, { error: 'analysis-request-rejected' }, origin); }
      if (JSON.stringify(analysisRequest.text?.format) !== JSON.stringify(analysisStructuredOutput)) return sendJson(response, 400, { error: 'analysis-schema-rejected' }, origin);
      const now = Date.now();
      if (now - tokenState.analysisWindowStart >= 60_000) { tokenState.analysisWindowStart = now; tokenState.analysisCalls = 0; }
      if (now - globalAnalysisBudget.windowStart >= 60_000) { globalAnalysisBudget.windowStart = now; globalAnalysisBudget.calls = 0; }
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

    if (request.method === 'POST' && url.pathname === '/v1/sessions') {
      const body = await readBody(request, maximumJsonBytes).catch(() => null);
      let configuration;
      try { configuration = body ? JSON.parse(body.toString('utf8')) : null; } catch { configuration = null; }
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
      if (!session.worker.stdin.write(frameForWorker(1, audio))) await new Promise((resolveDrain) => session.worker.stdin.once('drain', resolveDrain));
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
      session.worker.stdin.end(frameForWorker(2));
      setTimeout(() => { if (!session.worker.killed) session.worker.kill(); }, 3_000).unref();
      setTimeout(() => sessions.delete(session.id), 60_000).unref();
      return sendJson(response, 200, { state: 'stopped' }, origin);
    }
    return sendJson(response, 404, { error: 'not-found' }, origin);
  });

  server.on('close', () => {
    for (const session of sessions.values()) if (!session.worker.killed) session.worker.kill();
    sessions.clear();
    tokens.clear();
  });
  return server;
}

export function listen(options = {}) {
  const launchSecret = randomBytes(32).toString('hex');
  const server = createCompanionServer({ ...options, launchSecret });
  const port = options.port ?? defaultPort;
  server.listen(port, loopbackHost, () => process.stdout.write(`TechMap local companion ready. Open http://${loopbackHost}:3000/#techmap-launch=${launchSecret}\n`));
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) listen();

export { allowedOrigins, defaultPort, frameForWorker, loopbackHost, maximumAudioBytes, parseWorkerEvents };
