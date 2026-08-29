'use client';

import { useCallback, useRef, useState } from 'react';
import { CapturePanel } from '@/components/capture-panel';
import { DiscussionWorkspace } from '@/components/discussion-workspace';
import { emptyAnalysisState, type AnalysisState } from '@/domain/analysis/contract.ts';
import { applyHumanItemPatch, commitAnalysisHistory, createAnalysisHistory, redoAnalysisHistory, undoAnalysisHistory, type HumanItemPatch } from '@/domain/mind-map/workspace.ts';
import { emptyTranscriptState, type TranscriptState } from '@/domain/transcription/utterance.ts';

export default function Home() {
  const [selectedNode, setSelectedNode] = useState('');
  const [focusSequence, setFocusSequence] = useState(0);
  const [focusRequest, setFocusRequest] = useState<{ sequence: number; itemId?: string; evidenceUtteranceIds: string[] } | null>(null);
  const [mapOperationStatus, setMapOperationStatus] = useState('');
  const [analysisHistory, setAnalysisHistory] = useState(() => createAnalysisHistory(emptyAnalysisState));
  const analysisHistoryRef = useRef(analysisHistory);
  const [workspaceSessionGeneration, setWorkspaceSessionGeneration] = useState(0);
  const [liveTranscript, setLiveTranscript] = useState<TranscriptState>(emptyTranscriptState);
  const [presentationMode, setPresentationMode] = useState(false);

  const receiveAnalysisState = useCallback((state: AnalysisState, options?: { resetHistory?: boolean; resetLayout?: boolean }) => {
    const next = commitAnalysisHistory(analysisHistoryRef.current, state, options?.resetHistory);
    analysisHistoryRef.current = next;
    setAnalysisHistory(next);
    if (options?.resetLayout) {
      setWorkspaceSessionGeneration((generation) => generation + 1);
      setFocusRequest(null);
      setSelectedNode('');
      setMapOperationStatus('新しいsessionの共有workspaceを開始しました。');
    }
  }, []);
  const getAnalysisState = useCallback(() => analysisHistoryRef.current.present, []);
  const undoMap = useCallback(() => {
    try {
      const next = undoAnalysisHistory(analysisHistoryRef.current, liveTranscript.utterances);
      analysisHistoryRef.current = next;
      setAnalysisHistory(next);
      setMapOperationStatus('直前の変更を元に戻しました。');
    } catch { setMapOperationStatus('元に戻せませんでした。現在の検証済みworkspaceを維持しています。'); }
  }, [liveTranscript]);
  const redoMap = useCallback(() => {
    try {
      const next = redoAnalysisHistory(analysisHistoryRef.current, liveTranscript.utterances);
      analysisHistoryRef.current = next;
      setAnalysisHistory(next);
      setMapOperationStatus('変更をやり直しました。');
    } catch { setMapOperationStatus('やり直せませんでした。現在の検証済みworkspaceを維持しています。'); }
  }, [liveTranscript]);
  const patchMapItem = useCallback((itemId: string, patch: HumanItemPatch) => {
    try {
      const current = analysisHistoryRef.current;
      const next = commitAnalysisHistory(current, applyHumanItemPatch(current.present, itemId, patch, liveTranscript.utterances));
      analysisHistoryRef.current = next;
      setAnalysisHistory(next);
      setMapOperationStatus('人手による変更をローカルworkspaceへ保存しました。');
      return true;
    } catch { setMapOperationStatus('変更を保存できませんでした。現在の検証済みworkspaceを維持しています。'); return false; }
  }, [liveTranscript]);

  const announceWorkspaceSelection = useCallback((itemId: string) => {
    setSelectedNode(itemId);
    const item = analysisHistoryRef.current.present.items.find((candidate) => candidate.id === itemId);
    if (!item) { setMapOperationStatus('選択項目は現在のworkspaceに存在しません。'); return; }
    setMapOperationStatus(['withdrawn', 'superseded'].includes(item.status)
      ? `「${item.title}」は撤回・統合済みの履歴項目として表示しています。`
      : `選択中: 「${item.title}」`);
  }, []);

  const selectWorkspaceItem = (itemId: string | undefined, utteranceIds: string[]) => {
    const nextSequence = focusSequence + 1;
    setFocusSequence(nextSequence);
    setFocusRequest({ sequence: nextSequence, itemId, evidenceUtteranceIds: utteranceIds });
    const target = itemId
      ? analysisHistory.present.items.find((item) => item.id === itemId)
      : [...analysisHistory.present.items].reverse().find((item) => utteranceIds.some((id) => item.evidenceUtteranceIds.includes(id)));
    if (target) {
      setSelectedNode(target.id);
      setMapOperationStatus(['withdrawn', 'superseded'].includes(target.status)
        ? `「${target.title}」は撤回・統合済みの履歴項目として表示します。`
        : `「${target.title}」をworkspaceで表示します。`);
    } else setMapOperationStatus('この発話に対応する分析項目はまだありません。「分析を更新」を実行してください。');
  };

  return (
    <main className="min-h-screen bg-[#f3f2ed] text-[#1d2927] xl:grid xl:h-screen xl:min-h-0 xl:grid-rows-[auto_auto_1fr] xl:overflow-hidden">
      <header className={`border-b border-[#d9ded8] bg-[#f9f8f4]/95 px-4 backdrop-blur md:px-6 ${presentationMode ? 'py-2' : 'py-3'}`}>
        <div className="mx-auto flex max-w-[1800px] items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[#153f38] text-sm font-bold text-white">TM</div>
            <div className="min-w-0"><p className="truncate text-sm font-semibold">Realtime Architecture Sync</p><p className="text-xs text-[#596763]">共有ディスカッションworkspace</p></div>
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden rounded-full border border-[#cdd6d1] bg-white px-3 py-1.5 text-xs text-[#53635f] sm:inline-flex">ローカル処理</span>
            <span className="inline-flex items-center gap-2 rounded-full bg-[#e7f3ed] px-3 py-1.5 text-xs font-semibold text-[#176044]"><span className="h-2 w-2 rounded-full bg-[#2b9b6b]" /> 発話 {liveTranscript.utterances.length}件</span>
          </div>
        </div>
      </header>

      <CapturePanel analysisState={analysisHistory.present} getAnalysisState={getAnalysisState} onAnalysisStateChange={receiveAnalysisState} onTranscriptChange={setLiveTranscript} presentationMode={presentationMode} onRequestSafetySettings={() => setPresentationMode(false)} />

      <DiscussionWorkspace key={workspaceSessionGeneration} analysisState={analysisHistory.present} transcript={liveTranscript} selectedItemId={selectedNode} focusRequest={focusRequest} canUndo={analysisHistory.past.length > 0} canRedo={analysisHistory.future.length > 0} onUndo={undoMap} onRedo={redoMap} onPatchItem={patchMapItem} onSelectionChange={announceWorkspaceSelection} onFocusItem={selectWorkspaceItem} operationStatus={mapOperationStatus} presentationMode={presentationMode} onPresentationModeChange={setPresentationMode} />
    </main>
  );
}
