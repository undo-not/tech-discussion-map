import type { CaptionSourceEvent } from '../../domain/transcription/caption-source.ts';

export const captionRuntimeStates = ['selecting-target', 'active-ocr', 'degraded-caption-missing', 'degraded-low-confidence', 'stopped'] as const;
export type CaptionRuntimeState = (typeof captionRuntimeStates)[number];
export type CaptionRuntimeEvent =
  | { type: 'state'; state: CaptionRuntimeState; reason: string }
  | CaptionSourceEvent;

const reasons = new Set([
  'user-selection-required', 'capture-started', 'selection-cancelled', 'teams-not-foreground', 'teams-not-visible',
  'teams-minimized', 'teams-window-unavailable', 'selection-invalid', 'selection-outside-client', 'selection-too-large',
  'selection-covered', 'dpi-changed', 'capture-unsupported', 'ocr-timeout', 'ocr-unavailable', 'low-confidence', 'user-stopped',
]);
const rowIdPattern = /^ocr-[a-f0-9]{8}-[1-9][0-9]{0,8}$/;
const aliasPattern = /^speaker-[1-9][0-9]{0,2}$/;

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

export function parseCaptionRuntimeEvent(value: unknown): CaptionRuntimeEvent {
  if (typeof value !== 'object' || value === null) throw new Error('invalid-caption-runtime-event');
  const item = value as Record<string, unknown>;
  if (item.v !== 1 || typeof item.type !== 'string') throw new Error('invalid-caption-runtime-event');
  if (item.type === 'state') {
    if (!exactKeys(item, ['reason', 'state', 'type', 'v']) || !captionRuntimeStates.includes(item.state as CaptionRuntimeState) ||
        typeof item.reason !== 'string' || !reasons.has(item.reason)) throw new Error('invalid-caption-runtime-state');
    return { type: 'state', state: item.state as CaptionRuntimeState, reason: item.reason };
  }
  if (item.type === 'observation') {
    const hasAlias = item.speaker === 'displayed-alias';
    const expected = hasAlias
      ? ['confidence', 'observedAtMs', 'revision', 'rowId', 'source', 'speaker', 'speakerAlias', 'text', 'type', 'v']
      : ['confidence', 'observedAtMs', 'revision', 'rowId', 'source', 'speaker', 'text', 'type', 'v'];
    if (!exactKeys(item, expected) || typeof item.rowId !== 'string' || !rowIdPattern.test(item.rowId) ||
        !Number.isSafeInteger(item.revision) || (item.revision as number) < 1 || item.source !== 'teams-ocr' ||
        !['displayed-alias', 'anonymous', 'unknown'].includes(item.speaker as string) ||
        (hasAlias ? typeof item.speakerAlias !== 'string' || !aliasPattern.test(item.speakerAlias) : item.speakerAlias !== undefined) ||
        !Number.isSafeInteger(item.observedAtMs) || (item.observedAtMs as number) < 0 ||
        typeof item.text !== 'string' || item.text.length === 0 || item.text.length > 8_000 ||
        !Number.isInteger(item.confidence) || (item.confidence as number) < 85 || (item.confidence as number) > 100) {
      throw new Error('invalid-caption-runtime-observation');
    }
    return {
      type: 'observation',
      observation: {
        rowId: item.rowId,
        revision: item.revision as number,
        source: 'teams-ocr',
        speaker: item.speaker as 'displayed-alias' | 'anonymous' | 'unknown',
        ...(typeof item.speakerAlias === 'string' ? { speakerAlias: item.speakerAlias } : {}),
        observedAtMs: item.observedAtMs as number,
        text: item.text,
        confidence: item.confidence as number,
      },
    };
  }
  if (item.type === 'row-disappeared') {
    if (!exactKeys(item, ['observedAtMs', 'rowId', 'type', 'v']) || typeof item.rowId !== 'string' || !rowIdPattern.test(item.rowId) ||
        !Number.isSafeInteger(item.observedAtMs) || (item.observedAtMs as number) < 0) throw new Error('invalid-caption-runtime-row');
    return { type: 'row-disappeared', rowId: item.rowId, observedAtMs: item.observedAtMs as number };
  }
  if (item.type === 'tick') {
    if (!exactKeys(item, ['observedAtMs', 'type', 'v']) || !Number.isSafeInteger(item.observedAtMs) || (item.observedAtMs as number) < 0) {
      throw new Error('invalid-caption-runtime-tick');
    }
    return { type: 'tick', observedAtMs: item.observedAtMs as number };
  }
  throw new Error('unknown-caption-runtime-event');
}
