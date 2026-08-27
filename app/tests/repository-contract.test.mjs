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
