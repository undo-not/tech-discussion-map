const safeId = { type: 'string', minLength: 1, maxLength: 80, pattern: '^[a-zA-Z0-9_-]+$' } as const;
const evidenceIds = { type: 'array', items: safeId, minItems: 1, maxItems: 16 } as const;
const title = { type: 'string', minLength: 1, maxLength: 160 } as const;
const detail = { type: 'string', minLength: 1, maxLength: 600 } as const;
const optionalTitle = { anyOf: [title, { type: 'null' }] } as const;
const optionalDetail = { anyOf: [detail, { type: 'null' }] } as const;
const optionalStatus = { anyOf: [{ type: 'string', enum: ['proposed', 'open', 'confirmed', 'blocked', 'done', 'superseded', 'withdrawn'] }, { type: 'null' }] } as const;

const addOperation = {
  type: 'object', additionalProperties: false,
  required: ['op', 'tempId', 'kind', 'title', 'detail', 'status', 'confidence', 'evidenceUtteranceIds'],
  properties: {
    op: { type: 'string', const: 'add' }, tempId: { ...safeId, maxLength: 52 },
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
  properties: { op: { type: 'string', const: 'retract' }, itemId: safeId, reason: { type: 'string', minLength: 1, maxLength: 300 }, evidenceUtteranceIds: evidenceIds },
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

export const analysisSchemaHash = '2f25ecb75d23e46fdda4bd86d9e04d6dffd24e7c229dc73332ad6b04e4041a43';
