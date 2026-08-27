import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { assertAllowedRuntimeEgress, assertPrivacySafeResponsesRequest, createPrivacySafeResponsesRequest, openAiAutomaticRetryCount } from '../adapters/privacy/openai-request-policy.ts';
import { createConsentRecord, isConsentRecord } from '../domain/privacy/consent.ts';
import { createMinimalUtteranceWindow, redactText } from '../domain/privacy/redaction.ts';
import { createPrivacyStore, validateStoredSession } from '../../companion/privacy-store.mjs';
import { emptyAnalysisState } from '../domain/analysis/contract.ts';

const appRoot = new URL('../', import.meta.url);

async function runtimeSourceFiles(relativeDirectory) {
  const directory = new URL(`${relativeDirectory}/`, appRoot);
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const relative = `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory()) return runtimeSourceFiles(relative);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [new URL(relative, appRoot)] : [];
  }));
  return nested.flat();
}

function syntheticUtterance(id, text) {
  return { id, revision: 1, phase: 'final', source: 'synthetic', speaker: 'unknown', startMs: 0, endMs: 1000, text };
}

test('consent record is explicit, versioned, and timestamped', () => {
  const consent = createConsentRecord(new Date('2026-08-27T00:00:00.000Z'));
  assert.equal(isConsentRecord(consent), true);
  assert.equal(isConsentRecord({ ...consent, confirmed: false }), false);
  assert.equal(isConsentRecord({ ...consent, scope: 'operator-only' }), false);
});

test('redaction removes synthetic secrets and creates a minimum final-only window', () => {
  const syntheticKey = ['sk', 'proj', 'syntheticonly000000000000'].join('-');
  const result = redactText(`連絡先 user@example.test password=hunter2synthetic key ${syntheticKey} host 192.0.2.44`);
  assert.equal(result.ok, true);
  assert.doesNotMatch(result.text, /user@example|hunter2|192\.0\.2\.44|syntheticonly/);
  assert.equal(result.summary.email, 1);
  assert.equal(result.summary.credential, 1);
  assert.equal(result.summary['api-key'], 1);
  const fullWidth = redactText('連絡先 ｕｓｅｒ＠ｅｘａｍｐｌｅ．ｔｅｓｔ 電話 ０９０－１２３４－５６７８');
  assert.equal(fullWidth.ok, true);
  assert.doesNotMatch(fullWidth.text, /user@example|090/);

  const window = createMinimalUtteranceWindow([
    { ...syntheticUtterance('partial-ignored', '含めない'), phase: 'partial' },
    syntheticUtterance('final-kept', '設計を確定します'),
  ]);
  assert.equal(window.ok, true);
  assert.match(window.text, /final-kept/);
  assert.doesNotMatch(window.text, /partial-ignored/);
});

test('Responses request factory forces stateless minimum-text policy', () => {
  const redacted = redactText('合成された安全な会議window');
  assert.equal(redacted.ok, true);
  const request = createPrivacySafeResponsesRequest('gpt-5-mini', redacted.text);
  assert.equal(request.store, false);
  assert.deepEqual(Object.keys(request).sort(), ['input', 'model', 'store']);
  assertPrivacySafeResponsesRequest(request);
  assert.throws(() => assertPrivacySafeResponsesRequest({ ...request, background: true }), /forbidden field/);
  assert.throws(() => assertPrivacySafeResponsesRequest({ model: request.model, store: false, input: [{ role: 'user', content: [{ type: 'input_audio', text: 'unsafe@example.test' }] }] }), /schema is invalid/);
  assert.equal(assertAllowedRuntimeEgress('https://api.openai.com/v1/responses').hostname, 'api.openai.com');
  assert.throws(() => assertAllowedRuntimeEgress('https://example.com/v1/responses'), /not allowed/);
  assert.equal(openAiAutomaticRetryCount, 0);
});

test('runtime dependencies and URL literals stay within the no-telemetry egress policy', async () => {
  const manifest = JSON.parse(await readFile(new URL('package.json', appRoot), 'utf8'));
  const dependencyNames = Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies });
  assert.deepEqual(dependencyNames.filter((name) => /analytics|amplitude|datadog|newrelic|segment|sentry/i.test(name)), []);

  const files = (await Promise.all(['adapters', 'components', 'domain'].map(runtimeSourceFiles))).flat();
  const externalUrls = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    externalUrls.push(...source.matchAll(/https:\/\/[^'"`\s)]+/g).map((match) => match[0]));
  }
  assert.deepEqual([...new Set(externalUrls)], ['https://api.openai.com/v1/responses']);
});

test('privacy store writes only sealed session data and supports retention/delete', async () => {
  const localAppData = await mkdtemp(join(tmpdir(), 'techmap-privacy-store-'));
  const root = join(localAppData, 'TechMapLive', 'sessions');
  const xor = (buffer) => Buffer.from(buffer.map((value) => value ^ 0xa5));
  const runner = async (command, input = Buffer.alloc(0)) => {
    if (command === 'provision-store') { await mkdir(root, { recursive: true, mode: 0o700 }); return Buffer.from('{"secure":true}'); }
    if (command === 'seal' || command === 'unseal') return xor(input);
    if (command === 'key-status') return Buffer.from('{"configured":false}');
    throw new Error('unexpected-command');
  };
  const store = createPrivacyStore({ environment: { LOCALAPPDATA: localAppData }, runner });
  const now = new Date('2026-08-27T00:00:00.000Z');
  const session = {
    id: '11111111-1111-4111-8111-111111111111', createdAt: now.toISOString(), updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 86_400_000).toISOString(), retentionDays: 1, consent: createConsentRecord(now),
    transcript: [syntheticUtterance('synthetic-1', '公開用の合成発話')], analysis: emptyAnalysisState, state: { capture: 'stopped' },
  };
  await store.save(session);
  const ciphertext = await readFile(join(root, `${session.id}.tmps`));
  assert.doesNotMatch(ciphertext.toString('utf8'), /公開用の合成発話/);
  assert.deepEqual((await store.load(session.id)).transcript, session.transcript);
  assert.equal((await store.list())[0].transcriptCount, 1);
  const corruptId = '22222222-2222-4222-8222-222222222222';
  await writeFile(join(root, `${corruptId}.tmps`), xor(Buffer.from('not-json')));
  assert.equal((await store.list()).find((item) => item.id === corruptId).unreadable, true);
  assert.deepEqual(await store.sweep(new Date('2026-08-29T00:00:00.000Z')), [session.id]);
  assert.equal(await store.remove(session.id), false);
  assert.equal(await store.remove(corruptId), true);
  assert.throws(() => validateStoredSession({ ...session, audio: 'forbidden' }), /invalid-session/);
  assert.throws(() => validateStoredSession({ ...session, analysis: { ...emptyAnalysisState, samples: [1, 2, 3] } }), /invalid-session-analysis/);
  assert.throws(() => validateStoredSession({ ...session, consent: { ...session.consent, operator: 'extra' } }), /invalid-session-consent/);
  await rm(localAppData, { recursive: true, force: true });
});

test('native Responses transport is fixed, direct, bounded, and keeps credential output private', async () => {
  const source = await readFile(new URL('../../native/privacy/src/main.cpp', import.meta.url), 'utf8');
  assert.match(source, /CredReadW\(CredentialTarget\.data\(\)/);
  assert.match(source, /WINHTTP_ACCESS_TYPE_NO_PROXY/);
  assert.match(source, /WinHttpConnect\(session\.get\(\), L"api\.openai\.com"/);
  assert.match(source, /WinHttpOpenRequest\(connection\.get\(\), L"POST", L"\/v1\/responses"/);
  assert.match(source, /WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_2/);
  assert.doesNotMatch(source, /WINHTTP_ACCESS_TYPE_(?:DEFAULT_PROXY|AUTOMATIC_PROXY)/);
  assert.doesNotMatch(source, /WINHTTP_OPTION_SECURITY_FLAGS/);
  assert.doesNotMatch(source, /WriteAll\(key\.data|WriteAll\(authorization\.data/);
});

test('companion transport zeroes the serialized request buffer after native handoff', async () => {
  const localAppData = await mkdtemp(join(tmpdir(), 'techmap-responses-'));
  let handedOff;
  const store = createPrivacyStore({ environment: { LOCALAPPDATA: localAppData }, runner: async (command, input) => {
    assert.equal(command, 'responses');
    handedOff = input;
    return Buffer.from('{"status":"completed","output":[]}');
  } });
  assert.equal((await store.responses({ model: 'synthetic', store: false })).status, 'completed');
  assert.ok(handedOff.every((value) => value === 0));
  await rm(localAppData, { recursive: true, force: true });
});
