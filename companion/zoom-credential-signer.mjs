import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const maximumOutputBytes = 1024;
const helperTimeoutMs = 5_000;

function defaultHelperPath() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'native', 'privacy', 'build', 'Release', 'techmap-privacy.exe');
}

function exactKeys(value, expected) {
  if (typeof value !== 'object' || value === null) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

export function createZoomCredentialSigner(options = {}) {
  const helperPath = resolve(options.helperPath ?? defaultHelperPath());
  const spawnHelper = options.spawnHelper ?? ((command) => spawn(helperPath, [command], {
    stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
  }));

  async function run(command, value = Buffer.alloc(0)) {
    const input = Buffer.from(value);
    const worker = spawnHelper(command);
    const output = [];
    let outputSize = 0;
    let settled = false;
    return new Promise((resolveRun, rejectRun) => {
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.fill(0);
        for (const chunk of output) chunk.fill(0);
        if (error) rejectRun(error); else resolveRun(result);
      };
      const timer = setTimeout(() => {
        if (!worker.killed) worker.kill();
        finish(new Error('zoom-credential-helper-timeout'));
      }, helperTimeoutMs);
      timer.unref?.();
      worker.on('error', () => finish(new Error('zoom-credential-helper-unavailable')));
      worker.stdout.on('data', (chunk) => {
        if (settled) { chunk.fill(0); return; }
        outputSize += chunk.length;
        if (outputSize > maximumOutputBytes) {
          chunk.fill(0);
          if (!worker.killed) worker.kill();
          finish(new Error('zoom-credential-helper-output-too-large'));
          return;
        }
        output.push(Buffer.from(chunk));
        chunk.fill(0);
      });
      worker.on('close', (code) => {
        if (settled) return;
        const combined = Buffer.concat(output);
        let result;
        try { result = code === 0 ? new TextDecoder('utf-8', { fatal: true }).decode(combined).trim() : null; }
        catch { result = null; }
        combined.fill(0);
        if (typeof result !== 'string') finish(new Error('zoom-credential-helper-failed'));
        else finish(null, result);
      });
      worker.stdin.on('error', () => {
        if (!worker.killed) worker.kill();
        finish(new Error('zoom-credential-helper-input-failed'));
      });
      worker.stdin.end(input);
    });
  }

  return {
    async status() {
      const value = JSON.parse(await run('zoom-credentials-status'));
      if (!exactKeys(value, ['configured']) || typeof value.configured !== 'boolean') throw new Error('invalid-zoom-credential-status');
      return value;
    },
    async signClient(meetingUuid, streamId) {
      if (typeof meetingUuid !== 'string' || typeof streamId !== 'string' || meetingUuid.length < 1 || meetingUuid.length > 256 ||
          streamId.length < 1 || streamId.length > 256 || /[^\x21-\x7e]|,/.test(meetingUuid) || /[^\x21-\x7e]|,/.test(streamId)) {
        throw new Error('invalid-zoom-signature-input');
      }
      const meeting = Buffer.from(meetingUuid, 'utf8');
      const stream = Buffer.from(streamId, 'utf8');
      const framed = Buffer.alloc(4 + meeting.length + stream.length);
      framed.writeUInt16LE(meeting.length, 0);
      meeting.copy(framed, 2);
      framed.writeUInt16LE(stream.length, 2 + meeting.length);
      stream.copy(framed, 4 + meeting.length);
      meeting.fill(0);
      stream.fill(0);
      const signature = await run('zoom-client-signature', framed);
      framed.fill(0);
      if (!/^[a-f0-9]{64}$/.test(signature)) throw new Error('invalid-zoom-client-signature');
      return signature;
    },
    async verifyWebhook(timestamp, signature, body) {
      if (typeof timestamp !== 'string' || !/^[0-9]{10}$/.test(timestamp) || typeof signature !== 'string' ||
          !/^v0=[a-f0-9]{64}$/.test(signature) || !Buffer.isBuffer(body)) throw new Error('invalid-zoom-webhook-verification-input');
      const framed = Buffer.concat([Buffer.from(timestamp), Buffer.from(signature), body]);
      const value = JSON.parse(await run('zoom-webhook-verify', framed));
      framed.fill(0);
      if (!exactKeys(value, ['valid']) || typeof value.valid !== 'boolean') throw new Error('invalid-zoom-webhook-verification-result');
      return value.valid;
    },
    async signUrlValidation(plainToken) {
      if (typeof plainToken !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(plainToken)) throw new Error('invalid-zoom-url-validation-token');
      const signature = await run('zoom-url-validation', Buffer.from(plainToken));
      if (!/^[a-f0-9]{64}$/.test(signature)) throw new Error('invalid-zoom-url-validation-signature');
      return signature;
    },
  };
}
