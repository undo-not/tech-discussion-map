import type { TranscriptUtterance } from '../transcription/utterance.ts';

export const analysisContractVersion = 1 as const;
export const analysisKinds = ['topic', 'claim', 'question', 'decision', 'action', 'dependency', 'risk'] as const;
export const analysisStatuses = ['proposed', 'open', 'confirmed', 'blocked', 'done', 'superseded', 'withdrawn'] as const;
export const analysisRelations = ['supports', 'contradicts', 'depends-on', 'answers', 'duplicate-of'] as const;
export const analysisProvenance = ['ai-suggested', 'human-confirmed', 'human-edited'] as const;

export type AnalysisKind = (typeof analysisKinds)[number];
export type AnalysisStatus = (typeof analysisStatuses)[number];
export type AnalysisRelation = (typeof analysisRelations)[number];
export type AnalysisProvenance = (typeof analysisProvenance)[number];

export type AnalysisLink = { targetId: string; relation: AnalysisRelation };
export type AnalysisItem = {
  id: string;
  kind: AnalysisKind;
  title: string;
  detail: string;
  status: AnalysisStatus;
  confidence: number;
  provenance: AnalysisProvenance;
  evidenceUtteranceIds: string[];
  links: AnalysisLink[];
};

type AddOperation = { op: 'add'; tempId: string; kind: AnalysisKind; title: string; detail: string; status: AnalysisStatus; confidence: number; evidenceUtteranceIds: string[] };
type UpdateOperation = { op: 'update'; itemId: string; title: string | null; detail: string | null; status: AnalysisStatus | null; confidence: number; addEvidenceUtteranceIds: string[]; removeEvidenceUtteranceIds: string[] };
type MergeOperation = { op: 'merge'; canonicalItemId: string; duplicateItemIds: string[]; title: string | null; detail: string | null; evidenceUtteranceIds: string[] };
type RetractOperation = { op: 'retract'; itemId: string; reason: string; evidenceUtteranceIds: string[] };
type LinkOperation = { op: 'link'; fromItemId: string; toItemId: string; relation: AnalysisRelation; evidenceUtteranceIds: string[] };
export type AnalysisOperation = AddOperation | UpdateOperation | MergeOperation | RetractOperation | LinkOperation;

export type AnalyzerOutput = { contractVersion: 1; baseRevision: number; operations: AnalysisOperation[] };
export type AnalysisDelta = AnalyzerOutput & { deltaId: string; model: string; promptHash: string; schemaHash: string };
export type AppliedDelta = Pick<AnalysisDelta, 'deltaId' | 'model' | 'promptHash' | 'schemaHash'>;
export type AnalysisState = { contractVersion: 1; revision: number; items: AnalysisItem[]; appliedDeltas: AppliedDelta[] };

export const emptyAnalysisState: AnalysisState = { contractVersion: 1, revision: 0, items: [], appliedDeltas: [] };

const safeId = /^[a-zA-Z0-9_-]{1,80}$/;
const exactKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const boundedText = (value: unknown, maximum: number) => typeof value === 'string' && value.trim().length > 0 && value.length <= maximum && !value.includes('\0');
const boundedConfidence = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

function parseEvidence(value: unknown, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > 16 || value.some((id) => typeof id !== 'string' || !safeId.test(id))) throw new Error('analysis-invalid-evidence');
  if (new Set(value).size !== value.length) throw new Error('analysis-duplicate-evidence');
  return [...value];
}

function parseOperation(value: unknown): AnalysisOperation {
  if (typeof value !== 'object' || value === null) throw new Error('analysis-invalid-operation');
  const item = value as Record<string, unknown>;
  if (item.op === 'add') {
    if (!exactKeys(item, ['op', 'tempId', 'kind', 'title', 'detail', 'status', 'confidence', 'evidenceUtteranceIds']) || typeof item.tempId !== 'string' || !safeId.test(item.tempId) || !analysisKinds.includes(item.kind as AnalysisKind) || !boundedText(item.title, 160) || !boundedText(item.detail, 600) || !analysisStatuses.includes(item.status as AnalysisStatus) || !boundedConfidence(item.confidence)) throw new Error('analysis-invalid-add');
    return { ...item, evidenceUtteranceIds: parseEvidence(item.evidenceUtteranceIds) } as AddOperation;
  }
  if (item.op === 'update') {
    if (!exactKeys(item, ['op', 'itemId', 'title', 'detail', 'status', 'confidence', 'addEvidenceUtteranceIds', 'removeEvidenceUtteranceIds']) || typeof item.itemId !== 'string' || !safeId.test(item.itemId) || (item.title !== null && !boundedText(item.title, 160)) || (item.detail !== null && !boundedText(item.detail, 600)) || (item.status !== null && !analysisStatuses.includes(item.status as AnalysisStatus)) || !boundedConfidence(item.confidence)) throw new Error('analysis-invalid-update');
    return { ...item, addEvidenceUtteranceIds: parseEvidence(item.addEvidenceUtteranceIds, true), removeEvidenceUtteranceIds: parseEvidence(item.removeEvidenceUtteranceIds, true) } as UpdateOperation;
  }
  if (item.op === 'merge') {
    if (!exactKeys(item, ['op', 'canonicalItemId', 'duplicateItemIds', 'title', 'detail', 'evidenceUtteranceIds']) || typeof item.canonicalItemId !== 'string' || !safeId.test(item.canonicalItemId) || !Array.isArray(item.duplicateItemIds) || item.duplicateItemIds.length === 0 || item.duplicateItemIds.length > 8 || item.duplicateItemIds.some((id) => typeof id !== 'string' || !safeId.test(id)) || new Set(item.duplicateItemIds).size !== item.duplicateItemIds.length || (item.title !== null && !boundedText(item.title, 160)) || (item.detail !== null && !boundedText(item.detail, 600))) throw new Error('analysis-invalid-merge');
    return { ...item, evidenceUtteranceIds: parseEvidence(item.evidenceUtteranceIds) } as MergeOperation;
  }
  if (item.op === 'retract') {
    if (!exactKeys(item, ['op', 'itemId', 'reason', 'evidenceUtteranceIds']) || typeof item.itemId !== 'string' || !safeId.test(item.itemId) || !boundedText(item.reason, 300)) throw new Error('analysis-invalid-retract');
    return { ...item, evidenceUtteranceIds: parseEvidence(item.evidenceUtteranceIds) } as RetractOperation;
  }
  if (item.op === 'link') {
    if (!exactKeys(item, ['op', 'fromItemId', 'toItemId', 'relation', 'evidenceUtteranceIds']) || typeof item.fromItemId !== 'string' || !safeId.test(item.fromItemId) || typeof item.toItemId !== 'string' || !safeId.test(item.toItemId) || item.fromItemId === item.toItemId || !analysisRelations.includes(item.relation as AnalysisRelation)) throw new Error('analysis-invalid-link');
    return { ...item, evidenceUtteranceIds: parseEvidence(item.evidenceUtteranceIds) } as LinkOperation;
  }
  throw new Error('analysis-unknown-operation');
}

export function parseAnalyzerOutput(value: unknown): AnalyzerOutput {
  if (typeof value !== 'object' || value === null) throw new Error('analysis-invalid-output');
  const item = value as Record<string, unknown>;
  if (!exactKeys(item, ['contractVersion', 'baseRevision', 'operations']) || item.contractVersion !== analysisContractVersion || !Number.isSafeInteger(item.baseRevision) || (item.baseRevision as number) < 0 || !Array.isArray(item.operations) || item.operations.length > 40) throw new Error('analysis-invalid-output');
  const operations = item.operations.map(parseOperation);
  const tempIds = operations.filter((operation): operation is AddOperation => operation.op === 'add').map((operation) => operation.tempId);
  if (new Set(tempIds).size !== tempIds.length) throw new Error('analysis-duplicate-temp-id');
  return { contractVersion: analysisContractVersion, baseRevision: item.baseRevision as number, operations };
}

function verifyEvidence(ids: string[], utteranceIds: Set<string>): void {
  for (const id of ids) if (!utteranceIds.has(id)) throw new Error(`analysis-broken-evidence:${id}`);
}

function assertAiMutable(item: AnalysisItem): void {
  if (item.provenance !== 'ai-suggested') throw new Error(`analysis-human-item-protected:${item.id}`);
}

function canonicalId(deltaId: string, tempId: string): string {
  const id = `ai_${deltaId.replace(/-/g, '').slice(0, 24)}_${tempId}`;
  if (!safeId.test(id)) throw new Error('analysis-invalid-canonical-id');
  return id;
}

export function validateAnalysisState(value: unknown, utterances: TranscriptUtterance[] = []): AnalysisState {
  if (typeof value !== 'object' || value === null) throw new Error('analysis-invalid-state');
  const state = value as Record<string, unknown>;
  if (!exactKeys(state, ['contractVersion', 'revision', 'items', 'appliedDeltas']) || state.contractVersion !== analysisContractVersion || !Number.isSafeInteger(state.revision) || (state.revision as number) < 0 || !Array.isArray(state.items) || state.items.length > 2_000 || !Array.isArray(state.appliedDeltas) || state.appliedDeltas.length > 2_000) throw new Error('analysis-invalid-state');
  const items = state.items.map((valueItem) => {
    if (typeof valueItem !== 'object' || valueItem === null) throw new Error('analysis-invalid-item');
    const item = valueItem as Record<string, unknown>;
    if (!exactKeys(item, ['id', 'kind', 'title', 'detail', 'status', 'confidence', 'provenance', 'evidenceUtteranceIds', 'links']) || typeof item.id !== 'string' || !safeId.test(item.id) || !analysisKinds.includes(item.kind as AnalysisKind) || !boundedText(item.title, 160) || !boundedText(item.detail, 600) || !analysisStatuses.includes(item.status as AnalysisStatus) || !boundedConfidence(item.confidence) || !analysisProvenance.includes(item.provenance as AnalysisProvenance) || !Array.isArray(item.links) || item.links.length > 40) throw new Error('analysis-invalid-item');
    const links = item.links.map((valueLink) => {
      if (typeof valueLink !== 'object' || valueLink === null) throw new Error('analysis-invalid-link');
      const link = valueLink as Record<string, unknown>;
      if (!exactKeys(link, ['targetId', 'relation']) || typeof link.targetId !== 'string' || !safeId.test(link.targetId) || !analysisRelations.includes(link.relation as AnalysisRelation)) throw new Error('analysis-invalid-link');
      return { targetId: link.targetId, relation: link.relation as AnalysisRelation };
    });
    if (item.provenance === 'ai-suggested' && item.kind === 'decision' && ['confirmed', 'done'].includes(item.status as string)) throw new Error('analysis-ai-cannot-finalize-decision');
    return { id: item.id, kind: item.kind as AnalysisKind, title: (item.title as string).trim(), detail: (item.detail as string).trim(), status: item.status as AnalysisStatus, confidence: item.confidence as number, provenance: item.provenance as AnalysisProvenance, evidenceUtteranceIds: parseEvidence(item.evidenceUtteranceIds), links };
  });
  if (new Set(items.map((item) => item.id)).size !== items.length) throw new Error('analysis-duplicate-item-id');
  const itemIds = new Set(items.map((item) => item.id));
  const utteranceIds = new Set(utterances.filter((item) => item.phase === 'final').map((item) => item.id));
  for (const item of items) {
    if (utteranceIds.size > 0) verifyEvidence(item.evidenceUtteranceIds, utteranceIds);
    for (const link of item.links) if (!itemIds.has(link.targetId)) throw new Error('analysis-broken-link');
  }
  const appliedDeltas = state.appliedDeltas.map((valueDelta) => {
    if (typeof valueDelta !== 'object' || valueDelta === null) throw new Error('analysis-invalid-applied-delta');
    const delta = valueDelta as Record<string, unknown>;
    if (!exactKeys(delta, ['deltaId', 'model', 'promptHash', 'schemaHash']) || typeof delta.deltaId !== 'string' || !safeId.test(delta.deltaId) || !boundedText(delta.model, 80) || typeof delta.promptHash !== 'string' || !/^[a-f0-9]{64}$/.test(delta.promptHash) || typeof delta.schemaHash !== 'string' || !/^[a-f0-9]{64}$/.test(delta.schemaHash)) throw new Error('analysis-invalid-applied-delta');
    return delta as AppliedDelta;
  });
  if (new Set(appliedDeltas.map((item) => item.deltaId)).size !== appliedDeltas.length || (state.revision as number) !== appliedDeltas.length) throw new Error('analysis-invalid-revision-log');
  return { contractVersion: analysisContractVersion, revision: state.revision as number, items, appliedDeltas };
}

export function applyAnalysisDelta(state: AnalysisState, candidate: AnalysisDelta, utterances: TranscriptUtterance[]): AnalysisState {
  state = validateAnalysisState(state, utterances);
  if (state.contractVersion !== analysisContractVersion || candidate.contractVersion !== analysisContractVersion) throw new Error('analysis-unsupported-contract');
  if (!safeId.test(candidate.deltaId) || !boundedText(candidate.model, 80) || !/^[a-f0-9]{64}$/.test(candidate.promptHash) || !/^[a-f0-9]{64}$/.test(candidate.schemaHash)) throw new Error('analysis-invalid-delta-metadata');
  if (state.appliedDeltas.some((item) => item.deltaId === candidate.deltaId)) return structuredClone(state);
  if (candidate.baseRevision !== state.revision) throw new Error('analysis-stale-revision');
  const parsed = parseAnalyzerOutput({ contractVersion: candidate.contractVersion, baseRevision: candidate.baseRevision, operations: candidate.operations });
  const utteranceIds = new Set(utterances.filter((item) => item.phase === 'final').map((item) => item.id));
  const next = structuredClone(state);
  const itemById = () => new Map(next.items.map((item) => [item.id, item]));

  for (const operation of parsed.operations) {
    if (operation.op === 'add') {
      verifyEvidence(operation.evidenceUtteranceIds, utteranceIds);
      if (!['proposed', 'open', 'blocked'].includes(operation.status)) throw new Error('analysis-ai-cannot-finalize-item');
      const id = canonicalId(candidate.deltaId, operation.tempId);
      if (itemById().has(id)) throw new Error('analysis-duplicate-item-id');
      next.items.push({ id, kind: operation.kind, title: operation.title.trim(), detail: operation.detail.trim(), status: operation.status, confidence: operation.confidence, provenance: 'ai-suggested', evidenceUtteranceIds: [...operation.evidenceUtteranceIds], links: [] });
      continue;
    }
    const items = itemById();
    if (operation.op === 'update') {
      const target = items.get(operation.itemId);
      if (!target) throw new Error('analysis-unknown-item');
      assertAiMutable(target);
      verifyEvidence([...operation.addEvidenceUtteranceIds, ...operation.removeEvidenceUtteranceIds], utteranceIds);
      const evidence = new Set(target.evidenceUtteranceIds);
      for (const id of operation.removeEvidenceUtteranceIds) { if (!evidence.delete(id)) throw new Error('analysis-remove-missing-evidence'); }
      for (const id of operation.addEvidenceUtteranceIds) evidence.add(id);
      if (evidence.size === 0) throw new Error('analysis-empty-evidence');
      if (operation.title !== null) target.title = operation.title.trim();
      if (operation.detail !== null) target.detail = operation.detail.trim();
      if (operation.status !== null) target.status = operation.status;
      if (target.kind === 'decision' && ['confirmed', 'done'].includes(target.status)) throw new Error('analysis-ai-cannot-finalize-decision');
      target.confidence = operation.confidence;
      target.evidenceUtteranceIds = [...evidence];
      continue;
    }
    if (operation.op === 'merge') {
      const canonical = items.get(operation.canonicalItemId);
      if (!canonical) throw new Error('analysis-unknown-canonical');
      assertAiMutable(canonical);
      verifyEvidence(operation.evidenceUtteranceIds, utteranceIds);
      const evidence = new Set([...canonical.evidenceUtteranceIds, ...operation.evidenceUtteranceIds]);
      for (const id of operation.duplicateItemIds) {
        if (id === canonical.id) throw new Error('analysis-self-merge');
        const duplicate = items.get(id);
        if (!duplicate) throw new Error('analysis-unknown-duplicate');
        assertAiMutable(duplicate);
        duplicate.status = 'superseded';
        duplicate.links = [...duplicate.links, { targetId: canonical.id, relation: 'duplicate-of' }];
        for (const utteranceId of duplicate.evidenceUtteranceIds) evidence.add(utteranceId);
      }
      if (operation.title !== null) canonical.title = operation.title.trim();
      if (operation.detail !== null) canonical.detail = operation.detail.trim();
      canonical.evidenceUtteranceIds = [...evidence];
      continue;
    }
    if (operation.op === 'retract') {
      const target = items.get(operation.itemId);
      if (!target) throw new Error('analysis-unknown-item');
      assertAiMutable(target);
      verifyEvidence(operation.evidenceUtteranceIds, utteranceIds);
      target.status = 'withdrawn';
      target.detail = `${target.detail}\n撤回理由: ${operation.reason.trim()}`.slice(0, 600);
      target.evidenceUtteranceIds = [...new Set([...target.evidenceUtteranceIds, ...operation.evidenceUtteranceIds])];
      continue;
    }
    const from = items.get(operation.fromItemId);
    const to = items.get(operation.toItemId);
    if (!from || !to) throw new Error('analysis-unknown-link-item');
    assertAiMutable(from);
    verifyEvidence(operation.evidenceUtteranceIds, utteranceIds);
    if (!from.links.some((link) => link.targetId === to.id && link.relation === operation.relation)) from.links.push({ targetId: to.id, relation: operation.relation });
    from.evidenceUtteranceIds = [...new Set([...from.evidenceUtteranceIds, ...operation.evidenceUtteranceIds])];
  }

  for (const item of next.items) {
    if (item.evidenceUtteranceIds.length === 0) throw new Error('analysis-empty-evidence');
    verifyEvidence(item.evidenceUtteranceIds, utteranceIds);
    for (const link of item.links) if (!next.items.some((candidateItem) => candidateItem.id === link.targetId)) throw new Error('analysis-broken-link');
  }
  next.revision += 1;
  next.appliedDeltas.push({ deltaId: candidate.deltaId, model: candidate.model, promptHash: candidate.promptHash, schemaHash: candidate.schemaHash });
  return next;
}
