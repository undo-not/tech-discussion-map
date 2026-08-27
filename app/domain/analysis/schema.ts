const safeId = { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,80}$' } as const;
const evidenceIds = { type: 'array', items: safeId, minItems: 1, maxItems: 16 } as const;
const title = { type: 'string', pattern: '^[^\\u0000]{1,160}$' } as const;
const detail = { type: 'string', pattern: '^[^\\u0000]{1,600}$' } as const;
const optionalTitle = { anyOf: [title, { type: 'null' }] } as const;
const optionalDetail = { anyOf: [detail, { type: 'null' }] } as const;
const optionalStatus = { anyOf: [{ type: 'string', enum: ['proposed', 'open', 'confirmed', 'blocked', 'done', 'superseded', 'withdrawn'] }, { type: 'null' }] } as const;

const addOperation = {
  type: 'object', additionalProperties: false,
  required: ['op', 'tempId', 'kind', 'title', 'detail', 'status', 'confidence', 'evidenceUtteranceIds'],
  properties: {
    op: { type: 'string', const: 'add' }, tempId: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,52}$' },
    kind: { type: 'string', enum: ['topic', 'claim', 'question', 'decision', 'action', 'dependency', 'risk'] },
    title, detail,
    status: { type: 'string', enum: ['proposed', 'open', 'blocked'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 }, evidenceUtteranceIds: evidenceIds,
  },
} as const;

const updateOperation = {
  type: 'object', additionalProperties: false,
  required: ['op', 'itemId', 'title', 'detail', 'status', 'confidence', 'addEvidenceUtteranceIds', 'removeEvidenceUtteranceIds'],
  properties: {
    op: { type: 'string', const: 'update' }, itemId: safeId, title: optionalTitle, detail: optionalDetail,
    status: optionalStatus, confidence: { type: 'number', minimum: 0, maximum: 1 },
    addEvidenceUtteranceIds: { type: 'array', items: safeId, maxItems: 16 },
    removeEvidenceUtteranceIds: { type: 'array', items: safeId, maxItems: 16 },
  },
} as const;

const mergeOperation = {
  type: 'object', additionalProperties: false,
  required: ['op', 'canonicalItemId', 'duplicateItemIds', 'title', 'detail', 'evidenceUtteranceIds'],
  properties: {
    op: { type: 'string', const: 'merge' }, canonicalItemId: safeId,
    duplicateItemIds: { type: 'array', items: safeId, minItems: 1, maxItems: 8 },
    title: optionalTitle, detail: optionalDetail, evidenceUtteranceIds: evidenceIds,
  },
} as const;

const retractOperation = {
  type: 'object', additionalProperties: false,
  required: ['op', 'itemId', 'reason', 'evidenceUtteranceIds'],
  properties: { op: { type: 'string', const: 'retract' }, itemId: safeId, reason: { type: 'string', pattern: '^[^\\u0000]{1,300}$' }, evidenceUtteranceIds: evidenceIds },
} as const;

const linkOperation = {
  type: 'object', additionalProperties: false,
  required: ['op', 'fromItemId', 'toItemId', 'relation', 'evidenceUtteranceIds'],
  properties: {
    op: { type: 'string', const: 'link' }, fromItemId: safeId, toItemId: safeId,
    relation: { type: 'string', enum: ['supports', 'contradicts', 'depends-on', 'answers', 'duplicate-of'] }, evidenceUtteranceIds: evidenceIds,
  },
} as const;

export const analysisOutputJsonSchema = {
  type: 'object', additionalProperties: false,
  required: ['contractVersion', 'baseRevision', 'operations'],
  properties: {
    contractVersion: { type: 'integer', const: 1 },
    baseRevision: { type: 'integer', minimum: 0, maximum: 9_007_199_254_740_991 },
    operations: { type: 'array', maxItems: 40, items: { anyOf: [addOperation, updateOperation, mergeOperation, retractOperation, linkOperation] } },
  },
} as const;

export const analysisStructuredOutput = {
  type: 'json_schema', name: 'techmap_analysis_delta_v1', strict: true, schema: analysisOutputJsonSchema,
} as const;

export const analysisSchemaHash = 'c242034d904489c2ef1be1b635be471d8de93a377b1409db854d32e6b828ef42';
