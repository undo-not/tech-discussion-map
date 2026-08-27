'use client';

import { useEffect, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import { isLoopbackRuntime, listMicrophones, startMicrophoneCapture, type MicrophoneCapture, type MicrophoneDevice } from '@/adapters/audio/browser-microphone.ts';
import { deleteAllLocalTranscripts, localTranscriptStorageDescription, saveFinalTranscript } from '@/adapters/persistence/transcript-store.ts';
import { LocalCompanionTranscriptionClient } from '@/adapters/transcription/local-companion-client.ts';
import { createSyntheticTranscription } from '@/adapters/transcription/synthetic-transcription.ts';
import { transitionTranscriptionSession, type TranscriptionSessionEvent, type TranscriptionSessionState } from '@/domain/transcription/session.ts';
import { applyTranscriptEvent, emptyTranscriptState, type TranscriptUtterance } from '@/domain/transcription/utterance.ts';

const stateLabels: Record<TranscriptionSessionState, string> = {
  idle: '待機中',
  'requesting-permission': 'マイク許可を確認中',
  'starting-local-engine': 'ローカル音声認識を起動中',
  listening: '文字起こし中',
  paused: '一時停止中',
  stopped: '終了',
  'permission-denied': 'マイクが拒否されました',
  'device-unavailable': 'マイクを利用できません',
  'engine-unavailable': 'ローカル音声認識を利用できません',
};

type SyntheticSession = ReturnType<typeof createSyntheticTranscription>;
const subscribeRuntime = () => () => undefined;

export function CapturePanel() {
  const localRuntime = useSyncExternalStore(subscribeRuntime, () => isLoopbackRuntime(window.location), () => false);
  const [sessionState, dispatch] = useReducer(
    (state: TranscriptionSessionState, event: TranscriptionSessionEvent) => transitionTranscriptionSession(state, event),
    'idle',
  );
  const [devices, setDevices] = useState<MicrophoneDevice[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [transcript, setTranscript] = useState(emptyTranscriptState);
  const [saveLocally, setSaveLocally] = useState(false);
  const [message, setMessage] = useState('開始を押すまでマイクへアクセスしません。');
  const microphone = useRef<MicrophoneCapture | null>(null);
  const localClient = useRef<LocalCompanionTranscriptionClient | null>(null);
  const synthetic = useRef<SyntheticSession | null>(null);
  const saveLocallyRef = useRef(false);

  useEffect(() => { saveLocallyRef.current = saveLocally; }, [saveLocally]);
  useEffect(() => { void listMicrophones().then(setDevices).catch(() => setDevices([])); }, []);
  useEffect(() => () => {
    synthetic.current?.stop();
    void microphone.current?.stop();
    void localClient.current?.stop();
  }, []);

  const receive = (event: TranscriptUtterance) => {
    setTranscript((state) => applyTranscriptEvent(state, event));
    if (event.phase === 'final' && saveLocallyRef.current) void saveFinalTranscript(event).catch(() => setMessage('文字起こしをローカル保存できませんでした。'));
  };

  const startLocal = async () => {
    if (!localRuntime) {
      dispatch({ type: 'engine-unavailable' });
      setMessage('公開UIでは実音声を取得できません。Windowsローカルruntimeを使用してください。');
      return;
    }
    dispatch({ type: 'start-requested' });
    setMessage('マイク許可はこの操作に対してのみ要求します。');
    let capture: MicrophoneCapture | null = null;
    try {
      let ready = false;
      const client = new LocalCompanionTranscriptionClient('local', receive);
      client.onFailure = () => {
        void microphone.current?.stop();
        microphone.current = null;
        dispatch({ type: 'engine-unavailable' });
        setMessage('ローカル音声認識が停止しました。入力を終了して合成デモへ切り替えられます。');
      };
      capture = await startMicrophoneCapture(deviceId || undefined, (samples) => {
        if (ready) void client.sendPcm(samples).catch(() => setMessage('ローカル音声認識への入力が停止しました。'));
      });
      microphone.current = capture;
      dispatch({ type: 'permission-granted' });
      await client.start();
      localClient.current = client;
      ready = true;
      dispatch({ type: 'started' });
      setMessage('生音声はメモリ内で処理され、保存も外部送信もされません。');
      setDevices(await listMicrophones());
    } catch (error) {
      await capture?.stop();
      microphone.current = null;
      localClient.current = null;
      const denied = error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError');
      dispatch({ type: denied ? 'permission-denied' : error instanceof DOMException ? 'device-unavailable' : 'engine-unavailable' });
      setMessage(denied ? 'ブラウザー設定でマイクを許可するか、合成デモを利用してください。' : 'companion・モデル・マイクを確認するか、合成デモを利用してください。');
    }
  };

  const startDemo = () => {
    synthetic.current?.stop();
    synthetic.current = createSyntheticTranscription(receive);
    synthetic.current.start();
    dispatch({ type: 'demo-started' });
    setMessage('合成データだけを再生中です。マイクにはアクセスしていません。');
  };

  const pause = async () => {
    microphone.current?.pause();
    synthetic.current?.pause();
    await localClient.current?.pause().catch(() => undefined);
    dispatch({ type: 'pause' });
  };

  const resume = async () => {
    microphone.current?.resume();
    synthetic.current?.resume();
    await localClient.current?.resume().catch(() => undefined);
    dispatch({ type: 'resume' });
  };

  const stop = async () => {
    synthetic.current?.stop();
    synthetic.current = null;
    await microphone.current?.stop();
    microphone.current = null;
    await localClient.current?.stop().catch(() => undefined);
    localClient.current = null;
    dispatch({ type: 'stop' });
    setMessage('入力を終了しました。生音声bufferは破棄されました。');
  };

  const latest = transcript.utterances.slice(-2);
  const active = sessionState === 'listening' || sessionState === 'paused';

  return (
    <section aria-label="音声入力" className="border-b border-[#d9ded8] bg-[#eef3ef] px-4 py-3 md:px-6">
      <div className="mx-auto grid max-w-[1600px] gap-3 lg:grid-cols-[1fr_auto] lg:items-center">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`h-2.5 w-2.5 rounded-full ${sessionState === 'listening' ? 'animate-pulse bg-[#2b9b6b]' : 'bg-[#8a9893]'}`} />
            <strong className="text-sm">{stateLabels[sessionState]}</strong>
            <span className="text-xs text-[#52615c]">{message}</span>
          </div>
          {latest.length > 0 && <div aria-live="polite" className="mt-2 space-y-1 text-xs text-[#34423e]">{latest.map((item) => <p key={item.id}><b>{item.phase === 'final' ? '確定' : '認識中'} · {item.speaker === 'self' ? '自分' : item.source === 'synthetic' ? '合成' : '相手側'}:</b> {item.text}</p>)}</div>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="microphone-device">入力マイク</label>
          <select id="microphone-device" value={deviceId} disabled={active} onChange={(event) => setDeviceId(event.target.value)} className="max-w-48 rounded-lg border border-[#cbd3ce] bg-white px-2 py-2 text-xs">
            <option value="">既定のマイク</option>
            {devices.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}
          </select>
          {!active && <button disabled={!localRuntime} onClick={() => void startLocal()} className="rounded-lg bg-[#153f38] px-3 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:bg-[#8a9893]">{localRuntime ? 'マイクを開始' : 'マイクはローカル実行のみ'}</button>}
          {sessionState === 'listening' && <button onClick={() => void pause()} className="rounded-lg border border-[#b8c8c1] bg-white px-3 py-2 text-xs font-semibold">一時停止</button>}
          {sessionState === 'paused' && <button onClick={() => void resume()} className="rounded-lg bg-[#153f38] px-3 py-2 text-xs font-semibold text-white">再開</button>}
          {active && <button onClick={() => void stop()} className="rounded-lg border border-[#c8a7a0] bg-white px-3 py-2 text-xs font-semibold text-[#8b3f34]">終了</button>}
          {!active && <button onClick={startDemo} className="rounded-lg border border-[#b8c8c1] bg-white px-3 py-2 text-xs font-semibold">合成デモ</button>}
        </div>
      </div>
      <details className="mx-auto mt-2 max-w-[1600px] text-xs text-[#52615c]">
        <summary className="cursor-pointer font-semibold">保存と安全境界</summary>
        <div className="mt-2 flex flex-wrap items-center gap-3 rounded-lg bg-white/70 p-2">
          <label className="flex items-center gap-2"><input type="checkbox" checked={saveLocally} onChange={(event) => setSaveLocally(event.target.checked)} />確定文字起こしだけをローカル保存</label>
          <span>保存先: {localTranscriptStorageDescription}</span><span>保持: 削除するまで</span>
          <button onClick={() => void deleteAllLocalTranscripts().then(() => setMessage('ローカル保存した文字起こしを削除しました。')).catch(() => setMessage('削除できませんでした。ほかのタブを閉じて再試行してください。'))} className="rounded border border-[#c8a7a0] px-2 py-1 font-semibold text-[#8b3f34]">保存データを削除</button>
          <span className="font-semibold text-[#8b3f34]">Issue #6完了までは実会議に使用しないでください。</span>
        </div>
      </details>
    </section>
  );
}
