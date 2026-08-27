export const utteranceSources = ['local', 'remote', 'synthetic'] as const;
export const utterancePhases = ['partial', 'final'] as const;
export const speakerLabels = ['self', 'remote-group', 'unknown'] as const;

export type UtteranceSource = (typeof utteranceSources)[number];
export type UtterancePhase = (typeof utterancePhases)[number];
export type SpeakerLabel = (typeof speakerLabels)[number];

export type TranscriptUtterance = {
  id: string;
  revision: number;
  phase: UtterancePhase;
  source: UtteranceSource;
  speaker: SpeakerLabel;
  startMs: number;
  endMs: number;
  text: string;
};

export type TranscriptState = {
  utterances: TranscriptUtterance[];
  finalForAnalysis: TranscriptUtterance[];
};

const safeId = /^[a-zA-Z0-9_-]{1,80}$/;

export function parseTranscriptUtterance(value: unknown): TranscriptUtterance {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid transcript event');
  const item = value as Record<string, unknown>;
  if (
    typeof item.id !== 'string' || !safeId.test(item.id) ||
    !Number.isSafeInteger(item.revision) || (item.revision as number) < 0 ||
    !utterancePhases.includes(item.phase as UtterancePhase) ||
    !utteranceSources.includes(item.source as UtteranceSource) ||
    !speakerLabels.includes(item.speaker as SpeakerLabel) ||
    !Number.isSafeInteger(item.startMs) || (item.startMs as number) < 0 ||
    !Number.isSafeInteger(item.endMs) || (item.endMs as number) < (item.startMs as number) ||
    typeof item.text !== 'string' || item.text.length > 8_000
  ) {
    throw new Error('Invalid transcript event');
  }
  return {
    id: item.id,
    revision: item.revision as number,
    phase: item.phase as UtterancePhase,
    source: item.source as UtteranceSource,
    speaker: item.speaker as SpeakerLabel,
    startMs: item.startMs as number,
    endMs: item.endMs as number,
    text: item.text.trim(),
  };
}

export function applyTranscriptEvent(state: TranscriptState, candidate: unknown): TranscriptState {
  const incoming = parseTranscriptUtterance(candidate);
  if (incoming.text.length === 0) return state;

  const existing = state.utterances.find((item) => item.id === incoming.id);
  if (existing && incoming.revision <= existing.revision) return state;
  if (existing?.phase === 'final' && incoming.phase === 'partial') return state;

  const utterances = state.utterances
    .filter((item) => item.id !== incoming.id)
    .concat(incoming)
    .sort((left, right) => left.startMs - right.startMs || left.id.localeCompare(right.id));
  const isNewFinal = incoming.phase === 'final' && (existing?.phase !== 'final' || existing.text !== incoming.text);

  return {
    utterances,
    finalForAnalysis: isNewFinal ? state.finalForAnalysis.concat(incoming) : state.finalForAnalysis,
  };
}

export const emptyTranscriptState: TranscriptState = { utterances: [], finalForAnalysis: [] };
