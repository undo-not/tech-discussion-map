import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import workspace from '../fixtures/workspace.json' with { type: 'json' };

const utteranceIds = new Set(workspace.transcript.map((item) => item.id));
const nodeIds = new Set(workspace.nodes.map((item) => item.id));

test('analysis items and map nodes resolve to source utterances', () => {
  assert.equal(utteranceIds.size, workspace.transcript.length);
  assert.equal(nodeIds.size, workspace.nodes.length);

  for (const item of [...workspace.nodes, ...workspace.insights]) {
    assert.ok(['ai', 'human'].includes(item.source), `${item.id} has unknown source`);
    assert.ok(item.utteranceIds.length > 0, `${item.id} has no evidence`);
    for (const utteranceId of item.utteranceIds) {
      assert.ok(utteranceIds.has(utteranceId), `${item.id} has broken evidence ${utteranceId}`);
    }
  }
});

test('transcript and insight navigation target existing map nodes', () => {
  for (const item of [...workspace.transcript, ...workspace.insights]) {
    assert.ok(nodeIds.has(item.mapNodeId), `${item.id} targets missing node ${item.mapNodeId}`);
  }
});

test('visible insight counts are derived from the fixture categories', () => {
  const counts = workspace.insights.reduce((result, item) => {
    result[item.type] = (result[item.type] ?? 0) + 1;
    return result;
  }, {});

  assert.deepEqual(
    { decision: counts['決定'], question: counts['質問'], action: counts.Action, risk: counts['リスク'] },
    { decision: 1, question: 1, action: 1, risk: 1 },
  );
});

test('review hashes are checkout-independent on Windows', async () => {
  const attributes = await readFile(new URL('../../.gitattributes', import.meta.url), 'utf8');
  assert.match(attributes, /^\* text=auto eol=lf$/m);
});

test('Windows MVP preflight gives one actionable Node.js recovery path', async () => {
  const source = await readFile(new URL('../../scripts/preflight-mvp.ps1', import.meta.url), 'utf8');
  assert.match(source, /Get-Command node -ErrorAction SilentlyContinue/);
  assert.match(source, /Node\.js was not found on PATH\./);
  assert.match(source, /The installed Node\.js version is unsupported:/);
  assert.match(source, /TechMap Live requires Node\.js 22\.18 or later\./);
  assert.match(source, /winget install --id OpenJS\.NodeJS\.LTS --exact/);
  assert.match(source, /close this PowerShell window, open a new one/);
  assert.equal((source.match(/throw \(New-NodeSetupMessage/g) ?? []).length, 3);
});

test('every long-lived local client can renew an idle bearer without changing its session', async () => {
  for (const relativePath of [
    '../adapters/transcription/local-caption-client.ts',
    '../adapters/transcription/local-companion-client.ts',
    '../adapters/audio/local-teams-audio-client.ts',
    '../adapters/privacy/local-privacy-client.ts',
  ]) {
    const source = await readFile(new URL(relativePath, import.meta.url), 'utf8');
    assert.match(source, /getLocalLaunchSecret/);
    assert.match(source, /response\.status === 401/);
    assert.match(source, /this\.#token = ''/);
  }
});
