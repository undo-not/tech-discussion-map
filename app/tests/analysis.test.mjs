import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import evaluation from '../fixtures/analysis-eval.json' with { type: 'json' };
import { analyzeWithDeterministicMock } from '../adapters/analysis/mock-analyzer.ts';
import { extractOutputText } from '../adapters/analysis/local-openai-analyzer.ts';
import { createPrivacySafeStructuredResponsesRequest } from '../adapters/privacy/openai-request-policy.ts';
import { analysisPrompt, analysisPromptHash, createRedactedAnalysisInput } from '../domain/analysis/prompt.ts';
import { analysisOutputJsonSchema, analysisSchemaHash, analysisStructuredOutput } from '../domain/analysis/schema.ts';
import { applyAnalysisDelta, emptyAnalysisState, parseAnalyzerOutput } from '../domain/analysis/contract.ts';
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
