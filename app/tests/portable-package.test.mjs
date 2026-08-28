import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

test('portable build pins official Node and assembles an explicit privacy-safe allowlist', async () => {
  const source = await read('scripts/build-portable-windows.ps1');
  assert.match(source, /nodeVersion = '22\.23\.2'/);
  assert.match(source, /https:\/\/nodejs\.org\/dist\/v\$nodeVersion/);
  assert.match(source, /1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97/);
  assert.match(source, /Pinned Node\.js archive SHA-256 verification failed/);
  assert.match(source, /app\\dist\\standalone/);
  for (const helper of ['techmap-privacy.exe', 'techmap-captions.exe', 'techmap-transcriber.exe', 'techmap-audio.exe']) {
    assert.match(source, new RegExp(helper.replace('.', '\\.')));
  }
  assert.match(source, /data\/local/);
  assert.match(source, /OpenAI-style credential pattern rejected/);
  assert.doesNotMatch(source, /Copy-PortableDirectory \$repositoryRoot/);
});

test('portable launcher verifies every packaged file before offline OCR setup and loopback launch', async () => {
  const [portable, launcher, mvp, config] = await Promise.all([
    read('scripts/start-portable.ps1'),
    read('TechMapLive.cmd'),
    read('scripts/start-mvp.ps1'),
    read('app/next.config.ts'),
  ]);
  assert.match(portable, /Get-FileHash[\s\S]*Portable package hash verification failed/);
  assert.match(portable, /Portable package contains files that are not covered by its manifest/);
  assert.match(portable, /if \(-not \(Test-Path -LiteralPath \$localOcr\)\)/);
  assert.doesNotMatch(portable, /-Replace/);
  assert.match(portable, /TECHMAP_PORTABLE_ROOT/);
  assert.match(launcher, /-NoProfile -ExecutionPolicy Bypass -File/);
  assert.match(mvp, /HOST = '127\.0\.0\.1'/);
  assert.match(mvp, /PORT = '3000'/);
  assert.match(config, /TECHMAP_STANDALONE_BUILD === '1' \? 'standalone' : undefined/);
});

test('portable workflow keeps provenance privilege separate from the build job', async () => {
  const workflow = await read('.github/workflows/portable-windows.yml');
  const build = workflow.slice(workflow.indexOf('  build-portable:'), workflow.indexOf('  attest-portable:'));
  const attest = workflow.slice(workflow.indexOf('  attest-portable:'));
  assert.match(build, /permissions:\s+contents: read/);
  assert.doesNotMatch(build, /id-token: write|attestations: write/);
  assert.match(build, /test-portable-package\.ps1/);
  assert.match(build, /test-native-portability\.ps1/);
  assert.match(build, /retention-days: 14/);
  assert.match(attest, /github\.event_name != 'pull_request'/);
  assert.match(attest, /github\.ref == 'refs\/heads\/main'/);
  assert.match(attest, /actions\/attest@[0-9a-f]{40}/);
});

test('every packaged native project statically links the Visual C++ runtime', async () => {
  for (const project of ['privacy', 'teams-captions', 'transcription', 'windows-audio']) {
    const cmake = await read(`native/${project}/CMakeLists.txt`);
    assert.match(cmake, /cmake_policy\(SET CMP0091 NEW\)/);
    assert.match(cmake, /CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded\$<\$<CONFIG:Debug>:Debug>"/);
  }
  const transcription = await read('native/transcription/CMakeLists.txt');
  assert.match(transcription, /set\(GGML_OPENMP OFF CACHE BOOL "" FORCE\)/);
});
