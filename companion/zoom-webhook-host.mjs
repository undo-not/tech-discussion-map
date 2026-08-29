import { createServer } from 'node:http';

const loopbackHost = '127.0.0.1';
const defaultZoomWebhookPort = 43118;
const zoomWebhookPath = '/zoom/webhook';
const maximumVerificationAttemptsPerMinute = 60;
const maximumConcurrentVerifications = 2;

function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

function readBody(request, maximumBytes) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > maximumBytes) {
        rejectBody(new Error('request-too-large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolveBody(Buffer.concat(chunks)));
    request.on('error', rejectBody);
  });
}

export function createZoomWebhookServer(options = {}) {
  const controller = options.controller;
  if (!controller || typeof controller.handleWebhook !== 'function' || !Number.isSafeInteger(controller.maximumWebhookBytes)) {
    throw new Error('zoom-webhook-controller-required');
  }
  const now = options.now ?? Date.now;
  let verificationWindowStart = now();
  let verificationAttempts = 0;
  let concurrentVerifications = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method !== 'POST' || url.pathname !== zoomWebhookPath || url.search !== '') {
      return sendJson(response, 404, { error: 'not-found' });
    }
    if (!(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
      return sendJson(response, 415, { error: 'zoom-webhook-content-type-required' });
    }
    const body = await readBody(request, controller.maximumWebhookBytes).catch(() => null);
    if (!body) return sendJson(response, 413, { error: 'zoom-webhook-too-large' });
    const timestamp = request.headers['x-zm-request-timestamp'];
    const signature = request.headers['x-zm-signature'];
    const reachesNativeVerification = typeof timestamp === 'string' && /^[0-9]{10}$/.test(timestamp) &&
      typeof signature === 'string' && /^v0=[a-f0-9]{64}$/.test(signature);
    const requestTime = now();
    if (requestTime - verificationWindowStart >= 60_000) { verificationWindowStart = requestTime; verificationAttempts = 0; }
    if (reachesNativeVerification && (verificationAttempts >= maximumVerificationAttemptsPerMinute || concurrentVerifications >= maximumConcurrentVerifications)) {
      body.fill(0);
      return sendJson(response, 429, { error: 'zoom-webhook-verification-rate-limited' });
    }
    if (reachesNativeVerification) { verificationAttempts += 1; concurrentVerifications += 1; }
    try {
      const result = await controller.handleWebhook(request.headers, body);
      body.fill(0);
      return sendJson(response, result.status, result.body);
    } catch {
      body.fill(0);
      return sendJson(response, 503, { error: 'zoom-webhook-unavailable' });
    } finally { if (reachesNativeVerification) concurrentVerifications -= 1; }
  });
  server.headersTimeout = 5_000;
  server.requestTimeout = 5_000;
  server.keepAliveTimeout = 1_000;
  server.maxRequestsPerSocket = 10;
  server.maxConnections = 64;
  return server;
}

export { defaultZoomWebhookPort, loopbackHost, maximumConcurrentVerifications, maximumVerificationAttemptsPerMinute, zoomWebhookPath };
