import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const testDirectory = fileURLToPath(new URL('.', import.meta.url));

test('content-free Teams probe checks roots without traversing or reading accessible text', async () => {
  const source = await readFile(resolve(testDirectory, '..', '..', 'native', 'teams-captions', 'src', 'main.cpp'), 'utf8');
  const probe = source.slice(source.indexOf('int RunProbe(IUIAutomation* automation)'), source.indexOf('std::size_t SecureLengthAndFree'));
  assert.doesNotMatch(probe, /CurrentName|CurrentValue|TextPattern|GetText|GetCursorPos|WindowText|TreeWalker|FindAll/);
  assert.match(probe, /contentInspected\\\":false/);
  assert.match(probe, /ElementFromHandle/);
});

test('cursor probe requires consent, validates Teams process, and emits metadata only', async () => {
  const source = await readFile(resolve(testDirectory, '..', '..', 'native', 'teams-captions', 'src', 'main.cpp'), 'utf8');
  const cursorProbe = source.slice(source.indexOf('int RunProbeAtCursor'), source.indexOf('void PrintUsage'));
  assert.match(cursorProbe, /if \(!consentConfirmed\)/);
  assert.match(cursorProbe, /IsExpectedTeamsProcess/);
  assert.match(cursorProbe, /SecureLengthAndFree/);
  assert.match(cursorProbe, /contentEmitted\\\":false/);
  assert.doesNotMatch(cursorProbe, /\\\"(?:name|text)Characters\\\"/);
  assert.doesNotMatch(cursorProbe, /WriteText\([^)]*(?:name|text)\)/);
  assert.doesNotMatch(source, /CreateFile|WriteFile|fopen|ofstream|WinHttp|URLDownload|send\s*\(/);
});
