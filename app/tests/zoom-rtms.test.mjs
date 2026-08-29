import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { createZoomRtmsController, zoomWebSocketUrl } from '../../companion/zoom-rtms-bridge.mjs';
import { createZoomWebhookServer } from '../../companion/zoom-webhook-host.mjs';

const nowMs = 1_767_225_600_000;
const webhookSecret = 'synthetic-webhook-secret-for-tests';

class FakeWebSocket {
  static instances = [];
  readyState = 0;
  sent = [];
  #listeners = new Map();

  constructor(url) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type, callback) {
    const callbacks = this.#listeners.get(type) ?? [];
    callbacks.push(callback);
    this.#listeners.set(type, callbacks);
  }

  #emit(type, event = {}) {
    for (const callback of this.#listeners.get(type) ?? []) callback(event);
  }

  open() { this.readyState = 1; this.#emit('open'); }
  receive(value) { this.#emit('message', { data: JSON.stringify(value) }); }
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = 3; }
}

function syntheticCredentials() {
  return {
    async status() { return { configured: true }; },
    async signClient() { return 'a'.repeat(64); },
    async verifyWebhook(timestamp, signature, body) {
      const expected = `v0=${createHmac('sha256', webhookSecret).update(`v0:${timestamp}:`).update(body).digest('hex')}`;
      return signature === expected;
    },
    async signUrlValidation(token) { return createHmac('sha256', webhookSecret).update(token).digest('hex'); },
  };
}

function webhook(event, payload, timestamp = String(Math.floor(nowMs / 1_000))) {
  const body = Buffer.from(JSON.stringify({ event, event_ts: nowMs, payload }));
  const signature = `v0=${createHmac('sha256', webhookSecret).update(`v0:${timestamp}:`).update(body).digest('hex')}`;
  return { body, headers: { 'x-zm-request-timestamp': timestamp, 'x-zm-signature': signature } };
}

function startedPayload() {
  return {
    meeting_uuid: 'synthetic-meeting', meeting_id: '123456789', account_id: 'synthetic-account', operator_id: 'synthetic-operator',
    is_original_host: true, rtms_stream_id: 'synthetic-stream', server_urls: 'wss://rtms.zoom.us/signal', future_optional_field: 'ignored',
  };
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test('Zoom socket destinations fail closed outside the pinned HTTPS-equivalent boundary', () => {
  assert.equal(zoomWebSocketUrl('wss://rtms.zoom.us/signal'), 'wss://rtms.zoom.us/signal');
  assert.throws(() => zoomWebSocketUrl('ws://rtms.zoom.us/signal'), /invalid-zoom-rtms-url/);
  assert.throws(() => zoomWebSocketUrl('wss://zoom.us.evil.example/signal'), /invalid-zoom-rtms-url/);
  assert.throws(() => zoomWebSocketUrl('wss://notzoom.us/signal'), /invalid-zoom-rtms-url/);
  assert.throws(() => zoomWebSocketUrl('wss://user:secret@rtms.zoom.us/signal'), /invalid-zoom-rtms-url/);
  assert.throws(() => zoomWebSocketUrl('wss://127.0.0.1/signal'), /invalid-zoom-rtms-url/);
  assert.throws(() => zoomWebSocketUrl('wss://rtms.zoom.us:444/signal'), /invalid-zoom-rtms-url/);
  assert.throws(() => zoomWebSocketUrl('wss://rtms.zoom.us/signal,wss://example.test/fallback'), /invalid-zoom-rtms-url/);
});

test('signed RTMS start is one-shot armed and emits only normalized aliased transcript events', async () => {
  FakeWebSocket.instances.length = 0;
  const controller = createZoomRtmsController({ credentials: syntheticCredentials(), WebSocketImpl: FakeWebSocket, now: () => nowMs });
  const unarmed = webhook('meeting.rtms_started', startedPayload());
  assert.deepEqual(await controller.handleWebhook(unarmed.headers, unarmed.body), { status: 200, body: { status: 'not-armed' } });
  assert.equal(FakeWebSocket.instances.length, 0);

  const created = await controller.createSession();
  const accepted = webhook('meeting.rtms_started', startedPayload());
  assert.deepEqual(await controller.handleWebhook(accepted.headers, accepted.body), { status: 200, body: { status: 'awaiting-confirmation' } });
  assert.equal(FakeWebSocket.instances.length, 0);
  assert.equal(controller.getEvents(created.sessionId, 0).state, 'awaiting-confirmation');
  assert.deepEqual(controller.confirm(created.sessionId), { state: 'connecting' });
  await nextTurn();
  assert.equal(FakeWebSocket.instances.length, 1);
  const signaling = FakeWebSocket.instances[0];
  signaling.open();
  assert.deepEqual(signaling.sent[0], {
    msg_type: 1, meeting_uuid: 'synthetic-meeting', rtms_stream_id: 'synthetic-stream', signature: 'a'.repeat(64),
  });
  signaling.receive({ msg_type: 2, status_code: 0, media_server: { server_urls: { transcript: 'wss://media.zoom.us/transcript' } } });
  await nextTurn();
  const media = FakeWebSocket.instances[1];
  media.open();
  assert.equal(media.sent[0].media_type, 8);
  assert.equal(Object.hasOwn(media.sent[0], 'audio'), false);
  media.receive({ msg_type: 4, status_code: 0 });
  assert.deepEqual(signaling.sent.at(-1), { msg_type: 7, rtms_stream_id: 'synthetic-stream' });
  media.receive({ msg_type: 12, timestamp: nowMs });
  assert.deepEqual(media.sent.at(-1), { msg_type: 13, timestamp: nowMs });

  const transcript = {
    msg_type: 17,
    content: { user_id: 'private-user-42', user_name: 'Private Example', start_time: nowMs + 50_000, end_time: nowMs + 52_000, timestamp: nowMs + 52_100, language: 1, data: '合成された設計案です', future_optional_field: 'ignored' },
  };
  media.receive(transcript);
  media.receive(transcript);
  media.receive({
    msg_type: 17,
    content: { user_id: 'private-user-99', user_name: 'Other Private', start_time: nowMs + 52_000, end_time: nowMs + 53_000, timestamp: nowMs + 53_100, language: 1, data: '合成された質問です' },
  });
  const events = controller.getEvents(created.sessionId, 0);
  const utterances = events.events.filter((event) => event.type === 'utterance').map((event) => event.utterance);
  assert.equal(utterances.length, 2);
  assert.deepEqual(utterances.map((item) => item.speakerAlias), ['speaker-1', 'speaker-2']);
  assert.deepEqual(utterances.map((item) => [item.startMs, item.endMs]), [[0, 2_000], [2_000, 3_000]]);
  const browserJson = JSON.stringify(events);
  assert.doesNotMatch(browserJson, /private-user|Private Example|Other Private|synthetic-meeting|synthetic-stream/);

  let acknowledgedCursor = events.cursor;
  for (let index = 0; index < 300; index += 1) {
    media.receive({
      msg_type: 17,
      content: { user_id: 'private-user-42', user_name: 'Private Example', start_time: nowMs + 60_000 + index * 1_000,
        end_time: nowMs + 60_500 + index * 1_000, timestamp: nowMs + 60_600 + index * 1_000, language: 1, data: `合成event ${index}` },
    });
    if (index % 20 === 19) {
      const batch = controller.getEvents(created.sessionId, acknowledgedCursor);
      acknowledgedCursor = batch.cursor;
      assert.equal(batch.state, 'active');
    }
  }

  const secondStart = webhook('meeting.rtms_started', startedPayload());
  assert.deepEqual(await controller.handleWebhook(secondStart.headers, secondStart.body), { status: 200, body: { status: 'not-armed' } });
  assert.equal(FakeWebSocket.instances.length, 2);
  controller.stop(created.sessionId);
  assert.equal(controller.getEvents(created.sessionId, 0).stopped, true);
  controller.close();
});

test('a second signed started event before confirmation fails closed as ambiguous', async () => {
  FakeWebSocket.instances.length = 0;
  const controller = createZoomRtmsController({ credentials: syntheticCredentials(), WebSocketImpl: FakeWebSocket, now: () => nowMs });
  const created = await controller.createSession();
  const first = webhook('meeting.rtms_started', startedPayload());
  assert.equal((await controller.handleWebhook(first.headers, first.body)).body.status, 'awaiting-confirmation');
  const second = webhook('meeting.rtms_started', { ...startedPayload(), meeting_uuid: 'another-meeting', rtms_stream_id: 'another-stream' });
  assert.deepEqual(await controller.handleWebhook(second.headers, second.body), { status: 200, body: { status: 'ambiguous' } });
  assert.equal(controller.getEvents(created.sessionId, 0).state, 'degraded');
  assert.throws(() => controller.confirm(created.sessionId), /not-awaiting-confirmation/);
  assert.equal(FakeWebSocket.instances.length, 0);
  controller.close();
});

test('webhook validation rejects bad or stale signatures and supports endpoint validation while unarmed', async () => {
  const controller = createZoomRtmsController({ credentials: syntheticCredentials(), WebSocketImpl: FakeWebSocket, now: () => nowMs });
  const valid = webhook('endpoint.url_validation', { plainToken: 'synthetic-token' });
  const result = await controller.handleWebhook(valid.headers, valid.body);
  assert.equal(result.status, 200);
  assert.equal(result.body.plainToken, 'synthetic-token');
  assert.match(result.body.encryptedToken, /^[a-f0-9]{64}$/);
  assert.equal((await controller.handleWebhook({ ...valid.headers, 'x-zm-signature': `v0=${'0'.repeat(64)}` }, valid.body)).status, 401);
  const stale = webhook('meeting.rtms_started', startedPayload(), String(Math.floor(nowMs / 1_000) - 301));
  assert.equal((await controller.handleWebhook(stale.headers, stale.body)).status, 401);
  controller.close();
});

test('dedicated webhook listener exposes one POST route and never emits CORS', async () => {
  const calls = [];
  const controller = {
    maximumWebhookBytes: 16_384,
    async handleWebhook(headers, body) { calls.push({ headers, body: Buffer.from(body) }); return { status: 200, body: { accepted: true } }; },
  };
  const server = createZoomWebhookServer({ controller });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  const missing = await fetch(`${origin}/v1/bootstrap`, { headers: { Origin: 'https://example.test' } });
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.has('access-control-allow-origin'), false);
  const accepted = await fetch(`${origin}/zoom/webhook`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://example.test' }, body: '{"synthetic":true}',
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.headers.has('access-control-allow-origin'), false);
  assert.equal(calls.length, 1);
  let lastStatus = 0;
  for (let index = 0; index < 61; index += 1) {
    const response = await fetch(`${origin}/zoom/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-zm-request-timestamp': String(Math.floor(nowMs / 1_000)), 'x-zm-signature': `v0=${'0'.repeat(64)}` },
      body: '{"synthetic":true}',
    });
    lastStatus = response.status;
  }
  assert.equal(lastStatus, 429);
  assert.equal(calls.length, 61);
  calls[0].body.fill(0);
  await new Promise((resolve) => server.close(resolve));
});

test('Zoom credentials remain native-only and no environment escape hatch exists', async () => {
  const [nativeSource, signerSource, bridgeSource] = await Promise.all([
    readFile(new URL('../../native/privacy/src/main.cpp', import.meta.url), 'utf8'),
    readFile(new URL('../../companion/zoom-credential-signer.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../../companion/zoom-rtms-bridge.mjs', import.meta.url), 'utf8'),
  ]);
  assert.match(nativeSource, /zoom-webhook-verify/);
  assert.match(nativeSource, /ConstantTimeEqual/);
  assert.match(nativeSource, /zoom-url-validation/);
  assert.doesNotMatch(nativeSource, /zoom-webhook-sign/);
  assert.doesNotMatch(`${signerSource}\n${bridgeSource}`, /process\.env|ZOOM_CLIENT|ZOOM_SECRET|ZOOM_WEBHOOK/);
  assert.doesNotMatch(signerSource, /signWebhook/);
});
