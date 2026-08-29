import test from 'node:test';
import assert from 'node:assert/strict';
import { diffWorkspace, projectWorkspace, viewContainsItem } from '../domain/workspace/projection.ts';

const item = (id, kind, status, title = id) => ({
  id, kind, status, title, detail: `${title} detail`, confidence: 0.8,
  provenance: 'ai-suggested', evidenceUtteranceIds: [`u-${id}`], links: [],
});
const state = (revision, items) => ({ contractVersion: 1, revision, items, appliedDeltas: [] });

test('workspace projection is deterministic and does not mutate AnalysisState', () => {
  const source = state(4, [
    item('topic', 'topic', 'open'), item('decision-open', 'decision', 'proposed'),
    item('decision-done', 'decision', 'done'), item('risk', 'risk', 'blocked'),
    item('action', 'action', 'open'), item('old', 'question', 'withdrawn'),
  ]);
  const snapshot = structuredClone(source);
  const first = projectWorkspace(source);
  const second = projectWorkspace(source);
  assert.deepEqual(first, second);
  assert.deepEqual(source, snapshot);
  assert.equal(first.currentIssue?.id, 'topic');
  assert.deepEqual(first.decisions.map((column) => column.items.map((entry) => entry.id)), [['decision-open'], [], ['decision-done']]);
  assert.deepEqual(first.actionsAndRisks.map((column) => column.items.map((entry) => entry.id)), [['action'], ['risk'], []]);
  assert.equal(first.activeItems.some((entry) => entry.id === 'old'), false);
});

test('semantic diff reports add, content update and status transition once per revision', () => {
  const before = state(1, [item('decision', 'decision', 'proposed'), item('risk', 'risk', 'open')]);
  const decision = { ...before.items[0], status: 'blocked' };
  const risk = { ...before.items[1], detail: 'updated detail' };
  const after = state(2, [decision, risk, item('action', 'action', 'open')]);
  assert.deepEqual(diffWorkspace(before, after).map((change) => [change.itemId, change.kind]), [
    ['decision', 'status-changed'], ['risk', 'updated'], ['action', 'added'],
  ]);
  assert.deepEqual(diffWorkspace(after, after), []);
});

test('evidence and link ordering are semantically stable', () => {
  const beforeItem = { ...item('decision', 'decision', 'open'), evidenceUtteranceIds: ['u-a', 'u-b'], links: [{ targetId: 'x', relation: 'supports' }, { targetId: 'y', relation: 'depends-on' }] };
  const afterItem = { ...beforeItem, evidenceUtteranceIds: ['u-b', 'u-a'], links: [...beforeItem.links].reverse() };
  assert.deepEqual(diffWorkspace(state(1, [beforeItem]), state(2, [afterItem])), []);
});

test('view containment follows the view projection boundary', () => {
  assert.equal(viewContainsItem('focus', item('claim', 'claim', 'open')), true);
  assert.equal(viewContainsItem('decisions', item('decision', 'decision', 'open')), true);
  assert.equal(viewContainsItem('decisions', item('question', 'question', 'open')), false);
  assert.equal(viewContainsItem('decisions', item('old-decision', 'decision', 'withdrawn')), false);
  assert.equal(viewContainsItem('decisions', item('action', 'action', 'open')), false);
  assert.equal(viewContainsItem('actions-risks', item('risk', 'risk', 'open')), true);
  assert.equal(viewContainsItem('actions-risks', item('question', 'question', 'open')), false);
  assert.equal(viewContainsItem('actions-risks', item('old-action', 'action', 'superseded')), false);
});
