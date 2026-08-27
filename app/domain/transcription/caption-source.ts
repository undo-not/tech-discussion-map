import type { SpeakerLabel, TranscriptUtterance } from './utterance.ts';

export const captionObservationSources = ['teams-uia', 'teams-ocr'] as const;
export const captionSourceStates = [
  'idle',
  'awaiting-consent',
  'selecting-target',
  'active-uia',
  'active-ocr',
  'degraded-caption-missing',
  'degraded-low-confidence',
  'stopped',
] as const;

export type CaptionObservationSource = (typeof captionObservationSources)[number];
export type CaptionSourceState = (typeof captionSourceStates)[number];

export type SafeCaptionObservation = {
  rowId: string;
  revision: number;
  source: CaptionObservationSource;
  speaker: Extract<SpeakerLabel, 'self' | 'displayed-alias' | 'anonymous' | 'unknown'>;
  speakerAlias?: string;
  observedAtMs: number;
  text: string;
  confidence?: number;
  stableSamples?: number;
};

type CaptionRow = {
  observation: SafeCaptionObservation;
  firstObservedAtMs: number;
  finalized: boolean;
};

export type CaptionAssemblerState = {
  sourceState: CaptionSourceState;
  rows: CaptionRow[];
};

export type CaptionAssemblerResult = {
  state: CaptionAssemblerState;
  utterances: TranscriptUtterance[];
};

export type CaptionSourceEvent =
  | { type: 'observation'; observation: unknown }
  | { type: 'row-disappeared'; rowId: string; observedAtMs: number }
  | { type: 'tick'; observedAtMs: number };

const safeRowId = /^[a-zA-Z0-9_-]{1,64}$/;
const safeSpeakerAlias = /^speaker-[1-9][0-9]{0,2}$/;
const maximumRows = 256;
const maximumCaptionRevision = Math.floor((Number.MAX_SAFE_INTEGER - 1) / 2);
export const minimumOcrConfidence = 85;
export const minimumOcrStableSamples = 2;
export const captionSettleMilliseconds = 1_200;

export const emptyCaptionAssemblerState: CaptionAssemblerState = { sourceState: 'idle', rows: [] };

function parseSafeCaptionObservation(value: unknown): SafeCaptionObservation {
  if (typeof value !== 'object' || value === null) throw new Error('invalid-caption-observation');
  const item = value as Record<string, unknown>;
  const source = item.source as CaptionObservationSource;
  const speaker = item.speaker as SafeCaptionObservation['speaker'];
  const confidenceIsValid = source === 'teams-ocr'
    ? item.confidence === undefined || (Number.isInteger(item.confidence) && (item.confidence as number) >= 0 && (item.confidence as number) <= 100)
    : item.confidence === undefined;
  const stableSamplesIsValid = source === 'teams-ocr'
    ? item.stableSamples === undefined || (Number.isInteger(item.stableSamples) && (item.stableSamples as number) >= 1 && (item.stableSamples as number) <= 10)
    : item.stableSamples === undefined;
  const aliasIsValid = speaker === 'displayed-alias'
    ? typeof item.speakerAlias === 'string' && safeSpeakerAlias.test(item.speakerAlias)
    : item.speakerAlias === undefined;
  if (
    typeof item.rowId !== 'string' || !safeRowId.test(item.rowId) ||
    !Number.isSafeInteger(item.revision) || (item.revision as number) < 0 || (item.revision as number) > maximumCaptionRevision ||
    !captionObservationSources.includes(source) ||
    !['self', 'displayed-alias', 'anonymous', 'unknown'].includes(speaker) ||
    !aliasIsValid ||
    !Number.isSafeInteger(item.observedAtMs) || (item.observedAtMs as number) < 0 ||
    typeof item.text !== 'string' || item.text.trim().length === 0 || item.text.length > 8_000 ||
    !confidenceIsValid || !stableSamplesIsValid
  ) {
    throw new Error('invalid-caption-observation');
  }
  return {
    rowId: item.rowId,
    revision: item.revision as number,
    source,
    speaker,
    ...(typeof item.speakerAlias === 'string' ? { speakerAlias: item.speakerAlias } : {}),
    observedAtMs: item.observedAtMs as number,
    text: item.text.trim(),
    ...(typeof item.confidence === 'number' ? { confidence: item.confidence } : {}),
    ...(typeof item.stableSamples === 'number' ? { stableSamples: item.stableSamples } : {}),
  };
}

function toUtterance(row: CaptionRow, phase: 'partial' | 'final'): TranscriptUtterance {
  const observation = row.observation;
  return {
    id: `caption_${observation.rowId}`,
    revision: observation.revision * 2 + (phase === 'final' ? 1 : 0),
    phase,
    source: 'teams-caption',
    speaker: observation.speaker,
    ...(observation.speakerAlias ? { speakerAlias: observation.speakerAlias } : {}),
    startMs: row.firstObservedAtMs,
    endMs: observation.observedAtMs,
    text: observation.text,
  };
}

function pruneRows(rows: CaptionRow[]): CaptionRow[] {
  if (rows.length <= maximumRows) return rows;
  const finalized = rows.filter((row) => row.finalized).sort((left, right) => left.observation.observedAtMs - right.observation.observedAtMs);
  const required = rows.length - maximumRows;
  if (finalized.length < required) throw new Error('caption-row-capacity-exceeded');
  const remove = new Set(finalized.slice(0, required));
  return rows.filter((row) => !remove.has(row));
}

export function applyCaptionSourceEvent(
  current: CaptionAssemblerState,
  event: CaptionSourceEvent,
): CaptionAssemblerResult {
  if (event.type === 'observation') {
    const incoming = parseSafeCaptionObservation(event.observation);
    const ocrQualityAccepted = incoming.source !== 'teams-ocr' ||
      (typeof incoming.confidence === 'number' && incoming.confidence >= minimumOcrConfidence) ||
      (typeof incoming.stableSamples === 'number' && incoming.stableSamples >= minimumOcrStableSamples);
    if (!ocrQualityAccepted) {
      return { state: { ...current, sourceState: 'degraded-low-confidence' }, utterances: [] };
    }
    const existing = current.rows.find((row) => row.observation.rowId === incoming.rowId);
    if (existing && incoming.revision <= existing.observation.revision) return { state: current, utterances: [] };
    if (existing && incoming.observedAtMs < existing.observation.observedAtMs) throw new Error('caption-clock-regressed');
    const row: CaptionRow = {
      observation: incoming,
      firstObservedAtMs: existing?.firstObservedAtMs ?? incoming.observedAtMs,
      finalized: existing?.finalized ?? false,
    };
    const rows = pruneRows(current.rows.filter((candidate) => candidate.observation.rowId !== incoming.rowId).concat(row));
    return {
      state: { sourceState: incoming.source === 'teams-uia' ? 'active-uia' : 'active-ocr', rows },
      utterances: [toUtterance(row, row.finalized ? 'final' : 'partial')],
    };
  }

  if (!Number.isSafeInteger(event.observedAtMs) || event.observedAtMs < 0) throw new Error('invalid-caption-clock');
  if (event.type === 'row-disappeared' && !safeRowId.test(event.rowId)) throw new Error('invalid-caption-row');
  if (current.rows.some((row) => row.observation.observedAtMs > event.observedAtMs)) throw new Error('caption-clock-regressed');
  const finalized: TranscriptUtterance[] = [];
  const rows = current.rows.map((row) => {
    const shouldFinalize = !row.finalized && (
      (event.type === 'row-disappeared' && row.observation.rowId === event.rowId) ||
      (event.type === 'tick' && event.observedAtMs - row.observation.observedAtMs >= captionSettleMilliseconds)
    );
    if (!shouldFinalize) return row;
    const next = { ...row, finalized: true };
    finalized.push(toUtterance(next, 'final'));
    return next;
  });
  return { state: { ...current, rows }, utterances: finalized };
}

export type CaptionSourceSessionEvent =
  | { type: 'prepare' }
  | { type: 'consent-confirmed' }
  | { type: 'uia-connected' }
  | { type: 'ocr-connected' }
  | { type: 'caption-missing' }
  | { type: 'low-confidence' }
  | { type: 'stop' };

export function transitionCaptionSource(current: CaptionSourceState, event: CaptionSourceSessionEvent): CaptionSourceState {
  switch (event.type) {
    case 'prepare':
      return current === 'idle' || current === 'stopped' ? 'awaiting-consent' : current;
    case 'consent-confirmed':
      return current === 'awaiting-consent' ? 'selecting-target' : current;
    case 'uia-connected':
      return current === 'selecting-target' ? 'active-uia' : current;
    case 'ocr-connected':
      return current === 'selecting-target' || current === 'degraded-caption-missing' ? 'active-ocr' : current;
    case 'caption-missing':
      return current === 'active-uia' || current === 'active-ocr' ? 'degraded-caption-missing' : current;
    case 'low-confidence':
      return current === 'active-ocr' ? 'degraded-low-confidence' : current;
    case 'stop':
      return 'stopped';
  }
}
