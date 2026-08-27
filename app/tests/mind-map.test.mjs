import assert from 'node:assert/strict';
import { test } from 'node:test';

import { analyzeWithDeterministicMock } from '../adapters/analysis/mock-analyzer.ts';
import { applyAnalysisDelta, emptyAnalysisState, validateAnalysisState } from '../domain/analysis/contract.ts';
import { advanceDegradedViewportTracking, applyHumanItemPatch, canCommitMapEdit, commitAnalysisHistory, createAnalysisHistory, degradedViewportFilterKey, latestRenderedMapItems, mapNodeHeight, maximumHistoryEntries, maximumRenderedNodes, nearestNodeId, reconcileMapLayout, redoAnalysisHistory, resetMapLayout, scrollTargetForNode, scrollTargetForVisibleItems, topAlignedScrollTargetForItems, undoAnalysisHistory, visibleSelectionId } from '../domain/mind-map/workspace.ts';

const utterances = Array.from({ length: 400 }, (_, index) => ({ id: `map-u${index}`, revision: 1, phase: 'final', source: 'synthetic', speaker: 'unknown', startMs: index, endMs: index + 1, text: `合成発話 ${index}` }));
const kinds = ['topic', 'claim', 'question', 'decision', 'action', 'dependency', 'risk'];

function stateWithNodes(count, revision = 0) {
  return validateAnalysisState({
    contractVersion: 1, revision, appliedDeltas: [],
    items: Array.from({ length: count }, (_, index) => ({
      id: `map-node-${index}`, kind: kinds[index % kinds.length], title: `合成node ${index}`, detail: `詳細 ${index}`,
      status: 'open', confidence: 0.8, provenance: 'ai-suggested', evidenceUtteranceIds: [`map-u${index}`], links: [],
    })),
  }, utterances);
}

test('incremental layout preserves unrelated positions and supports 100 nodes', () => {
  const hundred = stateWithNodes(maximumRenderedNodes);
  const first = reconcileMapLayout({ positions: {} }, hundred);
  assert.equal(Object.keys(first.positions).length, 100);
  const before = structuredClone(first.positions);
  const updated = structuredClone(hundred);
  updated.items[25].title = '人が編集したtitle';
  updated.revision += 1;
  const second = reconcileMapLayout(first, updated);
  assert.deepEqual(second.positions, before);
  assert.equal(second, first);
});

test('new nodes receive deterministic free slots without moving existing nodes', () => {
  const initial = stateWithNodes(6);
  const first = reconcileMapLayout({ positions: {} }, initial);
  const expanded = stateWithNodes(7, 1);
  const second = reconcileMapLayout(first, expanded);
  for (const item of initial.items) assert.deepEqual(second.positions[item.id], first.positions[item.id]);
  assert.ok(second.positions['map-node-6']);
  assert.deepEqual(reconcileMapLayout(first, expanded), second);
});

test('manual edits and analysis commits share bounded undo and redo history', () => {
  const initial = stateWithNodes(2);
  let history = createAnalysisHistory(initial);
  const edited = applyHumanItemPatch(history.present, 'map-node-0', { title: '人が確定したtitle', detail: '人が編集したdetail' }, utterances);
  assert.equal(edited.items[0].provenance, 'human-edited');
  history = commitAnalysisHistory(history, edited);
  const analyzed = structuredClone(history.present);
  analyzed.items[1].title = 'AI差分後';
  analyzed.revision += 1;
  history = commitAnalysisHistory(history, validateAnalysisState(analyzed, utterances));
  const revisionBeforeUndo = history.present.revision;
  history = undoAnalysisHistory(history, utterances);
  assert.equal(history.present.items[1].title, '合成node 1');
  assert.equal(history.present.revision, revisionBeforeUndo + 1);
  history = undoAnalysisHistory(history, utterances);
  assert.equal(history.present.items[0].provenance, 'ai-suggested');
  history = redoAnalysisHistory(history, utterances);
  assert.equal(history.present.items[0].provenance, 'human-edited');
  assert.ok(history.present.revision > revisionBeforeUndo);
});

test('confirmation protects an AI item and spatial keyboard navigation is deterministic', () => {
  const state = stateWithNodes(5);
  const confirmed = applyHumanItemPatch(state, 'map-node-0', { confirm: true }, utterances);
  assert.equal(confirmed.items[0].provenance, 'human-confirmed');
  const layout = reconcileMapLayout({ positions: {} }, confirmed);
  const candidates = confirmed.items.map((item) => item.id);
  assert.equal(nearestNodeId('map-node-0', 'right', candidates, layout), 'map-node-3');
  assert.equal(nearestNodeId('map-node-0', 'up', candidates, layout), 'map-node-0');
  assert.deepEqual(createAnalysisHistory(emptyAnalysisState).present, emptyAnalysisState);
});

test('human patches retain validator boundaries and session reset clears history', () => {
  const state = stateWithNodes(1);
  assert.throws(() => applyHumanItemPatch(state, 'map-node-0', { title: '   ' }, utterances), /analysis-invalid-item/);
  assert.throws(() => applyHumanItemPatch(state, 'missing-node', { confirm: true }, utterances), /mind-map-unknown-item/);
  assert.equal(applyHumanItemPatch(state, 'map-node-0', { title: state.items[0].title, detail: state.items[0].detail }, utterances).revision, state.revision);

  let history = createAnalysisHistory(state);
  for (let index = 0; index < maximumHistoryEntries + 5; index += 1) {
    history = commitAnalysisHistory(history, applyHumanItemPatch(history.present, 'map-node-0', { detail: `人手更新 ${index}` }, utterances));
  }
  assert.equal(history.past.length, maximumHistoryEntries);
  const reset = commitAnalysisHistory(history, emptyAnalysisState, true);
  assert.equal(reset.past.length, 0);
  assert.equal(reset.future.length, 0);
  assert.deepEqual(reset.present, emptyAnalysisState);
  assert.deepEqual(resetMapLayout(), { positions: {} });
});

test('confirmed mock item is not duplicated and remains protected from later AI updates', () => {
  const meeting = [{ id: 'confirm-u1', revision: 1, phase: 'final', source: 'synthetic', speaker: 'unknown', startMs: 0, endMs: 10, text: '認証はOAuthで進めましょう' }];
  const firstDelta = analyzeWithDeterministicMock(meeting, emptyAnalysisState);
  const analyzed = applyAnalysisDelta(emptyAnalysisState, firstDelta, meeting);
  const confirmed = applyHumanItemPatch(analyzed, analyzed.items[0].id, { confirm: true }, meeting);
  const nextDelta = analyzeWithDeterministicMock(meeting, confirmed);
  assert.equal(nextDelta.operations.length, 0);
  assert.throws(() => applyAnalysisDelta(confirmed, {
    ...nextDelta,
    deltaId: 'attempt-human-overwrite',
    operations: [{ op: 'update', itemId: confirmed.items[0].id, title: 'AIによる上書き', detail: null, status: null, confidence: 0.9, addEvidenceUtteranceIds: [], removeEvidenceUtteranceIds: [] }],
  }, meeting), /analysis-human-item-protected/);
});

test('keyboard selection replacement and scroll target keep a distant node visible', () => {
  assert.equal(visibleSelectionId('removed', ['first', 'second']), 'first');
  assert.equal(visibleSelectionId('second', ['first', 'second']), 'second');
  const state = stateWithNodes(100);
  const layout = reconcileMapLayout({ positions: {} }, state);
  const position = layout.positions['map-node-96'];
  const viewport = { scrollLeft: 0, scrollTop: 0, width: 520, height: 620 };
  const target = scrollTargetForNode(viewport, position, 1);
  assert.ok(target.top > 0);
  assert.ok(position.y >= target.top);
  assert.ok(position.y + mapNodeHeight <= target.top + viewport.height);
  const latest = latestRenderedMapItems(stateWithNodes(101).items);
  assert.equal(latest.length, maximumRenderedNodes);
  assert.equal(latest[0].id, 'map-node-1');
  assert.equal(latest.at(-1).id, 'map-node-100');
});

test('degraded 300-node display scrolls to recent nodes only when none intersects the viewport', () => {
  const state = stateWithNodes(300);
  const layout = reconcileMapLayout(resetMapLayout(), state);
  const latest = latestRenderedMapItems(state.items);
  const viewport = { scrollLeft: 0, scrollTop: 0, width: 520, height: 620 };
  const target = scrollTargetForVisibleItems(viewport, latest.map((item) => item.id), layout, 1);
  assert.ok(target);
  assert.ok(target.top > 0);
  const positions = latest.map((item) => layout.positions[item.id]);
  assert.equal(target.top, Math.min(...positions.map((position) => position.y)) - 24);
  assert.ok(positions.filter((position) => position.y < target.top + viewport.height && position.y + mapNodeHeight > target.top).length >= 2);
  const unchanged = scrollTargetForVisibleItems({ ...viewport, scrollLeft: target.left, scrollTop: target.top }, latest.map((item) => item.id), layout, 1);
  assert.deepEqual(unchanged, target);
  const initialTracking = { processedKey: '', trackedScroll: null };
  const firstDecision = advanceDegradedViewportTracking(initialTracking, 'all-active-1', true, { left: 0, top: 0 });
  assert.equal(firstDecision.shouldEvaluate, true);
  let tracking = { processedKey: firstDecision.next.processedKey, trackedScroll: target };
  const unchangedDecision = advanceDegradedViewportTracking(tracking, 'all-active-1', true, target);
  assert.equal(unchangedDecision.shouldEvaluate, true);
  const expanded = stateWithNodes(320);
  const expandedLayout = reconcileMapLayout(layout, expanded);
  const expandedLatest = latestRenderedMapItems(expanded.items);
  const followTarget = scrollTargetForVisibleItems({ ...viewport, scrollLeft: target.left, scrollTop: target.top }, expandedLatest.map((item) => item.id), expandedLayout, 1);
  assert.ok(followTarget);
  assert.ok(followTarget.top > target.top);
  tracking = { processedKey: 'all-active-1', trackedScroll: followTarget };
  assert.equal(advanceDegradedViewportTracking(tracking, 'all-active-1', true, followTarget).shouldEvaluate, true);
  const manuallyMoved = advanceDegradedViewportTracking(tracking, 'all-active-1', true, { left: followTarget.left, top: followTarget.top + 300 });
  assert.deepEqual(manuallyMoved, { shouldEvaluate: false, next: { processedKey: 'all-active-1', trackedScroll: null } });
  assert.equal(advanceDegradedViewportTracking(manuallyMoved.next, 'all-active-1', true, followTarget).shouldEvaluate, false);
  assert.equal(advanceDegradedViewportTracking(manuallyMoved.next, 'all-active-1.1', true, followTarget).shouldEvaluate, true);
  assert.deepEqual(advanceDegradedViewportTracking(tracking, 'all-active-1', false, followTarget), { shouldEvaluate: false, next: { processedKey: '', trackedScroll: null } });
  assert.notEqual(degradedViewportFilterKey('', 'all', false, 1, 0), degradedViewportFilterKey('', 'all', false, 1.1, 0));
  assert.notEqual(degradedViewportFilterKey('', 'all', false, 1, 0), degradedViewportFilterKey('', 'all', false, 1, 1));
});

test('a loaded session starts from fresh layout slots after the session generation reset', () => {
  const previous = reconcileMapLayout(resetMapLayout(), stateWithNodes(60));
  assert.ok(Object.keys(previous.positions).length > 0);
  const loaded = stateWithNodes(4);
  loaded.items.forEach((item, index) => { item.id = `loaded-node-${index}`; });
  const fresh = reconcileMapLayout(resetMapLayout(), validateAnalysisState(loaded, utterances));
  assert.equal(Math.min(...Object.values(fresh.positions).map((position) => position.y)), 92);
  assert.equal(Object.keys(fresh.positions).some((id) => id.startsWith('map-node-')), false);
});

test('an edit draft can only commit to the item that opened the editor', () => {
  assert.equal(canCommitMapEdit('node-a', 'node-a'), true);
  assert.equal(canCommitMapEdit('node-a', 'node-b'), false);
  assert.equal(canCommitMapEdit('', 'node-a'), false);
});

test('explicit reframe returns a normal 100-node map to its top-left content', () => {
  const state = stateWithNodes(100);
  const layout = reconcileMapLayout(resetMapLayout(), state);
  const target = topAlignedScrollTargetForItems(state.items.map((item) => item.id), layout, 1);
  assert.deepEqual(target, { left: 36, top: 68 });
  assert.ok(state.items.filter((item) => {
    const position = layout.positions[item.id];
    return position.y < target.top + 620 && position.y + mapNodeHeight > target.top;
  }).length >= 2);
});
