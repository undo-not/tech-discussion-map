const evidenceIds = { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 16 } as const;
const optionalText = { anyOf: [{ type: 'string' }, { type: 'null' }] } as const;
const optionalStatus = { anyOf: [{ type: 'string', enum: ['proposed', 'open', 'confirmed', 'blocked', 'done', 'superseded', 'withdrawn'] }, { type: 'null' }] } as const;

const addOperation = {
  type: 'object', additionalProperties: false,
  required: ['op', 'tempId', 'kind', 'title', 'detail', 'status', 'confidence', 'evidenceUtteranceIds'],
  properties: {
    op: { type: 'string', const: 'add' }, tempId: { type: 'string' },
    kind: { type: 'string', enum: ['topic', 'claim', 'question', 'decision', 'action', 'dependency', 'risk'] },
    title: { type: 'string' }, detail: { type: 'string' },
    status: { type: 'string', enum: ['proposed', 'open', 'confirmed', 'blocked', 'done', 'superseded', 'withdrawn'] },
    confidence: { type: 'number' }, evidenceUtteranceIds: evidenceIds,
  },
} as const;

const updateOperation = {
  type: 'object', additionalProperties: false,
  required: ['op', 'itemId', 'title', 'detail', 'status', 'confidence', 'addEvidenceUtteranceIds', 'removeEvidenceUtteranceIds'],
  properties: {
    op: { type: 'string', const: 'update' }, itemId: { type: 'string' }, title: optionalText, detail: optionalText,
    status: optionalStatus, confidence: { type: 'number' },
    addEvidenceUtteranceIds: { type: 'array', items: { type: 'string' }, maxItems: 16 },
    removeEvidenceUtteranceIds: { type: 'array', items: { type: 'string' }, maxItems: 16 },
  },
} as const;

const mergeOperation = {
  type: 'object', additionalProperties: false,
  required: ['op', 'canonicalItemId', 'duplicateItemIds', 'title', 'detail', 'evidenceUtteranceIds'],
  properties: {
    op: { type: 'string', const: 'merge' }, canonicalItemId: { type: 'string' },
    duplicateItemIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 },
    title: optionalText, detail: optionalText, evidenceUtteranceIds: evidenceIds,
  },
} as const;

const retractOperation = {
  type: 'object', additionalProperties: false,
  required: ['op', 'itemId', 'reason', 'evidenceUtteranceIds'],
  properties: { op: { type: 'string', const: 'retract' }, itemId: { type: 'string' }, reason: { type: 'string' }, evidenceUtteranceIds: evidenceIds },
} as const;

const linkOperation = {
  type: 'object', additionalProperties: false,
  required: ['op', 'fromItemId', 'toItemId', 'relation', 'evidenceUtteranceIds'],
  properties: {
    op: { type: 'string', const: 'link' }, fromItemId: { type: 'string' }, toItemId: { type: 'string' },
    relation: { type: 'string', enum: ['supports', 'contradicts', 'depends-on', 'answers', 'duplicate-of'] }, evidenceUtteranceIds: evidenceIds,
  },
} as const;

export const analysisOutputJsonSchema = {
  type: 'object', additionalProperties: false,
  required: ['contractVersion', 'baseRevision', 'operations'],
  properties: {
    contractVersion: { type: 'integer', const: 1 },
    baseRevision: { type: 'integer', minimum: 0 },
    operations: { type: 'array', maxItems: 40, items: { anyOf: [addOperation, updateOperation, mergeOperation, retractOperation, linkOperation] } },
  },
} as const;

export const analysisStructuredOutput = {
  type: 'json_schema', name: 'techmap_analysis_delta_v1', strict: true, schema: analysisOutputJsonSchema,
} as const;

export const analysisSchemaHash = 'da30899848561bebde76b8da3c4ee226ed9ecdbd66af83666ae3aeea9161f7ea';
