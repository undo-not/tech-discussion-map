import type { TranscriptUtterance } from '../transcription/utterance.ts';

declare const redactedBrand: unique symbol;
export type RedactedText = string & { readonly [redactedBrand]: true };

export type RedactionCategory = 'api-key' | 'credential' | 'email' | 'phone' | 'ip-address' | 'url-query';
export type RedactionSummary = Record<RedactionCategory, number>;
export type RedactionResult = { ok: true; text: RedactedText; summary: RedactionSummary } | { ok: false; reason: string };

const maximumInputCharacters = 20_000;
const maximumOutputCharacters = 8_000;
const forbiddenAfterRedaction = /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~-]{16,})\b/i;

const rules: ReadonlyArray<{ category: RedactionCategory; pattern: RegExp; replacement: string }> = [
  { category: 'api-key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/gi, replacement: '[REDACTED_API_KEY]' },
  { category: 'credential', pattern: /\b(?:password|passwd|pwd|secret|token)\s*[:=]\s*[^\s,;]{4,}/gi, replacement: '[REDACTED_CREDENTIAL]' },
  { category: 'email', pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, replacement: '[REDACTED_EMAIL]' },
  { category: 'phone', pattern: /(?<!\d)(?:\+?81[- ]?|0)\d{1,4}[- ]?\d{1,4}[- ]?\d{3,4}(?!\d)/g, replacement: '[REDACTED_PHONE]' },
  { category: 'ip-address', pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g, replacement: '[REDACTED_IP]' },
  { category: 'url-query', pattern: /\bhttps?:\/\/[^\s?#]+\?[^\s#]+/gi, replacement: '[REDACTED_URL_WITH_QUERY]' },
] as const;

function emptySummary(): RedactionSummary {
  return { 'api-key': 0, credential: 0, email: 0, phone: 0, 'ip-address': 0, 'url-query': 0 };
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

export function redactText(input: string): RedactionResult {
  if (input.length === 0 || input.length > maximumInputCharacters) return { ok: false, reason: 'redaction-input-out-of-bounds' };
  if (hasUnpairedSurrogate(input) || input.includes('\0')) return { ok: false, reason: 'redaction-input-invalid' };
  const summary = emptySummary();
  let output = input.normalize('NFC');
  for (const rule of rules) {
    output = output.replace(rule.pattern, () => { summary[rule.category] += 1; return rule.replacement; });
  }
  output = output.trim();
  if (output.length === 0 || output.length > maximumOutputCharacters || forbiddenAfterRedaction.test(output)) {
    return { ok: false, reason: 'redaction-verification-failed' };
  }
  return { ok: true, text: output as RedactedText, summary };
}

export function createMinimalUtteranceWindow(utterances: TranscriptUtterance[], maximumItems = 8): RedactionResult {
  const finals = utterances.filter((item) => item.phase === 'final').slice(-Math.max(1, Math.min(maximumItems, 12)));
  if (finals.length === 0) return { ok: false, reason: 'redaction-window-empty' };
  return redactText(finals.map((item) => `[${item.id}|${item.source}|${item.startMs}-${item.endMs}] ${item.text}`).join('\n'));
}

export { maximumInputCharacters, maximumOutputCharacters };
