'use client';

import { useEffect, useLayoutEffect, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import { LocalOpenAiAnalyzer } from '@/adapters/analysis/local-openai-analyzer.ts';
import { analyzeWithDeterministicMock } from '@/adapters/analysis/mock-analyzer.ts';
import { isLoopbackRuntime, listMicrophones, startMicrophoneCapture, type MicrophoneCapture, type MicrophoneDevice } from '@/adapters/audio/browser-microphone.ts';
import { purgeLegacyPlaintextTranscripts } from '@/adapters/persistence/legacy-store-migration.ts';
import { exportSessionToUserSelectedPath, LocalPrivacyClient, type StoredSession, type StoredSessionMetadata } from '@/adapters/privacy/local-privacy-client.ts';
import { LocalCompanionTranscriptionClient } from '@/adapters/transcription/local-companion-client.ts';
import { createSyntheticTranscription } from '@/adapters/transcription/synthetic-transcription.ts';
import { createConsentRecord, type ConsentRecord } from '@/domain/privacy/consent.ts';
import { createMinimalUtteranceWindow } from '@/domain/privacy/redaction.ts';
import { applyAnalysisDelta, emptyAnalysisState, validateAnalysisState, type AnalysisState } from '@/domain/analysis/contract.ts';
import { createRedactedAnalysisInput } from '@/domain/analysis/prompt.ts';
import { transitionTranscriptionSession, type TranscriptionSessionEvent, type TranscriptionSessionState } from '@/domain/transcription/session.ts';
import { applyTranscriptEvent, emptyTranscriptState, type TranscriptState, type TranscriptUtterance } from '@/domain/transcription/utterance.ts';

const stateLabels: Record<TranscriptionSessionState, string> = {
  idle: '待機中', 'requesting-permission': 'マイク許可を確認中', 'starting-local-engine': 'ローカル音声認識を起動中',
  listening: '文字起こし中', paused: '一時停止中', stopped: '終了', 'permission-denied': 'マイクが拒否されました',
  'device-unavailable': 'マイクを利用できません', 'engine-unavailable': 'ローカル音声認識を利用できません',
};
const retentionOptions = [1, 7, 30, 90] as const;
type RetentionDays = (typeof retentionOptions)[number];
type SyntheticSession = ReturnType<typeof createSyntheticTranscription>;
const subscribeRuntime = () => () => undefined;

export type CapturePanelProps = {
  analysisState: AnalysisState;
  getAnalysisState: () => AnalysisState;
  onAnalysisStateChange: (state: AnalysisState, options?: { resetHistory?: boolean }) => void;
  onTranscriptChange?: (state: TranscriptState) => void;
};

export function CapturePanel({ analysisState, getAnalysisState, onAnalysisStateChange, onTranscriptChange }: CapturePanelProps) {
  const localRuntime = useSyncExternalStore(subscribeRuntime, () => isLoopbackRuntime(window.location), () => false);
  const [sessionState, dispatch] = useReducer((state: TranscriptionSessionState, event: TranscriptionSessionEvent) => transitionTranscriptionSession(state, event), 'idle');
  const [devices, setDevices] = useState<MicrophoneDevice[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [transcript, setTranscript] = useState<TranscriptState>(emptyTranscriptState);
  const [consentConfirmed, setConsentConfirmed] = useState(false);
  const [saveLocally, setSaveLocally] = useState(false);
  const [retentionDays, setRetentionDays] = useState<RetentionDays>(7);
  const [dataControlsAttested, setDataControlsAttested] = useState(false);
  const [externalAnalysisAllowed, setExternalAnalysisAllowed] = useState(false);
  const [analysisMode, setAnalysisMode] = useState<'mock' | 'openai'>('mock');
  const [analysisStatus, setAnalysisStatus] = useState('local mockは確定発話ごとに自動更新します。');
  const [openAiInFlight, setOpenAiInFlight] = useState(0);
  const [inputMode, setInputMode] = useState<'none' | 'microphone' | 'synthetic'>('none');
  const [meetingEnded, setMeetingEnded] = useState(false);
  const [privacyStatus, setPrivacyStatus] = useState<{ secureStore: boolean; credentialConfigured: boolean; location: string } | null>(null);
  const [storedSessions, setStoredSessions] = useState<StoredSessionMetadata[]>([]);
  const [message, setMessage] = useState('開始を押すまでマイクへアクセスしません。');
  const microphone = useRef<MicrophoneCapture | null>(null);
  const localClient = useRef<LocalCompanionTranscriptionClient | null>(null);
  const privacyClient = useRef<LocalPrivacyClient | null>(null);
  const openAiAnalyzer = useRef<LocalOpenAiAnalyzer | null>(null);
  const synthetic = useRef<SyntheticSession | null>(null);
  const transcriptRef = useRef<TranscriptState>(emptyTranscriptState);
  const analysisStateRef = useRef<AnalysisState>(analysisState);
  const analysisModeRef = useRef<'mock' | 'openai'>('mock');
  const analysisChain = useRef<Promise<void>>(Promise.resolve());
  const analysisDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const analysisGenerationRef = useRef(0);
  const privacyStatusRef = useRef<{ secureStore: boolean; credentialConfigured: boolean; location: string } | null>(null);
  const consentRef = useRef<ConsentRecord | null>(null);
  const consentAllowedRef = useRef(false);
  const sessionStateRef = useRef<TranscriptionSessionState>('idle');
  const sessionIdRef = useRef('');
  const sessionCreatedAtRef = useRef('');
  const persistenceChain = useRef<Promise<void>>(Promise.resolve());
  const persistedSessionRef = useRef(false);
  const persistenceMayExistRef = useRef(false);
  const sessionWriteBlockedRef = useRef(false);
  const saveLocallyRef = useRef(false);
  const retentionDaysRef = useRef<RetentionDays>(7);
  const dataControlsAttestedRef = useRef(false);
  const externalAnalysisAllowedRef = useRef(false);
  const demoModeRef = useRef(false);

  const publishAnalysisState = (state: AnalysisState, resetHistory = false) => {
    analysisStateRef.current = state;
    onAnalysisStateChange(state, { resetHistory });
  };
  const publishTranscriptState = (state: TranscriptState) => {
    transcriptRef.current = state;
    setTranscript(state);
    onTranscriptChange?.(state);
  };

  useEffect(() => { saveLocallyRef.current = saveLocally; }, [saveLocally]);
  useEffect(() => { retentionDaysRef.current = retentionDays; }, [retentionDays]);
  useEffect(() => { sessionStateRef.current = sessionState; }, [sessionState]);
  useEffect(() => { analysisModeRef.current = analysisMode; }, [analysisMode]);
  useEffect(() => { void listMicrophones().then(setDevices).catch(() => setDevices([])); }, []);
  useEffect(() => { void purgeLegacyPlaintextTranscripts().catch(() => setMessage('旧版のplaintext保存を削除できません。ほかのTechMap tabを閉じて再読み込みしてください。')); }, []);
  useEffect(() => () => { if (analysisDebounceRef.current) clearTimeout(analysisDebounceRef.current); synthetic.current?.stop(); void microphone.current?.stop(); void localClient.current?.stop(); }, []);

  const connectPrivacy = async () => {
    if (!localRuntime) throw new Error('privacy-requires-loopback');
    if (!privacyClient.current) {
      const client = new LocalPrivacyClient();
      await client.connect();
      privacyClient.current = client;
    }
    return privacyClient.current;
  };

  const refreshPrivacyStatus = async (announce = true) => {
    try {
      const client = await connectPrivacy();
      await client.sweep();
      const [status, sessions] = await Promise.all([client.status(), client.list()]);
      privacyStatusRef.current = status;
      setPrivacyStatus(status);
      setStoredSessions(sessions);
      if (announce) setMessage('current-user ACLとDPAPIで保護されたローカル保存先を確認しました。');
    } catch {
      privacyStatusRef.current = null;
      setPrivacyStatus(null);
      if (announce) setMessage('privacy helperを確認できません。保存と外部分析はfail closedで無効です。');
    }
  };

  const snapshot = (state = transcriptRef.current): StoredSession | null => {
    if (demoModeRef.current) return null;
    const consent = consentRef.current;
    if (!consent || !sessionIdRef.current || !sessionCreatedAtRef.current) return null;
    const now = new Date();
    return {
      id: sessionIdRef.current, createdAt: sessionCreatedAtRef.current, updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + retentionDaysRef.current * 86_400_000).toISOString(), retentionDays: retentionDaysRef.current,
      consent, transcript: state.utterances.filter((item) => item.phase === 'final'), analysis: analysisStateRef.current,
      state: { capture: sessionStateRef.current, externalAnalysisAllowed: externalAnalysisAllowedRef.current, dataControlsAttested: dataControlsAttestedRef.current },
    };
  };

  const persistSnapshot = (state: TranscriptState) => {
    if (demoModeRef.current || !saveLocallyRef.current || sessionWriteBlockedRef.current) return;
    const value = snapshot(state);
    if (!value) return;
    persistenceMayExistRef.current = true;
    persistenceChain.current = persistenceChain.current.then(async () => {
      if (sessionWriteBlockedRef.current || value.id !== sessionIdRef.current) return;
      await (await connectPrivacy()).save(value);
      persistedSessionRef.current = true;
    }).catch(() => {
      saveLocallyRef.current = false;
      setSaveLocally(false);
      setMessage('保護された保存に失敗したためmemory-onlyへ切り替えました。以前の暗号化snapshotは残る場合があるため、復旧後に即時削除してください。');
    });
  };

  useLayoutEffect(() => {
    if (analysisStateRef.current.revision === analysisState.revision) {
      analysisStateRef.current = analysisState;
      return;
    }
    analysisStateRef.current = analysisState;
    persistSnapshot(transcriptRef.current);
    // Sync before paint so an in-flight model continuation cannot apply against the pre-edit revision.
    // persistSnapshot intentionally uses current refs; only controlled state revision is reactive here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysisState]);

  const scheduleAnalysis = (transcriptState: TranscriptState, requestedMode = analysisModeRef.current, persistResult = true) => {
    const generation = analysisGenerationRef.current;
    analysisChain.current = analysisChain.current.then(async () => {
      if (generation !== analysisGenerationRef.current) return;
      if (requestedMode === 'openai') {
        if (demoModeRef.current) { setAnalysisStatus('合成デモはlocal mock専用です。外部送信は行いません。'); return; }
        if (!externalAnalysisAllowedRef.current || !dataControlsAttestedRef.current || !privacyStatusRef.current?.credentialConfigured) {
          setAnalysisStatus('OpenAI分析gateが閉じているためlocal stateを変更せず、mockを利用できます。');
          return;
        }
        const window = createMinimalUtteranceWindow(transcriptState.utterances);
        if (!window.ok) { setAnalysisStatus('redaction済み最小windowを構築できず、OpenAI送信を中止しました。'); return; }
        setOpenAiInFlight((value) => value + 1);
        try {
          openAiAnalyzer.current ??= new LocalOpenAiAnalyzer();
          const requestState = getAnalysisState();
          analysisStateRef.current = requestState;
          const delta = await openAiAnalyzer.current.analyze('gpt-5-mini', window.text, requestState);
          if (generation !== analysisGenerationRef.current) { setAnalysisStatus('sessionが切り替わったため、旧sessionの分析結果を破棄しました。'); return; }
          if (!externalAnalysisAllowedRef.current || !dataControlsAttestedRef.current) { setAnalysisStatus('分析中に外部送信許可が解除されたため、結果を適用しませんでした。'); return; }
          if (delta.operations.length === 0) { setAnalysisStatus('OpenAI分析: 構造上の変化はありません。'); return; }
          const next = applyAnalysisDelta(getAnalysisState(), delta, transcriptRef.current.utterances);
          publishAnalysisState(next); if (persistResult) persistSnapshot(transcriptRef.current);
          setAnalysisStatus(`OpenAI分析をrevision ${next.revision}へ原子的に適用しました。`);
        } finally { setOpenAiInFlight((value) => Math.max(0, value - 1)); }
        return;
      }
      if (generation !== analysisGenerationRef.current) return;
      const currentTranscript = transcriptRef.current;
      const currentState = getAnalysisState();
      analysisStateRef.current = currentState;
      const delta = analyzeWithDeterministicMock(currentTranscript.utterances, currentState);
      if (delta.operations.length === 0) { setAnalysisStatus('local mock: 構造上の変化はありません。'); return; }
      const next = applyAnalysisDelta(getAnalysisState(), delta, currentTranscript.utterances);
      publishAnalysisState(next); if (persistResult) persistSnapshot(currentTranscript);
      setAnalysisStatus(`local mockをrevision ${next.revision}へ更新しました。`);
    }).catch((error: unknown) => {
      if (error instanceof Error && error.message === 'analysis-stale-revision') {
        setAnalysisStatus('分析中に手動編集またはundoが行われたため、古い分析結果を破棄しました。「分析を更新」で再実行できます。');
        return;
      }
      setAnalysisStatus('分析を適用できませんでした。local workspaceは変更せず、mock／手動整理を継続できます。');
    });
  };

  const receive = (event: TranscriptUtterance) => {
    const next = applyTranscriptEvent(transcriptRef.current, event);
    publishTranscriptState(next);
    if (event.phase === 'final') {
      if (event.source !== 'synthetic') persistSnapshot(next);
      if (event.source !== 'synthetic' && analysisModeRef.current === 'openai') {
        if (analysisDebounceRef.current) clearTimeout(analysisDebounceRef.current);
        analysisDebounceRef.current = setTimeout(() => {
          analysisDebounceRef.current = null;
          scheduleAnalysis(transcriptRef.current, 'openai', true);
        }, 10_000);
        setAnalysisStatus('OpenAI分析: 最新の確定発話を10秒windowでまとめています。');
      } else {
        scheduleAnalysis(next, 'mock', event.source !== 'synthetic');
      }
    }
  };

  const startLocal = async () => {
    if (!localRuntime || !consentConfirmed) {
      setMessage(!localRuntime ? '公開UIでは実音声を取得できません。Windowsローカルruntimeを使用してください。' : '全参加者の同意を確認するまで実入力は開始できません。');
      return;
    }
    if (saveLocally) {
      try {
        const status = await (await connectPrivacy()).status();
        if (!status.secureStore) throw new Error('privacy-store-unverified');
        privacyStatusRef.current = status;
        setPrivacyStatus(status);
      } catch { setMessage('保護された保存先を確認できないため開始しません。保存を外すかprivacy helperを起動してください。'); return; }
    }
    if (analysisDebounceRef.current) { clearTimeout(analysisDebounceRef.current); analysisDebounceRef.current = null; }
    analysisGenerationRef.current += 1;
    demoModeRef.current = false;
    publishTranscriptState(emptyTranscriptState);
    publishAnalysisState(emptyAnalysisState, true);
    consentRef.current = createConsentRecord();
    consentAllowedRef.current = true;
    sessionWriteBlockedRef.current = false;
    persistenceMayExistRef.current = false;
    persistedSessionRef.current = false;
    sessionIdRef.current = crypto.randomUUID();
    sessionCreatedAtRef.current = new Date().toISOString();
    setMeetingEnded(false);
    dispatch({ type: 'start-requested' });
    setMessage('同意確認済み。マイク許可はこの操作に対してのみ要求します。');
    let capture: MicrophoneCapture | null = null;
    try {
      let ready = false;
      const client = new LocalCompanionTranscriptionClient('local', receive);
      client.onFailure = () => {
        void microphone.current?.stop(); microphone.current = null;
        setInputMode('none');
        dispatch({ type: 'engine-unavailable' });
        setMessage('ローカル音声認識が停止し、以後の音声は取得されません。合成デモへ切り替えられます。');
      };
      capture = await startMicrophoneCapture(deviceId || undefined, (samples) => { if (ready) void client.sendPcm(samples).catch(() => undefined); });
      if (!consentAllowedRef.current) { await capture.stop(); throw new Error('consent-revoked'); }
      microphone.current = capture;
      setInputMode('microphone');
      dispatch({ type: 'permission-granted' });
      await client.start();
      if (!consentAllowedRef.current) { await client.stop().catch(() => undefined); throw new Error('consent-revoked'); }
      localClient.current = client;
      ready = true;
      dispatch({ type: 'started' });
      setMessage('生音声はmemory内だけで処理され、PC外にもdiskにも送られません。');
      setDevices(await listMicrophones());
    } catch (error) {
      await capture?.stop(); microphone.current = null; localClient.current = null; setInputMode('none');
      if (error instanceof Error && error.message === 'consent-revoked') { dispatch({ type: 'stop' }); setMessage('同意確認が解除されたためcaptureを開始しませんでした。'); return; }
      const denied = error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError');
      dispatch({ type: denied ? 'permission-denied' : error instanceof DOMException ? 'device-unavailable' : 'engine-unavailable' });
      setMessage(denied ? 'ブラウザー設定でマイクを許可するか、合成デモを利用してください。' : 'companion・model・microphoneを確認するか、合成デモを利用してください。');
    }
  };

  const startDemo = () => {
    if (analysisDebounceRef.current) { clearTimeout(analysisDebounceRef.current); analysisDebounceRef.current = null; }
    analysisGenerationRef.current += 1;
    demoModeRef.current = true;
    sessionWriteBlockedRef.current = true;
    sessionIdRef.current = '';
    sessionCreatedAtRef.current = '';
    consentRef.current = null;
    persistedSessionRef.current = false;
    persistenceMayExistRef.current = false;
    saveLocallyRef.current = false;
    setSaveLocally(false);
    publishTranscriptState(emptyTranscriptState);
    publishAnalysisState(emptyAnalysisState, true);
    setMeetingEnded(false);
    analysisModeRef.current = 'mock'; setAnalysisMode('mock');
    synthetic.current?.stop(); synthetic.current = createSyntheticTranscription(receive); synthetic.current.start();
    setInputMode('synthetic');
    dispatch({ type: 'demo-started' });
    setMessage('合成データだけを再生中です。マイク・外部送信・永続保存は使用しません。');
  };
  const pause = async () => { microphone.current?.pause(); synthetic.current?.pause(); await localClient.current?.pause().catch(() => undefined); dispatch({ type: 'pause' }); };
  const resume = async () => { microphone.current?.resume(); synthetic.current?.resume(); await localClient.current?.resume().catch(() => undefined); dispatch({ type: 'resume' }); };
  const stop = async () => {
    if (analysisDebounceRef.current) { clearTimeout(analysisDebounceRef.current); analysisDebounceRef.current = null; }
    synthetic.current?.stop(); synthetic.current = null;
    await microphone.current?.stop(); microphone.current = null;
    await localClient.current?.stop().catch(() => undefined); localClient.current = null;
    setInputMode('none');
    await persistenceChain.current;
    dispatch({ type: 'stop' });
    setMeetingEnded(true);
    setMessage(saveLocallyRef.current ? '入力を終了し、生音声bufferを破棄しました。暗号化sessionは保持期限まで残ります。' : '入力を終了し、生音声bufferを破棄しました。未保存sessionはmemoryだけに残っています。');
  };
  const deleteCurrent = async (): Promise<boolean> => {
    if (analysisDebounceRef.current) { clearTimeout(analysisDebounceRef.current); analysisDebounceRef.current = null; }
    analysisGenerationRef.current += 1;
    sessionWriteBlockedRef.current = true;
    saveLocallyRef.current = false;
    setSaveLocally(false);
    if (microphone.current || localClient.current || synthetic.current) await stop();
    await persistenceChain.current;
    const id = sessionIdRef.current;
    const localDeleteRequired = persistedSessionRef.current || persistenceMayExistRef.current;
    let localDeleteVerified = !localDeleteRequired;
    if (id && localDeleteRequired) {
      try { await (await connectPrivacy()).delete(id); localDeleteVerified = true; }
      catch { localDeleteVerified = false; }
    }
    publishTranscriptState(emptyTranscriptState);
    publishAnalysisState(emptyAnalysisState, true);
    setMeetingEnded(false);
    if (localDeleteVerified) {
      persistedSessionRef.current = false;
      persistenceMayExistRef.current = false;
      sessionIdRef.current = '';
      sessionCreatedAtRef.current = '';
      consentRef.current = null;
      saveLocallyRef.current = false;
      setSaveLocally(false);
    }
    setMessage(localDeleteVerified
      ? '現在sessionのmemoryと暗号化local copyを削除しました。OpenAIへ送信済みのcopyがある場合、このlocal削除では削除されません。'
      : 'memory内のsessionは破棄しましたが、暗号化local copyの削除を確認できません。privacy helperを復旧して再試行してください。');
    void refreshPrivacyStatus(false);
    return localDeleteVerified;
  };
  const revokeConsent = (confirmed: boolean) => {
    setConsentConfirmed(confirmed);
    consentAllowedRef.current = confirmed;
    if (!confirmed) {
      if (analysisDebounceRef.current) { clearTimeout(analysisDebounceRef.current); analysisDebounceRef.current = null; }
      externalAnalysisAllowedRef.current = false;
      setExternalAnalysisAllowed(false);
      analysisModeRef.current = 'mock';
      setAnalysisMode('mock');
    }
    if (!confirmed && sessionState !== 'idle' && sessionState !== 'stopped') {
      consentRef.current = null;
      void stop().then(() => deleteCurrent()).then((verified) => {
        if (verified) setMessage('同意確認が解除されたためcaptureを直ちに停止し、現在sessionを削除しました。');
      });
    }
  };
  const exportCurrent = async () => {
    const value = snapshot();
    if (!value) { setMessage('exportできる同意済みsessionがありません。'); return; }
    try { await exportSessionToUserSelectedPath(value); setMessage('利用者が選択したlocal pathへsessionをexportしました。'); }
    catch (error) { if ((error as DOMException)?.name !== 'AbortError') setMessage('exportを完了できませんでした。'); }
  };
  const loadSession = async (id: string) => {
    if (['listening', 'paused'].includes(sessionStateRef.current)) { setMessage('入力を終了してから保存sessionを読み込んでください。'); return; }
    try {
      if (analysisDebounceRef.current) { clearTimeout(analysisDebounceRef.current); analysisDebounceRef.current = null; }
      const value = await (await connectPrivacy()).load(id);
      let state = emptyTranscriptState;
      for (const utterance of value.transcript) state = applyTranscriptEvent(state, utterance);
      const validatedAnalysis = validateAnalysisState(value.analysis, state.utterances);
      analysisGenerationRef.current += 1;
      demoModeRef.current = false;
      publishTranscriptState(state); sessionIdRef.current = value.id; sessionCreatedAtRef.current = value.createdAt; consentRef.current = value.consent;
      publishAnalysisState(validatedAnalysis, true);
      persistedSessionRef.current = true;
      persistenceMayExistRef.current = true;
      sessionWriteBlockedRef.current = false;
      setRetentionDays(value.retentionDays);
      setMessage('暗号化sessionをmemoryへ読み込みました。captureは自動再開しません。');
    } catch { setMessage('保存sessionを読み込めませんでした。'); }
  };
  const deleteStoredSession = async (id: string) => {
    try {
      await (await connectPrivacy()).delete(id);
      await refreshPrivacyStatus(false);
      setMessage('復号不能sessionの暗号化fileを、復号せずに削除しました。');
    } catch { setMessage('復号不能sessionを削除できませんでした。privacy helperを確認してください。'); }
  };

  const active = sessionState === 'listening' || sessionState === 'paused';
  const latest = transcript.utterances.slice(-2);
  const preview = createMinimalUtteranceWindow(transcript.utterances);
  let outboundPreview = '確定発話がないか、検証に失敗したため送信不能';
  if (preview.ok) {
    try { outboundPreview = createRedactedAnalysisInput(preview.text, analysisState); }
    catch { outboundPreview = '発話とstate projectionの最終検証に失敗したため送信不能'; }
  }

  return (
    <section aria-label="音声入力" className="border-b border-[#d9ded8] bg-[#eef3ef] px-4 py-3 md:px-6">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-2 pb-2 text-xs">
        <span className={`rounded-full px-3 py-1 font-bold ${inputMode === 'microphone' ? 'bg-[#ffe2dd] text-[#8b2f22]' : 'bg-white text-[#52615c]'}`}>CAPTURE {inputMode === 'microphone' ? 'ON' : 'OFF'}</span>
        <span className={`rounded-full px-3 py-1 font-bold ${openAiInFlight > 0 ? 'bg-[#fff0d8] text-[#7a541d]' : 'bg-white text-[#52615c]'}`}>OPENAI送信 {openAiInFlight > 0 ? 'ON' : 'OFF'}</span>
        <span className={`rounded-full px-3 py-1 font-bold ${saveLocally ? 'bg-[#e5efe9] text-[#176044]' : 'bg-white text-[#52615c]'}`}>LOCAL保存 {saveLocally ? 'ON' : 'OFF'}</span>
        <span className="text-[#52615c]">入力: {inputMode === 'microphone' ? 'microphone' : inputMode === 'synthetic' ? 'synthetic demo' : 'none'} · 外部分析の許可設定: {externalAnalysisAllowed ? 'ON' : 'OFF'}</span>
      </div>
      <div className="mx-auto grid max-w-[1600px] gap-3 lg:grid-cols-[1fr_auto] lg:items-center">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2"><span className={`h-2.5 w-2.5 rounded-full ${active ? 'animate-pulse bg-[#c55445]' : 'bg-[#8a9893]'}`} /><strong className="text-sm">{stateLabels[sessionState]}</strong><span className="text-xs text-[#52615c]">{message}</span></div>
          {latest.length > 0 && <div aria-live="polite" className="mt-2 space-y-1 text-xs text-[#34423e]">{latest.map((item) => <p key={item.id}><b>{item.phase === 'final' ? '確定' : '認識中'} · {item.speaker === 'self' ? '自分' : item.source === 'synthetic' ? '合成' : '相手側'}:</b> {item.text}</p>)}</div>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="microphone-device">入力マイク</label>
          <select id="microphone-device" value={deviceId} disabled={active} onChange={(event) => setDeviceId(event.target.value)} className="max-w-48 rounded-lg border border-[#cbd3ce] bg-white px-2 py-2 text-xs"><option value="">既定のマイク</option>{devices.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}</select>
          {!active && <button disabled={!localRuntime || !consentConfirmed} onClick={() => void startLocal()} className="rounded-lg bg-[#153f38] px-3 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:bg-[#8a9893]">{localRuntime ? 'マイクを開始' : 'マイクはローカル実行のみ'}</button>}
          {sessionState === 'listening' && <button onClick={() => void pause()} className="rounded-lg border border-[#b8c8c1] bg-white px-3 py-2 text-xs font-semibold">一時停止</button>}
          {sessionState === 'paused' && <button onClick={() => void resume()} className="rounded-lg bg-[#153f38] px-3 py-2 text-xs font-semibold text-white">再開</button>}
          {active && <button onClick={() => void stop()} className="rounded-lg border border-[#c8a7a0] bg-white px-3 py-2 text-xs font-semibold text-[#8b3f34]">終了</button>}
          {!active && <button onClick={startDemo} className="rounded-lg border border-[#b8c8c1] bg-white px-3 py-2 text-xs font-semibold">合成デモ</button>}
        </div>
      </div>
      <div className="mx-auto mt-2 grid max-w-[1600px] gap-2 rounded-lg border border-[#d6ded8] bg-white/70 p-2 text-xs lg:grid-cols-[auto_1fr]">
        <div className="flex flex-wrap items-center gap-2">
          <label>分析mode <select value={analysisMode} onChange={(event) => { const mode = event.target.value as 'mock' | 'openai'; if (mode === 'mock' && analysisDebounceRef.current) { clearTimeout(analysisDebounceRef.current); analysisDebounceRef.current = null; } analysisModeRef.current = mode; setAnalysisMode(mode); }} className="ml-1 rounded border px-2 py-1"><option value="mock">local deterministic mock</option><option value="openai" disabled={inputMode === 'synthetic' || !externalAnalysisAllowed || !dataControlsAttested || !privacyStatus?.credentialConfigured}>OpenAI gpt-5-mini</option></select></label>
          <button disabled={!transcript.utterances.some((item) => item.phase === 'final')} onClick={() => { if (analysisDebounceRef.current) { clearTimeout(analysisDebounceRef.current); analysisDebounceRef.current = null; } scheduleAnalysis(transcriptRef.current, analysisMode, inputMode !== 'synthetic'); }} className="rounded border px-2 py-1 font-semibold disabled:opacity-50">分析を更新</button>
          <span>{analysisStatus}</span>
        </div>
        <div aria-live="polite" className="flex min-w-0 flex-wrap gap-2">
          {analysisState.items.filter((item) => item.status !== 'withdrawn').slice(-4).map((item) => <span key={item.id} className="rounded border border-[#d6ded8] bg-white px-2 py-1"><b>{item.kind} · {item.provenance === 'ai-suggested' ? 'AI提案' : item.provenance === 'human-confirmed' ? '人が確認' : '人が編集'}</b> · {item.title} <small>{item.status} · 確信度 {Math.round(item.confidence * 100)}% · 根拠 {item.evidenceUtteranceIds.join(', ')}</small></span>)}
          {analysisState.items.length === 0 && <span className="text-[#65736e]">分析itemはまだありません。</span>}
        </div>
      </div>
      <details open={(!consentConfirmed && inputMode !== 'synthetic') || meetingEnded} className="mx-auto mt-2 max-w-[1600px] text-xs text-[#52615c]">
        <summary className="cursor-pointer font-semibold">同意・保存・外部送信の安全境界</summary>
        <div className="mt-2 grid gap-3 rounded-lg bg-white/80 p-3 lg:grid-cols-2">
          <div className="space-y-2">
            <label className="flex items-start gap-2 font-semibold text-[#8b3f34]"><input type="checkbox" checked={consentConfirmed} onChange={(event) => revokeConsent(event.target.checked)} />Teams側の表示だけに依存せず、全参加者がこのアプリの文字起こし・分析に同意したことを確認しました</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={saveLocally} disabled={!consentConfirmed || active} onChange={(event) => setSaveLocally(event.target.checked)} />確定文字起こし・分析・session状態を暗号化してローカル保存</label>
            <label>保持期間 <select value={retentionDays} disabled={!saveLocally || active} onChange={(event) => setRetentionDays(Number(event.target.value) as RetentionDays)} className="ml-2 rounded border px-2 py-1">{retentionOptions.map((days) => <option value={days} key={days}>{days}日</option>)}</select></label>
            <p>保存先: %LOCALAPPDATA%\TechMapLive\sessions（current-user-only ACL + DPAPI）。生音声は保存対象外です。</p>
            <button onClick={() => void refreshPrivacyStatus()} className="rounded border px-2 py-1 font-semibold">ローカル保護・API key状態を確認</button>
            <span>{privacyStatus ? `ACL/DPAPI: 有効 · Credential Manager key: ${privacyStatus.credentialConfigured ? '設定済み' : '未設定'}` : '未確認'}</span>
          </div>
          <div className="space-y-2">
            <label className="flex items-start gap-2"><input type="checkbox" checked={dataControlsAttested} onChange={(event) => { const checked = event.target.checked; dataControlsAttestedRef.current = checked; setDataControlsAttested(checked); if (!checked) { externalAnalysisAllowedRef.current = false; setExternalAnalysisAllowed(false); analysisModeRef.current = 'mock'; setAnalysisMode('mock'); } }} />利用するOpenAI API projectのData controlsと保持条件を確認しました</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={externalAnalysisAllowed} disabled={!consentConfirmed || !dataControlsAttested || !privacyStatus?.credentialConfigured} onChange={(event) => { const checked = event.target.checked; externalAnalysisAllowedRef.current = checked; setExternalAnalysisAllowed(checked); if (!checked) { analysisModeRef.current = 'mock'; setAnalysisMode('mock'); } }} />redaction後のbounded最小context（確定発話＋分析state）をOpenAIへ送ることを許可</label>
            <p className="font-semibold">`store:false`でも、既定ではabuse monitoring logにcustomer contentが最大30日保持され得ます。ZDR/MAMは対象projectで承認・設定された場合だけ有効で、本アプリは保証済みと推測しません。</p>
            <p>送信対象: 最大8件の確定発話（ID/source/time/text）と、最大40件のactive分析item（ID/kind/provenance/status/title/detailの先頭180文字/evidence IDs）。結合後に再redactionします。送信しないもの: 生音声、participant metadata、file、conversation、background task、tool、analytics。固有名詞はheuristic redactionで完全除去を保証しません。</p>
            <details><summary className="cursor-pointer font-semibold">OpenAIへ送る最終contextを確認</summary><pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-[#eef3ef] p-2">{outboundPreview}</pre></details>
          </div>
          <div className="space-y-2 lg:col-span-2">
            {meetingEnded && <p role="status" className="rounded bg-[#fff4d9] p-2 font-semibold text-[#76551f]">会議入力を終了しました。暗号化保持、明示export、即時削除のいずれかを確認してください。</p>}
            <div className="flex flex-wrap gap-2"><button onClick={() => void exportCurrent()} className="rounded border px-2 py-1 font-semibold">選択したlocal pathへexport</button><button onClick={() => void deleteCurrent()} className="rounded border border-[#c8a7a0] px-2 py-1 font-semibold text-[#8b3f34]">現在sessionを即時削除</button></div>
            {storedSessions.length > 0 && <div><b>保存session:</b> {storedSessions.slice(0, 5).map((item) => item.unreadable
              ? <button key={item.id} onClick={() => void deleteStoredSession(item.id)} className="ml-2 rounded border border-[#c8a7a0] px-2 py-1 text-[#8b3f34]">復号不能sessionを削除</button>
              : <button key={item.id} disabled={active} onClick={() => void loadSession(item.id)} className="ml-2 rounded border px-2 py-1 disabled:opacity-50">{new Date(item.updatedAt as string).toLocaleString()} · 発話{item.transcriptCount}件を再開</button>)}</div>}
            <p>削除はlocal encrypted session全体が対象です。明示exportは別copyなので個別削除が必要です。OpenAI送信後の保持はlocal削除では取り消せません。外部model停止・refusal・不正schema時はdeltaを適用せずlocal workspaceを維持します。</p>
          </div>
        </div>
      </details>
    </section>
  );
}
