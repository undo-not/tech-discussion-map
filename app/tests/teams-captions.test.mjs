import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const testDirectory = fileURLToPath(new URL('.', import.meta.url));

test('content-free Teams probe checks roots without traversing or reading accessible text', async () => {
  const source = await readFile(resolve(testDirectory, '..', '..', 'native', 'teams-captions', 'src', 'main.cpp'), 'utf8');
  const probe = source.slice(source.indexOf('DWORD RunProbeWorker'), source.indexOf('std::size_t SecureLengthAndFree'));
  assert.ok(source.indexOf('DWORD RunProbeWorker') >= 0);
  assert.ok(source.indexOf('std::size_t SecureLengthAndFree') >= 0);
  assert.doesNotMatch(probe, /CurrentName|CurrentValue|TextPattern|GetText|GetCursorPos|WindowText|TreeWalker|FindAll/);
  assert.match(probe, /ElementFromHandle/);
  assert.doesNotMatch(probe, /WriteText/);
});

test('cursor probe requires consent, validates Teams process, and emits metadata only', async () => {
  const source = await readFile(resolve(testDirectory, '..', '..', 'native', 'teams-captions', 'src', 'main.cpp'), 'utf8');
  const cursorProbe = source.slice(source.indexOf('DWORD RunProbeAtCursorWorker'), source.indexOf('int EmitSimpleState'));
  assert.ok(source.indexOf('DWORD RunProbeAtCursorWorker') >= 0);
  assert.ok(source.indexOf('int EmitSimpleState') >= 0);
  assert.match(cursorProbe, /IsExpectedTeamsProcess/);
  assert.match(cursorProbe, /SecureLengthAndFree/);
  assert.doesNotMatch(cursorProbe, /WriteText/);
  assert.match(source, /if \(!consentConfirmed\) return EmitSimpleState\("consent-required"\)/);
  assert.match(source, /probe-at-cursor-worker --consent-confirmed/);
  assert.match(source, /argc == 3.*probe-at-cursor-worker.*--consent-confirmed/);
  assert.doesNotMatch(source, /\\\"(?:name|text)Characters\\\"/);
  assert.doesNotMatch(source, /CreateFile|WriteFile|fopen|ofstream|WinHttp|URLDownload|send\s*\(/);
});

test('all UI Automation calls run in a disposable worker with a hard timeout', async () => {
  const source = await readFile(resolve(testDirectory, '..', '..', 'native', 'teams-captions', 'src', 'main.cpp'), 'utf8');
  const bounded = source.slice(source.indexOf('int RunBoundedWorker'), source.indexOf('void PrintUsage'));
  assert.ok(source.indexOf('int RunBoundedWorker') >= 0);
  assert.ok(source.indexOf('void PrintUsage') >= 0);
  assert.match(bounded, /ProbeTimeoutMilliseconds/);
  assert.match(bounded, /CreateProcessW/);
  assert.match(bounded, /TerminateProcess/);
  assert.match(bounded, /probe-timeout/);
});

test('cursor worker crash codes cannot be decoded as success flags', async () => {
  const source = await readFile(resolve(testDirectory, '..', '..', 'native', 'teams-captions', 'src', 'main.cpp'), 'utf8');
  assert.match(source, /result < CursorSuccessBase \|\| result > CursorSuccessBase \+ 63/);
  assert.match(source, /const DWORD flags = result - CursorSuccessBase/);
});
