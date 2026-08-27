import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const testDirectory = fileURLToPath(new URL('.', import.meta.url));

test('content-free Teams probe checks roots without traversing or reading accessible text', async () => {
  const source = await readFile(resolve(testDirectory, '..', '..', 'native', 'teams-captions', 'src', 'main.cpp'), 'utf8');
  const probe = source.slice(source.indexOf('DWORD RunProbeWorker'), source.indexOf('std::size_t SecureLengthAndFree'));
  assert.doesNotMatch(probe, /CurrentName|CurrentValue|TextPattern|GetText|GetCursorPos|WindowText|TreeWalker|FindAll/);
  assert.match(probe, /ElementFromHandle/);
  assert.doesNotMatch(probe, /WriteText/);
});

test('cursor probe requires consent, validates Teams process, and emits metadata only', async () => {
  const source = await readFile(resolve(testDirectory, '..', '..', 'native', 'teams-captions', 'src', 'main.cpp'), 'utf8');
  const cursorProbe = source.slice(source.indexOf('DWORD RunProbeAtCursorWorker'), source.indexOf('int EmitSimpleState'));
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
  assert.match(bounded, /ProbeTimeoutMilliseconds/);
  assert.match(bounded, /CreateProcessW/);
  assert.match(bounded, /TerminateProcess/);
  assert.match(bounded, /probe-timeout/);
});
