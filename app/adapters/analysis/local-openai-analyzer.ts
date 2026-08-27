import { consumeLocalLaunchSecret } from '../companion/launch-secret.ts';
import { createPrivacySafeStructuredResponsesRequest } from '../privacy/openai-request-policy.ts';
import { parseAnalyzerOutput, type AnalysisDelta, type AnalysisState } from '../../domain/analysis/contract.ts';
import { analysisPromptHash, createRedactedAnalysisInput } from '../../domain/analysis/prompt.ts';
import { analysisSchemaHash, analysisStructuredOutput } from '../../domain/analysis/schema.ts';
import type { RedactedText } from '../../domain/privacy/redaction.ts';

const companionOrigin = 'http://127.0.0.1:43117';
const timeoutMilliseconds = 20_000;

function companionUrl(path: string): URL {
  const url = new URL(path, companionOrigin);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port !== '43117') throw new Error('analysis-companion-must-remain-loopback');
  return url;
}

function extractOutputText(value: unknown): string {
  if (typeof value !== 'object' || value === null) throw new Error('analysis-invalid-openai-response');
  const response = value as Record<string, unknown>;
  if (response.status !== 'completed' || !Array.isArray(response.output)) throw new Error('analysis-openai-incomplete');
  const texts: string[] = [];
  for (const output of response.output) {
    if (typeof output !== 'object' || output === null || !Array.isArray((output as Record<string, unknown>).content)) continue;
    for (const content of (output as { content: unknown[] }).content) {
      if (typeof content !== 'object' || content === null) continue;
      const item = content as Record<string, unknown>;
      if (item.type === 'refusal') throw new Error('analysis-openai-refusal');
      if (item.type === 'output_text' && typeof item.text === 'string') texts.push(item.text);
    }
  }
  if (texts.length !== 1 || texts[0].length === 0 || texts[0].length > 64_000) throw new Error('analysis-invalid-openai-output');
  return texts[0];
}

export class LocalOpenAiAnalyzer {
  #token = '';

  async analyze(model: string, redactedWindow: RedactedText, state: AnalysisState): Promise<AnalysisDelta> {
    if (!this.#token) await this.#connect();
    const redactedInput = createRedactedAnalysisInput(redactedWindow, state);
    const request = createPrivacySafeStructuredResponsesRequest(model, redactedInput, analysisStructuredOutput);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMilliseconds);
    try {
      const response = await fetch(companionUrl('/v1/analysis'), {
        method: 'POST', credentials: 'omit', cache: 'no-store', signal: controller.signal,
        headers: { Authorization: `Bearer ${this.#token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(request),
      });
      if (!response.ok) throw new Error(`analysis-companion-${response.status}`);
      const output = parseAnalyzerOutput(JSON.parse(extractOutputText(await response.json())));
      return { ...output, deltaId: crypto.randomUUID(), model, promptHash: analysisPromptHash, schemaHash: analysisSchemaHash };
    } finally { clearTimeout(timeout); }
  }

  async #connect(): Promise<void> {
    const response = await fetch(companionUrl('/v1/bootstrap'), {
      method: 'POST', credentials: 'omit', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ launchSecret: consumeLocalLaunchSecret() }),
    });
    if (!response.ok) throw new Error(`analysis-bootstrap-${response.status}`);
    const value = await response.json() as { token?: unknown };
    if (typeof value.token !== 'string' || !/^[a-f0-9]{64}$/.test(value.token)) throw new Error('analysis-invalid-bootstrap');
    this.#token = value.token;
  }
}

export { companionUrl as analysisCompanionUrl, extractOutputText };
