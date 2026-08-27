import { assertRedactedTextAtRuntime, type RedactedText } from '../../domain/privacy/redaction.ts';

export const openAiResponsesEndpoint = 'https://api.openai.com/v1/responses';
export const openAiTimeoutMilliseconds = 20_000;
export const openAiAutomaticRetryCount = 0;

export type PrivacySafeResponsesRequest = Readonly<{
  model: string;
  store: false;
  input: ReadonlyArray<Readonly<{ role: 'user'; content: ReadonlyArray<Readonly<{ type: 'input_text'; text: RedactedText }>> }>>;
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

export function assertPrivacySafeResponsesRequest(value: unknown): asserts value is PrivacySafeResponsesRequest {
  if (typeof value !== 'object' || value === null || (value as Record<string, unknown>).store !== false) {
    throw new Error('Responses request must force store:false');
  }
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'input,model,store') throw new Error('Responses request contains a forbidden field');
  const request = value as Record<string, unknown>;
  if (typeof request.model !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(request.model) || !Array.isArray(request.input) || request.input.length !== 1) throw new Error('Responses request schema is invalid');
  const message = request.input[0] as Record<string, unknown>;
  if (typeof message !== 'object' || message === null || Object.keys(message).sort().join(',') !== 'content,role' || message.role !== 'user' || !Array.isArray(message.content) || message.content.length !== 1) throw new Error('Responses request schema is invalid');
  const content = message.content[0] as Record<string, unknown>;
  if (typeof content !== 'object' || content === null || Object.keys(content).sort().join(',') !== 'text,type' || content.type !== 'input_text') throw new Error('Responses request schema is invalid');
  assertRedactedTextAtRuntime(content.text);
  const serialized = JSON.stringify(value);
  if (serialized.length > 12_000) throw new Error('Responses request exceeds the minimum-context boundary');
}

export function assertAllowedRuntimeEgress(url: string): URL {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'api.openai.com' || parsed.port !== '' || parsed.pathname !== '/v1/responses' || parsed.search || parsed.hash) {
    throw new Error('Runtime egress destination is not allowed');
  }
  return parsed;
}
