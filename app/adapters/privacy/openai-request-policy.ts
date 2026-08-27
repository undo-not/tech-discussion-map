import { assertRedactedTextAtRuntime, type RedactedText } from '../../domain/privacy/redaction.ts';

export const openAiResponsesEndpoint = 'https://api.openai.com/v1/responses';
export const openAiTimeoutMilliseconds = 20_000;
export const openAiAutomaticRetryCount = 0;

export type PrivacySafeResponsesRequest = Readonly<{
  model: string;
  store: false;
  input: ReadonlyArray<Readonly<{ role: 'user'; content: ReadonlyArray<Readonly<{ type: 'input_text'; text: RedactedText }>> }>>;
}>;
export type PrivacySafeStructuredResponsesRequest = PrivacySafeResponsesRequest & Readonly<{
  text: Readonly<{ format: Readonly<{ type: 'json_schema'; name: string; strict: true; schema: Readonly<Record<string, unknown>> }> }>;
}>;

export function createPrivacySafeResponsesRequest(model: string, text: RedactedText): PrivacySafeResponsesRequest {
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(model)) throw new Error('Invalid OpenAI model identifier');
  assertRedactedTextAtRuntime(text);
  return Object.freeze({
    model,
    store: false as const,
    input: Object.freeze([{ role: 'user' as const, content: Object.freeze([{ type: 'input_text' as const, text }]) }]),
  });
}

export function createPrivacySafeStructuredResponsesRequest(
  model: string,
  text: RedactedText,
  format: PrivacySafeStructuredResponsesRequest['text']['format'],
): PrivacySafeStructuredResponsesRequest {
  const base = createPrivacySafeResponsesRequest(model, text);
  if (format.type !== 'json_schema' || format.strict !== true || !/^[a-z0-9_-]{1,64}$/i.test(format.name) || typeof format.schema !== 'object' || format.schema === null) throw new Error('Invalid structured output format');
  const request = Object.freeze({ ...base, text: Object.freeze({ format: structuredClone(format) }) });
  assertPrivacySafeResponsesRequest(request);
  return request;
}

export function assertPrivacySafeResponsesRequest(value: unknown): asserts value is PrivacySafeResponsesRequest {
  if (typeof value !== 'object' || value === null || (value as Record<string, unknown>).store !== false) {
    throw new Error('Responses request must force store:false');
  }
  const keys = Object.keys(value).sort();
  if (!['input,model,store', 'input,model,store,text'].includes(keys.join(','))) throw new Error('Responses request contains a forbidden field');
  const request = value as Record<string, unknown>;
  if (typeof request.model !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(request.model) || !Array.isArray(request.input) || request.input.length !== 1) throw new Error('Responses request schema is invalid');
  const message = request.input[0] as Record<string, unknown>;
  if (typeof message !== 'object' || message === null || Object.keys(message).sort().join(',') !== 'content,role' || message.role !== 'user' || !Array.isArray(message.content) || message.content.length !== 1) throw new Error('Responses request schema is invalid');
  const content = message.content[0] as Record<string, unknown>;
  if (typeof content !== 'object' || content === null || Object.keys(content).sort().join(',') !== 'text,type' || content.type !== 'input_text') throw new Error('Responses request schema is invalid');
  assertRedactedTextAtRuntime(content.text);
  if ('text' in request) {
    const textConfiguration = request.text as Record<string, unknown>;
    const format = textConfiguration?.format as Record<string, unknown>;
    if (typeof textConfiguration !== 'object' || textConfiguration === null || Object.keys(textConfiguration).join(',') !== 'format' || typeof format !== 'object' || format === null || Object.keys(format).sort().join(',') !== 'name,schema,strict,type' || format.type !== 'json_schema' || format.strict !== true || typeof format.name !== 'string' || !/^[a-z0-9_-]{1,64}$/i.test(format.name) || typeof format.schema !== 'object' || format.schema === null) throw new Error('Responses structured output schema is invalid');
  }
  const serialized = JSON.stringify(value);
  if (serialized.length > 32_000 || /"(?:previous_response_id|conversation|background|tools|file_ids|metadata)"\s*:/.test(serialized)) throw new Error('Responses request exceeds the minimum-context boundary');
}

export function assertAllowedRuntimeEgress(url: string): URL {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'api.openai.com' || parsed.port !== '' || parsed.pathname !== '/v1/responses' || parsed.search || parsed.hash) {
    throw new Error('Runtime egress destination is not allowed');
  }
  return parsed;
}
