import { createHash, randomUUID } from 'node:crypto';

const maximumWebhookBytes = 16 * 1024;
const maximumSocketMessageBytes = 64 * 1024;
const webhookClockSkewSeconds = 5 * 60;
const maximumTranscriptCharacters = 8_000;
const maximumSpeakerAliases = 999;
const maximumEvents = 256;
const maximumSeenPackets = 512;
const armedSessionLifetimeMs = 15 * 60 * 1_000;

function exactKeys(value, expected) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function parseJsonBuffer(value, maximumBytes) {
  if (!Buffer.isBuffer(value) || value.length === 0 || value.length > maximumBytes) throw new Error('zoom-payload-out-of-bounds');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value));
}

function boundedOpaque(value, maximum = 256) {
  return (typeof value === 'string' || Number.isSafeInteger(value)) && String(value).length > 0 && String(value).length <= maximum;
}

function zoomWebSocketUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) throw new Error('invalid-zoom-rtms-url');
  const candidates = value.split(',').map((candidate) => candidate.trim());
  if (candidates.length === 0 || candidates.some((candidate) => candidate.length === 0)) throw new Error('invalid-zoom-rtms-url');
  const urls = candidates.map((candidate) => new URL(candidate));
  for (const url of urls) {
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== 'wss:' || (url.port !== '' && url.port !== '443') || url.username || url.password ||
        url.hash || url.pathname.length > 1_024 || !(hostname === 'zoom.us' || hostname.endsWith('.zoom.us'))) throw new Error('invalid-zoom-rtms-url');
  }
  return urls[0].toString();
}

function hashOpaque(...values) {
  return createHash('sha256').update(values.map((value) => String(value)).join('\u0000')).digest('hex');
}

function socketText(data) {
  if (typeof data === 'string') {
    if (Buffer.byteLength(data) > maximumSocketMessageBytes) throw new Error('zoom-socket-message-too-large');
    return data;
  }
  const buffer = data instanceof ArrayBuffer ? Buffer.from(data) : ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : null;
  if (!buffer || buffer.length === 0 || buffer.length > maximumSocketMessageBytes) throw new Error('invalid-zoom-socket-message');
  return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
}

function validateStartedPayload(payload) {
  const expected = ['account_id', 'is_original_host', 'meeting_id', 'meeting_uuid', 'operator_id', 'rtms_stream_id', 'server_urls'];
  if (!exactKeys(payload, expected) || !boundedOpaque(payload.meeting_uuid) || !boundedOpaque(payload.rtms_stream_id) ||
      !boundedOpaque(payload.meeting_id) || !boundedOpaque(payload.account_id) || !boundedOpaque(payload.operator_id) ||
      typeof payload.is_original_host !== 'boolean' || typeof payload.server_urls !== 'string') throw new Error('invalid-zoom-started-event');
  zoomWebSocketUrl(payload.server_urls);
  return payload;
}

function validateStoppedPayload(payload) {
  if (!exactKeys(payload, ['meeting_uuid', 'rtms_stream_id', 'stop_reason']) || !boundedOpaque(payload.meeting_uuid) ||
      !boundedOpaque(payload.rtms_stream_id) || !Number.isSafeInteger(payload.stop_reason)) throw new Error('invalid-zoom-stopped-event');
  return payload;
}

function validateInterruptedPayload(payload) {
  const keys = Object.keys(payload ?? {}).sort();
  const expected = keys.includes('server_urls') ? ['meeting_uuid', 'rtms_stream_id', 'server_urls'] : ['meeting_uuid', 'rtms_stream_id'];
  if (!exactKeys(payload, expected) || !boundedOpaque(payload.meeting_uuid) || !boundedOpaque(payload.rtms_stream_id) ||
      (payload.server_urls !== undefined && typeof payload.server_urls !== 'string')) throw new Error('invalid-zoom-interrupted-event');
  if (payload.server_urls !== undefined) zoomWebSocketUrl(payload.server_urls);
  return payload;
}

function validateBrowserEvent(value) {
  if (value?.type === 'state') {
    if (!exactKeys(value, ['reason', 'state', 'type']) || !['waiting', 'connecting', 'active', 'paused', 'degraded', 'stopped'].includes(value.state) ||
        typeof value.reason !== 'string' || value.reason.length === 0 || value.reason.length > 64) throw new Error('invalid-zoom-browser-state');
    return structuredClone(value);
  }
  if (value?.type === 'utterance') {
    const utterance = value.utterance;
    if (!exactKeys(value, ['type', 'utterance']) || !exactKeys(utterance, ['endMs', 'id', 'phase', 'revision', 'source', 'speaker', 'speakerAlias', 'startMs', 'text']) ||
        !/^zoom-[0-9]{6,}$/.test(utterance.id) || utterance.revision !== 1 || utterance.phase !== 'final' || utterance.source !== 'zoom-rtms' ||
        utterance.speaker !== 'displayed-alias' || !/^speaker-[1-9][0-9]{0,2}$/.test(utterance.speakerAlias) ||
        !Number.isSafeInteger(utterance.startMs) || !Number.isSafeInteger(utterance.endMs) || utterance.startMs < 0 || utterance.endMs < utterance.startMs ||
        typeof utterance.text !== 'string' || utterance.text.length === 0 || utterance.text.length > maximumTranscriptCharacters) throw new Error('invalid-zoom-browser-utterance');
    return structuredClone(value);
  }
  throw new Error('invalid-zoom-browser-event');
}

export function createZoomRtmsController(options) {
  if (!options?.credentials) throw new Error('zoom-credentials-required');
  const credentials = options.credentials;
  const WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket;
  if (typeof WebSocketImpl !== 'function') throw new Error('zoom-websocket-unavailable');
  const now = options.now ?? Date.now;
  const sessions = new Map();

  const push = (session, value) => {
    if (session.stopped) return;
    const safeValue = validateBrowserEvent(value);
    if (session.events.length >= maximumEvents) {
      closeSocket(session.mediaSocket);
      closeSocket(session.signalingSocket);
      session.mediaSocket = null;
      session.signalingSocket = null;
      session.aliases.clear();
      session.seenPackets.clear();
      session.events.length = 0;
      session.state = 'degraded';
      session.generation += 1;
      session.cursor += 1;
      session.events.push({ cursor: session.cursor, value: { type: 'state', state: 'degraded', reason: 'event-buffer-overflow' } });
      return;
    }
    session.cursor += 1;
    session.events.push({ cursor: session.cursor, value: safeValue });
  };

  const pushState = (session, state, reason) => {
    session.state = state;
    push(session, { type: 'state', state, reason });
  };

  const closeSocket = (socket) => {
    try { if (socket && socket.readyState < 2) socket.close(1000, 'local-stop'); }
    catch { /* best-effort close; state still fails closed below */ }
  };

  const stopSession = (session, emitState = false, reason = 'user-stopped') => {
    if (session.stopped) return;
    if (session.armTimer) clearTimeout(session.armTimer);
    closeSocket(session.mediaSocket);
    closeSocket(session.signalingSocket);
    session.mediaSocket = null;
    session.signalingSocket = null;
    session.aliases.clear();
    session.aliasSalt = '';
    session.seenPackets.clear();
    session.events.length = 0;
    session.stopped = true;
    session.state = 'stopped';
    session.generation += 1;
    if (emitState) {
      session.stopped = false;
      pushState(session, 'stopped', reason);
      session.stopped = true;
    }
    setTimeout(() => sessions.delete(session.id), 60_000).unref?.();
  };

  const degrade = (session, reason) => {
    if (session.stopped) return;
    closeSocket(session.mediaSocket);
    closeSocket(session.signalingSocket);
    session.mediaSocket = null;
    session.signalingSocket = null;
    session.aliases.clear();
    session.seenPackets.clear();
    pushState(session, 'degraded', reason);
    session.generation += 1;
  };

  const send = (socket, value) => {
    if (!socket || socket.readyState !== 1) throw new Error('zoom-socket-not-open');
    socket.send(JSON.stringify(value));
  };

  const transcriptUtterance = (session, content) => {
    const expected = ['data', 'end_time', 'language', 'start_time', 'timestamp', 'user_id', 'user_name'];
    if (!exactKeys(content, expected) || !boundedOpaque(content.user_id) || typeof content.user_name !== 'string' || content.user_name.length > 512 ||
        !Number.isSafeInteger(content.start_time) || !Number.isSafeInteger(content.end_time) || content.end_time < content.start_time ||
        !Number.isSafeInteger(content.timestamp) || !Number.isSafeInteger(content.language) || typeof content.data !== 'string') {
      throw new Error('invalid-zoom-transcript-packet');
    }
    const text = content.data.trim();
    if (text.length === 0 || text.length > maximumTranscriptCharacters) throw new Error('invalid-zoom-transcript-packet');
    const packetDigest = hashOpaque(content.user_id, content.start_time, content.end_time, content.timestamp, text);
    if (session.seenPackets.has(packetDigest)) return null;
    session.seenPackets.add(packetDigest);
    while (session.seenPackets.size > maximumSeenPackets) session.seenPackets.delete(session.seenPackets.values().next().value);
    const speakerKey = hashOpaque(session.aliasSalt, content.user_id);
    let alias = session.aliases.get(speakerKey);
    if (!alias) {
      if (session.aliases.size >= maximumSpeakerAliases) throw new Error('zoom-speaker-limit-exceeded');
      alias = `speaker-${session.aliases.size + 1}`;
      session.aliases.set(speakerKey, alias);
    }
    if (session.originMs === null) session.originMs = content.start_time;
    const startMs = Math.max(0, content.start_time - session.originMs);
    const endMs = Math.max(startMs, content.end_time - session.originMs);
    if (endMs > 24 * 60 * 60 * 1_000) throw new Error('zoom-transcript-time-out-of-bounds');
    session.utteranceSequence += 1;
    return {
      id: `zoom-${String(session.utteranceSequence).padStart(6, '0')}`,
      revision: 1,
      phase: 'final',
      source: 'zoom-rtms',
      speaker: 'displayed-alias',
      speakerAlias: alias,
      startMs,
      endMs,
      text,
    };
  };

  const attachCommonHandlers = (session, socket, generation, messageHandler) => {
    socket.addEventListener('message', (event) => {
      if (session.stopped || session.generation !== generation) return;
      try { messageHandler(JSON.parse(socketText(event.data))); }
      catch { degrade(session, 'invalid-rtms-message'); }
    });
    socket.addEventListener('error', () => {
      if (!session.stopped && session.generation === generation) degrade(session, 'rtms-connection-failed');
    });
    socket.addEventListener('close', () => {
      if (!session.stopped && session.generation === generation && session.state !== 'degraded') degrade(session, 'rtms-connection-closed');
    });
  };

  const openMedia = async (session, generation, mediaUrl, meetingUuid, streamId, signature) => {
    const validatedMediaUrl = zoomWebSocketUrl(mediaUrl);
    if (session.stopped || session.generation !== generation) return;
    const mediaSocket = new WebSocketImpl(validatedMediaUrl);
    session.mediaSocket = mediaSocket;
    mediaSocket.addEventListener('open', () => {
      if (session.stopped || session.generation !== generation) return closeSocket(mediaSocket);
      try {
        send(mediaSocket, {
          msg_type: 3, protocol_version: 1, sequence: 0, meeting_uuid: meetingUuid,
          rtms_stream_id: streamId, signature, media_type: 8,
        });
      } catch { degrade(session, 'rtms-media-handshake-failed'); }
    });
    attachCommonHandlers(session, mediaSocket, generation, (message) => {
      if (message?.msg_type === 12 && Number.isSafeInteger(message.timestamp)) return send(mediaSocket, { msg_type: 13, timestamp: message.timestamp });
      if (message?.msg_type === 4) {
        if (message.status_code !== 0) throw new Error('zoom-media-handshake-rejected');
        send(session.signalingSocket, { msg_type: 7, rtms_stream_id: streamId });
        pushState(session, 'active', 'transcript-stream-active');
        return;
      }
      if (message?.msg_type === 17) {
        const utterance = transcriptUtterance(session, message.content);
        if (utterance && !session.paused) push(session, { type: 'utterance', utterance });
      }
    });
  };

  const connect = async (session, payload) => {
    if (session.stopped || !['waiting', 'degraded'].includes(session.state)) return;
    const generation = ++session.generation;
    pushState(session, 'connecting', 'signed-stream-announced');
    const meetingUuid = String(payload.meeting_uuid);
    const streamId = String(payload.rtms_stream_id);
    session.streamKey = hashOpaque(meetingUuid, streamId);
    const signature = await credentials.signClient(meetingUuid, streamId);
    if (session.stopped || session.generation !== generation) return;
    const signalingSocket = new WebSocketImpl(zoomWebSocketUrl(payload.server_urls));
    session.signalingSocket = signalingSocket;
    signalingSocket.addEventListener('open', () => {
      if (session.stopped || session.generation !== generation) return closeSocket(signalingSocket);
      try { send(signalingSocket, { msg_type: 1, meeting_uuid: meetingUuid, rtms_stream_id: streamId, signature }); }
      catch { degrade(session, 'rtms-signaling-handshake-failed'); }
    });
    attachCommonHandlers(session, signalingSocket, generation, (message) => {
      if (message?.msg_type === 12 && Number.isSafeInteger(message.timestamp)) return send(signalingSocket, { msg_type: 13, timestamp: message.timestamp });
      if (message?.msg_type !== 2) return;
      if (message.status_code !== 0 || typeof message.media_server?.server_urls?.transcript !== 'string') throw new Error('zoom-signaling-handshake-rejected');
      void openMedia(session, generation, message.media_server.server_urls.transcript, meetingUuid, streamId, signature)
        .catch(() => degrade(session, 'rtms-media-connection-failed'));
    });
  };

  return {
    maximumWebhookBytes,
    async status() { return credentials.status(); },
    async createSession() {
      const status = await credentials.status();
      if (!status.configured) throw new Error('zoom-credentials-not-configured');
      for (const existing of sessions.values()) if (!existing.stopped) throw new Error('zoom-session-already-active');
      const id = randomUUID();
      const session = {
        id, state: 'waiting', stopped: false, paused: false, stateBeforePause: 'waiting', bound: false, armedUntil: now() + armedSessionLifetimeMs,
        generation: 0, cursor: 0, events: [], aliases: new Map(), seenPackets: new Set(), originMs: null,
        utteranceSequence: 0, signalingSocket: null, mediaSocket: null, streamKey: '', aliasSalt: randomUUID(), armTimer: null,
      };
      session.armTimer = setTimeout(() => {
        if (!session.stopped && !session.bound) degrade(session, 'arm-expired');
      }, armedSessionLifetimeMs);
      session.armTimer.unref?.();
      sessions.set(id, session);
      return { sessionId: id, state: 'waiting' };
    },
    getEvents(id, after) {
      const session = sessions.get(id);
      if (!session) throw new Error('zoom-session-not-found');
      if (!Number.isSafeInteger(after) || after < 0) throw new Error('invalid-zoom-event-cursor');
      return { cursor: session.cursor, events: session.events.filter((event) => event.cursor > after).map((event) => structuredClone(event.value)), state: session.state, stopped: session.stopped };
    },
    pause(id) {
      const session = sessions.get(id);
      if (!session || session.stopped) throw new Error('zoom-session-not-found');
      session.stateBeforePause = session.state;
      session.paused = true;
      pushState(session, 'paused', 'user-paused');
      return { state: 'paused' };
    },
    resume(id) {
      const session = sessions.get(id);
      if (!session || session.stopped || !session.paused) throw new Error('zoom-session-not-paused');
      session.paused = false;
      pushState(session, ['active', 'connecting'].includes(session.stateBeforePause) ? session.stateBeforePause : 'waiting', 'user-resumed');
      return { state: session.state };
    },
    stop(id) {
      const session = sessions.get(id);
      if (!session) throw new Error('zoom-session-not-found');
      stopSession(session);
      return { state: 'stopped' };
    },
    async handleWebhook(headers, body) {
      if (!Buffer.isBuffer(body) || body.length === 0 || body.length > maximumWebhookBytes) return { status: 413, body: { error: 'zoom-webhook-too-large' } };
      const timestamp = headers['x-zm-request-timestamp'];
      const suppliedSignature = headers['x-zm-signature'];
      if (typeof timestamp !== 'string' || !/^[0-9]{10}$/.test(timestamp) || typeof suppliedSignature !== 'string' || !/^v0=[a-f0-9]{64}$/.test(suppliedSignature)) {
        return { status: 401, body: { error: 'zoom-webhook-signature-required' } };
      }
      if (Math.abs(Math.floor(now() / 1_000) - Number(timestamp)) > webhookClockSkewSeconds) return { status: 401, body: { error: 'zoom-webhook-expired' } };
      let verified;
      try { verified = await credentials.verifyWebhook(timestamp, suppliedSignature, body); }
      catch { return { status: 503, body: { error: 'zoom-webhook-verification-unavailable' } }; }
      if (!verified) return { status: 401, body: { error: 'zoom-webhook-signature-invalid' } };
      let event;
      try { event = parseJsonBuffer(body, maximumWebhookBytes); }
      catch { return { status: 400, body: { error: 'invalid-zoom-webhook-json' } }; }
      if (!exactKeys(event, ['event', 'event_ts', 'payload']) || typeof event.event !== 'string' || !Number.isSafeInteger(event.event_ts)) {
        return { status: 400, body: { error: 'invalid-zoom-webhook-event' } };
      }
      if (event.event === 'endpoint.url_validation') {
        if (!exactKeys(event.payload, ['plainToken']) || typeof event.payload.plainToken !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(event.payload.plainToken)) {
          return { status: 400, body: { error: 'invalid-zoom-url-validation' } };
        }
        try { return { status: 200, body: { plainToken: event.payload.plainToken, encryptedToken: await credentials.signUrlValidation(event.payload.plainToken) } }; }
        catch { return { status: 503, body: { error: 'zoom-url-validation-unavailable' } }; }
      }
      if (event.event === 'meeting.rtms_started') {
        let payload;
        try { payload = validateStartedPayload(event.payload); }
        catch { return { status: 400, body: { error: 'invalid-zoom-started-event' } }; }
        const waiting = [...sessions.values()].find((session) => !session.stopped && !session.bound && session.state === 'waiting' && session.armedUntil >= now());
        if (waiting) {
          waiting.bound = true;
          if (waiting.armTimer) { clearTimeout(waiting.armTimer); waiting.armTimer = null; }
          void connect(waiting, payload).catch(() => degrade(waiting, 'rtms-connection-failed'));
        }
        return { status: 200, body: { status: waiting ? 'accepted' : 'not-armed' } };
      }
      if (event.event === 'meeting.rtms_interrupted') {
        let payload;
        try { payload = validateInterruptedPayload(event.payload); }
        catch { return { status: 400, body: { error: 'invalid-zoom-interrupted-event' } }; }
        const streamKey = hashOpaque(payload.meeting_uuid, payload.rtms_stream_id);
        const session = [...sessions.values()].find((candidate) => !candidate.stopped && candidate.bound && candidate.streamKey === streamKey);
        if (session) {
          degrade(session, 'zoom-stream-interrupted');
          if (payload.server_urls) void connect(session, payload).catch(() => degrade(session, 'rtms-reconnect-failed'));
        }
        return { status: 200, body: { status: session ? 'accepted' : 'not-bound' } };
      }
      if (event.event === 'meeting.rtms_stopped') {
        let payload;
        try { payload = validateStoppedPayload(event.payload); }
        catch { return { status: 400, body: { error: 'invalid-zoom-stopped-event' } }; }
        const streamKey = hashOpaque(payload.meeting_uuid, payload.rtms_stream_id);
        const session = [...sessions.values()].find((candidate) => !candidate.stopped && candidate.streamKey === streamKey);
        if (session) stopSession(session, true, 'zoom-stream-stopped');
        return { status: 200, body: { status: 'accepted' } };
      }
      return { status: 400, body: { error: 'zoom-webhook-event-not-allowed' } };
    },
    close() { for (const session of sessions.values()) stopSession(session); sessions.clear(); },
  };
}

export { maximumSocketMessageBytes, maximumWebhookBytes, zoomWebSocketUrl };
