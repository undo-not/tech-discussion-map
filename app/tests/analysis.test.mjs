import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import evaluation from '../fixtures/analysis-eval.json' with { type: 'json' };
import { analyzeWithDeterministicMock } from '../adapters/analysis/mock-analyzer.ts';
import { extractOutputText, LocalOpenAiAnalyzer } from '../adapters/analysis/local-openai-analyzer.ts';
import { createPrivacySafeStructuredResponsesRequest } from '../adapters/privacy/openai-request-policy.ts';
import { analysisPrompt, analysisPromptHash, createRedactedAnalysisInput } from '../domain/analysis/prompt.ts';
import { analysisOutputJsonSchema, analysisSchemaHash, analysisStructuredOutput } from '../domain/analysis/schema.ts';
import { applyAnalysisDelta, emptyAnalysisState, maximumAppliedDeltaLog, parseAnalyzerOutput, validateAnalysisState } from '../domain/analysis/contract.ts';
import { redactText } from '../domain/privacy/redaction.ts';

const metadata = (deltaId) => ({ deltaId, model: 'synthetic-eval', promptHash: analysisPromptHash, schemaHash: analysisSchemaHash });

test('analysis eval folds duplicate, pending answer, correction, and decision change', () => {
  let state = emptyAnalysisState;
  state = applyAnalysisDelta(state, { ...evaluation.outputs[0], ...metadata('evaldelta1') }, evaluation.utterances);
  state = applyAnalysisDelta(state, { ...evaluation.outputs[1], ...metadata('evaldelta2') }, evaluation.utterances);
  assert.equal(state.revision, 2);
  assert.equal(state.items.find((item) => item.id.endsWith('decision_duplicate')).status, 'superseded');
  assert.deepEqual(state.items.find((item) => item.id.endsWith('decision_a')).evidenceUtteranceIds, ['eval-u1', 'eval-u2', 'eval-u5']);
  assert.equal(state.items.find((item) => item.id.endsWith('decision_a')).title, '方針B');
  assert.equal(state.items.find((item) => item.id.endsWith('migration_question')).status, 'confirmed');
});

test('invalid operation, stale revision, broken evidence, and human overwrite fail atomically', () => {
  const state = applyAnalysisDelta(emptyAnalysisState, { ...evaluation.outputs[0], ...metadata('evaldelta1') }, evaluation.utterances);
  const before = structuredClone(state);
  assert.throws(() => parseAnalyzerOutput({ contractVersion: 1, baseRevision: 1, operations: [{ op: 'invent' }] }), /unknown-operation/);
  assert.throws(() => applyAnalysisDelta(state, { ...evaluation.outputs[1], baseRevision: 0, ...metadata('stale') }, evaluation.utterances), /stale-revision/);
  const broken = structuredClone(evaluation.outputs[1]);
  broken.operations[0].evidenceUtteranceIds = ['missing'];
  assert.throws(() => applyAnalysisDelta(state, { ...broken, ...metadata('brokenref') }, evaluation.utterances), /broken-evidence/);
  const protectedState = structuredClone(state);
  protectedState.items[0].provenance = 'human-confirmed';
  const update = { contractVersion: 1, baseRevision: 1, operations: [{ op: 'update', itemId: protectedState.items[0].id, title: '上書き', detail: null, status: null, confidence: 1, addEvidenceUtteranceIds: [], removeEvidenceUtteranceIds: [] }] };
  assert.throws(() => applyAnalysisDelta(protectedState, { ...update, ...metadata('humanoverwrite') }, evaluation.utterances), /human-item-protected/);
  const autoFinal = { contractVersion: 1, baseRevision: 1, operations: [{ op: 'update', itemId: state.items[0].id, title: null, detail: null, status: 'confirmed', confidence: 1, addEvidenceUtteranceIds: [], removeEvidenceUtteranceIds: [] }] };
  assert.throws(() => applyAnalysisDelta(state, { ...autoFinal, ...metadata('autofinal') }, evaluation.utterances), /cannot-finalize-decision/);
  assert.deepEqual(state, before);
});

test('delta application is idempotent and mock analyzer is deterministic', () => {
  const delta = { ...evaluation.outputs[0], ...metadata('idempotent') };
  const once = applyAnalysisDelta(emptyAnalysisState, delta, evaluation.utterances);
  assert.deepEqual(applyAnalysisDelta(once, delta, evaluation.utterances), once);
  assert.deepEqual(analyzeWithDeterministicMock(evaluation.utterances, emptyAnalysisState), analyzeWithDeterministicMock(evaluation.utterances, emptyAnalysisState));
});

test('prompt and schema hashes pin the regression contract', () => {
  assert.equal(createHash('sha256').update(analysisPrompt, 'utf8').digest('hex'), analysisPromptHash);
  assert.equal(createHash('sha256').update(JSON.stringify(analysisOutputJsonSchema)).digest('hex'), analysisSchemaHash);
  for (const heading of ['成果:', '制約:', '成功条件:', '出力形式:']) assert.equal(analysisPrompt.split(heading).length - 1, 1);
});

test('structured Responses request and response parser fail closed', () => {
  const redacted = redactText('合成された分析window');
  assert.equal(redacted.ok, true);
  const request = createPrivacySafeStructuredResponsesRequest('gpt-5-mini', redacted.text, analysisStructuredOutput);
  assert.equal(request.store, false);
  assert.deepEqual(Object.keys(request).sort(), ['input', 'model', 'store', 'text']);
  const payload = JSON.stringify(evaluation.outputs[0]);
  assert.equal(extractOutputText({ status: 'completed', output: [{ content: [{ type: 'output_text', text: payload }] }] }), payload);
  assert.throws(() => extractOutputText({ status: 'incomplete', output: [] }), /incomplete/);
  assert.throws(() => extractOutputText({ status: 'completed', output: [{ content: [{ type: 'refusal', refusal: 'no' }] }] }), /refusal/);
});

test('state projection is redacted again before outbound analysis', () => {
  const window = redactText('合成された発話window');
  assert.equal(window.ok, true);
  const state = {
    contractVersion: 1, revision: 0, appliedDeltas: [],
    items: [{ id: 'human_item', kind: 'topic', title: 'user@example.test', detail: 'password=synthetic-secret', status: 'confirmed', confidence: 1, provenance: 'human-confirmed', evidenceUtteranceIds: ['eval-u1'], links: [] }],
  };
  const outbound = createRedactedAnalysisInput(window.text, state);
  assert.doesNotMatch(outbound, /user@example|synthetic-secret/);
  assert.match(outbound, /REDACTED_EMAIL|REDACTED_CREDENTIAL/);
});

test('state validation and atomic apply enforce evidence bounds even without transcript evidence', () => {
  const utterances = Array.from({ length: 17 }, (_, index) => ({ id: `bound-u${index + 1}`, revision: 1, phase: 'final', source: 'synthetic', speaker: 'unknown', startMs: index, endMs: index + 1, text: '同じ話題' }));
  const state = {
    contractVersion: 1, revision: 0, appliedDeltas: [],
    items: [{ id: 'bounded_item', kind: 'topic', title: '同じ話題', detail: '合成された詳細', status: 'open', confidence: 0.8, provenance: 'ai-suggested', evidenceUtteranceIds: utterances.slice(0, 16).map((item) => item.id), links: [] }],
  };
  assert.throws(() => validateAnalysisState(state), /broken-evidence/);
  const overflow = { contractVersion: 1, baseRevision: 0, operations: [{ op: 'update', itemId: 'bounded_item', title: null, detail: null, status: null, confidence: 0.9, addEvidenceUtteranceIds: ['bound-u17'], removeEvidenceUtteranceIds: [] }] };
  assert.throws(() => applyAnalysisDelta(state, { ...overflow, ...metadata('evidenceoverflow') }, utterances), /evidence-limit/);
  assert.equal(analyzeWithDeterministicMock(utterances, state).operations.length, 0);
});

test('applied delta audit log is bounded while revision stays monotonic', () => {
  let state = emptyAnalysisState;
  for (let index = 0; index <= maximumAppliedDeltaLog; index += 1) {
    state = applyAnalysisDelta(state, { contractVersion: 1, baseRevision: state.revision, operations: [], ...metadata(`log${index}`) }, []);
  }
  assert.equal(state.revision, maximumAppliedDeltaLog + 1);
  assert.equal(state.appliedDeltas.length, maximumAppliedDeltaLog);
  assert.equal(state.appliedDeltas[0].deltaId, 'log1');
  assert.doesNotThrow(() => validateAnalysisState(state));
});

test('structured schema mirrors runtime add and scalar bounds', () => {
  const add = analysisOutputJsonSchema.properties.operations.items.anyOf[0].properties;
  assert.deepEqual(add.status.enum, ['proposed', 'open', 'blocked']);
  assert.equal(add.tempId.maxLength, 52);
  assert.equal(add.title.maxLength, 160);
  assert.equal(add.detail.maxLength, 600);
  assert.equal(add.confidence.minimum, 0);
  assert.equal(add.confidence.maximum, 1);
});

test('expired local bearer is re-bootstrapped once without changing OpenAI retry policy', async () => {
  const calls = [];
  const tokenA = 'a'.repeat(64);
  const tokenB = 'b'.repeat(64);
  const output = { contractVersion: 1, baseRevision: 0, operations: [] };
  const responses = [
    new Response(JSON.stringify({ token: tokenA }), { status: 200 }),
    new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
    new Response(JSON.stringify({ token: tokenB }), { status: 200 }),
    new Response(JSON.stringify({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(output) }] }] }), { status: 200 }),
  ];
  const analyzer = new LocalOpenAiAnalyzer({
    launchSecret: () => 'c'.repeat(64),
    fetchImpl: async (url, init) => { calls.push({ url: String(url), authorization: new Headers(init.headers).get('Authorization') }); return responses.shift(); },
  });
  const redacted = redactText('合成された再認証test');
  assert.equal(redacted.ok, true);
  const delta = await analyzer.analyze('gpt-5-mini', redacted.text, emptyAnalysisState);
  assert.equal(delta.operations.length, 0);
  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), ['/v1/bootstrap', '/v1/analysis', '/v1/bootstrap', '/v1/analysis']);
  assert.deepEqual(calls.filter((call) => call.authorization).map((call) => call.authorization), [`Bearer ${tokenA}`, `Bearer ${tokenB}`]);
});
