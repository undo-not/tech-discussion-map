const launchSecretPattern = /^[a-f0-9]{64}$/;
let launchSecret = '';

function json(status: number, value: unknown): Response {
  if (status === 204) return new Response(null, { status, headers: { 'Cache-Control': 'no-store' } });
  return Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}

function trustedLocalRequest(request: Request): boolean {
  const url = new URL(request.url);
  const expectedOrigin = 'http://127.0.0.1:3000';
  return url.origin === expectedOrigin && request.headers.get('origin') === expectedOrigin && request.headers.get('content-type') === 'application/json';
}

export async function PUT(request: Request): Promise<Response> {
  if (!trustedLocalRequest(request)) return json(403, { error: 'local-launch-origin-required' });
  if (launchSecret) return json(409, { error: 'local-launch-already-provisioned' });
  const text = await request.text();
  if (text.length > 128) return json(400, { error: 'local-launch-provision-rejected' });
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = null; }
  const candidate = typeof body === 'object' && body !== null && Object.keys(body).length === 1 ? (body as { launchSecret?: unknown }).launchSecret : null;
  if (typeof candidate !== 'string' || !launchSecretPattern.test(candidate)) return json(400, { error: 'local-launch-provision-rejected' });
  launchSecret = candidate;
  return json(204, null);
}

export async function POST(request: Request): Promise<Response> {
  if (!trustedLocalRequest(request)) {
    return json(403, { error: 'local-launch-origin-required' });
  }
  const text = await request.text();
  if (text.length > 128) return json(400, { error: 'local-launch-request-rejected' });
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = null; }
  if (typeof body !== 'object' || body === null || Object.keys(body).length !== 1 || (body as { request?: unknown }).request !== 'local-launch-secret') {
    return json(400, { error: 'local-launch-request-rejected' });
  }
  if (!launchSecretPattern.test(launchSecret)) return json(404, { error: 'local-runtime-not-launched' });
  return json(200, { launchSecret });
}
