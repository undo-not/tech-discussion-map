import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyCaptionSourceEvent,
  captionSettleMilliseconds,
  emptyCaptionAssemblerState,
  transitionCaptionSource,
} from '../domain/transcription/caption-source.ts';
import { applyTranscriptEvent, emptyTranscriptState, parseTranscriptUtterance } from '../domain/transcription/utterance.ts';

const observation = {
  rowId: 'row-1',
  revision: 1,
  source: 'teams-uia',
  speaker: 'displayed-alias',
  speakerAlias: 'speaker-1',
  observedAtMs: 1_000,
  text: '合成された設計案',
};
const activeUiaState = { ...emptyCaptionAssemblerState, sourceState: 'active-uia' };
const activeOcrState = { ...emptyCaptionAssemblerState, sourceState: 'active-ocr' };

test('caption rewrites become one partial followed by a deterministic final', () => {
  let assembled = applyCaptionSourceEvent(activeUiaState, { type: 'observation', observation });
  assert.equal(assembled.utterances[0].phase, 'partial');
  assembled = applyCaptionSourceEvent(assembled.state, {
    type: 'observation',
    observation: { ...observation, revision: 2, observedAtMs: 1_300, text: '合成された設計案を確認します' },
  });
  assert.equal(assembled.utterances[0].revision, 4);
  const settled = applyCaptionSourceEvent(assembled.state, { type: 'tick', observedAtMs: 1_300 + captionSettleMilliseconds });
  assert.equal(settled.utterances[0].phase, 'final');
  assert.equal(settled.utterances[0].revision, 5);
  assert.equal(settled.utterances[0].speakerAlias, 'speaker-1');
});

test('duplicates are ignored and a later correction is emitted as corrected final', () => {
  let assembled = applyCaptionSourceEvent(activeUiaState, { type: 'observation', observation });
  const duplicate = applyCaptionSourceEvent(assembled.state, { type: 'observation', observation });
  assert.equal(duplicate.utterances.length, 0);
  assembled = applyCaptionSourceEvent(assembled.state, { type: 'row-disappeared', rowId: 'row-1', observedAtMs: 1_100 });
  const corrected = applyCaptionSourceEvent(assembled.state, {
    type: 'observation',
    observation: { ...observation, revision: 2, observedAtMs: 1_400, text: '合成された訂正版' },
  });
  assert.equal(corrected.utterances[0].phase, 'final');
  let transcript = applyTranscriptEvent(emptyTranscriptState, assembled.utterances[0]);
  transcript = applyTranscriptEvent(transcript, corrected.utterances[0]);
  assert.equal(transcript.utterances[0].text, '合成された訂正版');
  assert.equal(transcript.finalForAnalysis.length, 2);
  assert.throws(() => applyCaptionSourceEvent(corrected.state, {
    type: 'observation',
    observation: { ...observation, revision: 3, observedAtMs: 1_200, text: '時刻が逆行した更新' },
  }), /caption-clock-regressed/);
});

test('low-confidence OCR fails closed without emitting meeting text', () => {
  const result = applyCaptionSourceEvent(activeOcrState, {
    type: 'observation',
    observation: { ...observation, source: 'teams-ocr', confidence: 84 },
  });
  assert.equal(result.state.sourceState, 'active-ocr');
  assert.equal(result.signal, 'low-confidence');
  assert.deepEqual(result.utterances, []);
  assert.equal(transitionCaptionSource(result.state.sourceState, { type: result.signal }), 'degraded-low-confidence');
});

test('OCR engines without confidence require two identical stable samples', () => {
  const unstable = applyCaptionSourceEvent(activeOcrState, {
    type: 'observation',
    observation: { ...observation, source: 'teams-ocr', stableSamples: 1 },
  });
  assert.equal(unstable.state.sourceState, 'active-ocr');
  assert.equal(unstable.signal, 'low-confidence');
  assert.deepEqual(unstable.utterances, []);
  const stable = applyCaptionSourceEvent(activeOcrState, {
    type: 'observation',
    observation: { ...observation, source: 'teams-ocr', stableSamples: 2 },
  });
  assert.equal(stable.state.sourceState, 'active-ocr');
  assert.equal(stable.utterances[0].text, observation.text);
});

test('only bounded aliases cross the caption domain boundary', () => {
  assert.throws(() => applyCaptionSourceEvent(activeUiaState, {
    type: 'observation',
    observation: { ...observation, speakerAlias: 'Example Person' },
  }), /invalid-caption-observation/);
  assert.throws(() => parseTranscriptUtterance({
    id: 'caption_row-1', revision: 1, phase: 'partial', source: 'teams-caption',
    speaker: 'displayed-alias', speakerAlias: 'Example Person', startMs: 0, endMs: 1, text: 'synthetic',
  }), /Invalid transcript event/);
  assert.doesNotThrow(() => parseTranscriptUtterance({
    id: 'caption_row-1', revision: 1, phase: 'partial', source: 'teams-caption',
    speaker: 'anonymous', startMs: 0, endMs: 1, text: 'synthetic',
  }));
});

test('observation cannot activate or switch a selected source', () => {
  assert.throws(() => applyCaptionSourceEvent(emptyCaptionAssemblerState, {
    type: 'observation', observation,
  }), /caption-source-not-active/);
  assert.throws(() => applyCaptionSourceEvent(activeUiaState, {
    type: 'observation', observation: { ...observation, source: 'teams-ocr', confidence: 95 },
  }), /caption-source-not-active/);
});

test('OCR quality signals are mutually exclusive and recovery is explicit', () => {
  assert.throws(() => applyCaptionSourceEvent(activeOcrState, {
    type: 'observation',
    observation: { ...observation, source: 'teams-ocr', confidence: 10, stableSamples: 2 },
  }), /invalid-caption-observation/);
  const degraded = transitionCaptionSource('active-ocr', { type: 'low-confidence' });
  assert.throws(() => applyCaptionSourceEvent({ sourceState: degraded, rows: [] }, {
    type: 'observation', observation: { ...observation, source: 'teams-ocr', confidence: 95 },
  }), /caption-source-not-active/);
  assert.equal(transitionCaptionSource(degraded, { type: 'quality-recovered' }), 'active-ocr');
});

test('timer interleaving ignores rows newer than the tick', () => {
  let assembled = applyCaptionSourceEvent(activeUiaState, { type: 'observation', observation });
  assembled = applyCaptionSourceEvent(assembled.state, {
    type: 'observation',
    observation: { ...observation, rowId: 'row-2', observedAtMs: 2_000 },
  });
  const ticked = applyCaptionSourceEvent(assembled.state, {
    type: 'tick', observedAtMs: 1_000 + captionSettleMilliseconds,
  });
  assert.equal(ticked.utterances.length, 1);
  assert.equal(ticked.utterances[0].id, 'caption_row-1');
  assert.throws(() => applyCaptionSourceEvent(assembled.state, {
    type: 'row-disappeared', rowId: 'row-2', observedAtMs: 1_999,
  }), /caption-clock-regressed/);
});

test('caption capture cannot activate before consent and explicit target selection', () => {
  let state = transitionCaptionSource('idle', { type: 'prepare' });
  assert.equal(state, 'awaiting-consent');
  assert.equal(transitionCaptionSource(state, { type: 'uia-connected' }), 'awaiting-consent');
  state = transitionCaptionSource(state, { type: 'consent-confirmed' });
  assert.equal(state, 'selecting-target');
  state = transitionCaptionSource(state, { type: 'uia-connected' });
  assert.equal(state, 'active-uia');
  state = transitionCaptionSource(state, { type: 'caption-missing' });
  assert.equal(state, 'degraded-caption-missing');
  assert.equal(transitionCaptionSource(state, { type: 'ocr-connected' }), 'active-ocr');
  assert.equal(transitionCaptionSource('idle', { type: 'ocr-connected' }), 'idle');
});
