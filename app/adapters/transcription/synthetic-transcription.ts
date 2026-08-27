import type { TranscriptUtterance } from '../../domain/transcription/utterance.ts';

const script = [
  '合成入力で文字起こし経路を確認しています。',
  '実際の会議音声や社外秘情報は含まれていません。',
  'ローカルエンジンを準備すると、同じ発話契約へ切り替わります。',
] as const;

export function createSyntheticTranscription(onUtterance: (event: TranscriptUtterance) => void) {
  let index = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const emit = () => {
    if (stopped || index >= script.length) return;
    const id = `synthetic-${index + 1}`;
    const text = script[index];
    onUtterance({ id, revision: 0, phase: 'partial', source: 'synthetic', speaker: 'unknown', startMs: index * 2_000, endMs: index * 2_000 + 1_200, text: text.slice(0, Math.max(1, Math.floor(text.length / 2))) });
    timer = setTimeout(() => {
      onUtterance({ id, revision: 1, phase: 'final', source: 'synthetic', speaker: 'unknown', startMs: index * 2_000, endMs: index * 2_000 + 1_800, text });
      index += 1;
      timer = setTimeout(emit, 450);
    }, 500);
  };

  return {
    start() { if (!stopped) emit(); },
    pause() { if (timer) clearTimeout(timer); },
    resume() { if (!stopped) emit(); },
    stop() { stopped = true; if (timer) clearTimeout(timer); },
  };
}
