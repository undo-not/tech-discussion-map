import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analysisStateToMermaid } from '../domain/export/mermaid.ts';

const item = (id, kind, title, links = []) => ({
  id, kind, title, detail: `${title} detail`, status: 'open', confidence: 0.8,
  provenance: 'ai-suggested', evidenceUtteranceIds: [`u-${id}`], links,
});

test('Mermaid export uses deterministic synthetic node ids and preserves valid relations', () => {
  const source = analysisStateToMermaid({
    contractVersion: 1, revision: 1, appliedDeltas: [],
    items: [item('raw-id', 'topic', '中心論点', [{ targetId: 'decision', relation: 'supports' }]), item('decision', 'decision', '採用する')],
  });
  assert.equal(source, 'flowchart LR\n  n0["論点・open: 中心論点"]\n  n1["決定・open: 採用する"]\n  n0 -->|supports| n1\n');
  assert.doesNotMatch(source, /raw-id/);
});

test('Mermaid export escapes label syntax and ignores unresolved links', () => {
  const source = analysisStateToMermaid({
    contractVersion: 1, revision: 1, appliedDeltas: [],
    items: [item('topic', 'topic', 'A "quoted" <topic>', [{ targetId: 'missing', relation: 'answers' }])],
  });
  assert.match(source, /A &quot;quoted&quot; &lt;topic&gt;/);
  assert.doesNotMatch(source, /missing|-->/);
});
