import { createServer } from 'node:http';

const loopbackHost = '127.0.0.1';
const defaultZoomWebhookPort = 43118;
const zoomWebhookPath = '/zoom/webhook';

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
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method !== 'POST' || url.pathname !== zoomWebhookPath || url.search !== '') {
      return sendJson(response, 404, { error: 'not-found' });
    }
    if (!(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
      return sendJson(response, 415, { error: 'zoom-webhook-content-type-required' });
    }
    const body = await readBody(request, controller.maximumWebhookBytes).catch(() => null);
    if (!body) return sendJson(response, 413, { error: 'zoom-webhook-too-large' });
    try {
      const result = await controller.handleWebhook(request.headers, body);
      body.fill(0);
      return sendJson(response, result.status, result.body);
    } catch {
      body.fill(0);
      return sendJson(response, 503, { error: 'zoom-webhook-unavailable' });
    }
  });
}

export { defaultZoomWebhookPort, loopbackHost, zoomWebhookPath };
