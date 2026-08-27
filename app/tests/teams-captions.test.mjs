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

test('OCR capture is consent-gated, selected-region-only, bounded, and memory-only', async () => {
  const root = resolve(testDirectory, '..', '..');
  const main = await readFile(resolve(root, 'native', 'teams-captions', 'src', 'main.cpp'), 'utf8');
  const runtime = await readFile(resolve(root, 'native', 'teams-captions', 'src', 'ocr_runtime.cpp'), 'utf8');
  assert.match(main, /ocr-capture.*--consent-confirmed/s);
  assert.match(main, /--session-proof/);
  const entryPoint = main.slice(main.indexOf('int wmain'), main.indexOf('if (argc == 2 && wcscmp(argv[1], L"contract")'));
  assert.match(entryPoint, /SetProcessDpiAwarenessContext\(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2\)/);
  assert.match(runtime, /GetFileType\(GetStdHandle\(STD_OUTPUT_HANDLE\)\) == FILE_TYPE_PIPE/);
  assert.match(runtime, /GetFileType\(input\) != FILE_TYPE_PIPE/);
  assert.match(runtime, /VerifyCompanionProof/);
  assert.match(runtime, /ParentIsNode/);
  assert.match(runtime, /SetWindowDisplayAffinity\(overlay, WDA_EXCLUDEFROMCAPTURE\)/);
  assert.match(runtime, /const int width = static_cast<int>\(Width\(selection\)\)/);
  assert.match(runtime, /CreateDIBSection/);
  assert.match(runtime, /PrintWindow\(window, memoryDc, PW_RENDERFULLCONTENT\)/);
  assert.doesNotMatch(runtime, /GetDC\((?:nullptr|NULL|0)\)|GetDesktopWindow|GetWindowDC\((?:nullptr|NULL|0)\)|BitBlt/);
  assert.match(runtime, /SelectionPointsBelongToTeams/);
  assert.match(runtime, /CaptureTimeoutMilliseconds/);
  assert.match(runtime, /capture-frame-worker/);
  assert.match(runtime, /ParentIsSameExecutable/);
  const frameWorker = runtime.slice(runtime.indexOf('std::optional<std::vector<unsigned char>> CaptureSelectedBmpBounded'), runtime.indexOf('enum class TesseractResult'));
  assert.match(frameWorker, /PROC_THREAD_ATTRIBUTE_HANDLE_LIST/);
  assert.match(frameWorker, /CREATE_SUSPENDED/);
  assert.match(frameWorker, /AssignProcessToJobObject/);
  assert.match(frameWorker, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/);
  assert.match(frameWorker, /SystemRoot=/);
  assert.doesNotMatch(runtime, /CREATE_ALWAYS|OPEN_ALWAYS|TRUNCATE_EXISTING|OpenClipboard|SetClipboardData|WinHttp|URLDownload|socket\s*\(|send\s*\(/);
});

test('local Tesseract is hash-pinned and runs in a bounded job through memory pipes', async () => {
  const root = resolve(testDirectory, '..', '..');
  const runtime = await readFile(resolve(root, 'native', 'teams-captions', 'src', 'ocr_runtime.cpp'), 'utf8');
  const setup = await readFile(resolve(root, 'scripts', 'setup-tesseract.ps1'), 'utf8');
  assert.match(runtime, /ExpectedTesseractVersion = "5\.5\.3"/);
  assert.match(runtime, /Sha256File\(paths\.executable\)/);
  assert.match(runtime, /Sha256File\(paths\.japanese\)/);
  assert.match(runtime, /Sha256File\(paths\.english\)/);
  assert.match(runtime, /stdin stdout --tessdata-dir/);
  assert.match(runtime, /PROC_THREAD_ATTRIBUTE_HANDLE_LIST/);
  assert.match(runtime, /CREATE_SUSPENDED/);
  assert.match(runtime, /AssignProcessToJobObject/);
  assert.match(runtime, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/);
  assert.match(runtime, /OcrTimeoutMilliseconds/);
  assert.match(runtime, /MaximumOcrOutputBytes/);
  assert.match(setup, /Get-FileHash/);
  assert.match(setup, /Expected Tesseract \$expectedVersion after hash verification/);
  assert.doesNotMatch(setup, /Invoke-WebRequest|Start-BitsTransfer/);
});

test('raw OCR names and TSV are anonymized before framed output', async () => {
  const root = resolve(testDirectory, '..', '..', 'native', 'teams-captions', 'src');
  const speaker = await readFile(resolve(root, 'caption_speaker.h'), 'utf8');
  const runtime = await readFile(resolve(root, 'ocr_runtime.cpp'), 'utf8');
  const outputBoundary = runtime.slice(runtime.indexOf('bool EmitRowEvent'), runtime.indexOf('const char* DecisionReason'));
  assert.match(speaker, /speaker-/);
  assert.match(speaker, /std::fill\(entry\.name\.begin\(\), entry\.name\.end\(\), '\\0'\)/);
  assert.match(runtime, /SecureZeroMemory\(line\.text\.data\(\), line\.text\.size\(\)\)/);
  assert.match(runtime, /SecureZeroMemory\(event\.text\.data\(\), event\.text\.size\(\)\)/);
  assert.ok(runtime.indexOf('bool EmitRowEvent') >= 0);
  assert.ok(runtime.indexOf('const char* DecisionReason') >= 0);
  assert.doesNotMatch(outputBoundary, /displayName|participant|tsv|bitmap|pixels/);
  assert.doesNotMatch(runtime, /std::cerr|fprintf\s*\(\s*stderr|OutputDebugString/);
});
