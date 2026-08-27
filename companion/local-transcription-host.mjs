import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const loopbackHost = '127.0.0.1';
const defaultPort = 43117;
const maximumJsonBytes = 4 * 1024;
const maximumAudioBytes = 128 * 1024;
const maximumWorkerFrameBytes = 64 * 1024;
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
  const tokens = new Map();
  const sessions = new Map();

  if (!pathIsWithin(defaults.modelRoot, modelPath)) throw new Error('Model must remain under LocalAppData\\TechMapLive\\models');

  const server = createServer(async (request, response) => {
    const origin = request.headers.origin;
    if (!origin || !allowedOrigins.has(origin)) return sendJson(response, 403, { error: 'origin-not-allowed' });
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Max-Age': '600',
        Vary: 'Origin',
      });
      return response.end();
    }

    const url = new URL(request.url ?? '/', `http://${loopbackHost}`);
    if (request.method === 'POST' && url.pathname === '/v1/bootstrap') {
      const body = await readBody(request, maximumJsonBytes).catch(() => null);
      if (!body || request.headers['content-type'] !== 'application/json') return sendJson(response, 400, { error: 'invalid-request' }, origin);
      for (const [token, entry] of tokens) if (entry.expiresAt < Date.now()) tokens.delete(token);
      while (tokens.size >= 32) tokens.delete(tokens.keys().next().value);
      const token = randomBytes(32).toString('hex');
      tokens.set(token, { origin, expiresAt: Date.now() + tokenLifetimeMs });
      return sendJson(response, 200, { token }, origin);
    }

    const authorization = request.headers.authorization;
    const actualToken = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
    const tokenEntry = [...tokens.entries()].find(([token]) => tokenMatches(token, actualToken));
    if (!tokenEntry || tokenEntry[1].origin !== origin || tokenEntry[1].expiresAt < Date.now()) {
      return sendJson(response, 401, { error: 'unauthorized' }, origin);
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
  const server = createCompanionServer(options);
  const port = options.port ?? defaultPort;
  server.listen(port, loopbackHost, () => process.stdout.write(`TechMap local transcription ready on http://${loopbackHost}:${port}\n`));
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) listen();

export { allowedOrigins, defaultPort, frameForWorker, loopbackHost, maximumAudioBytes, parseWorkerEvents };
