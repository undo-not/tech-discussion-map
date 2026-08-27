'use client';

import { useCallback, useRef, useState } from 'react';
import { CapturePanel } from '@/components/capture-panel';
import { LiveMindMap } from '@/components/live-mind-map';
import { emptyAnalysisState, type AnalysisState } from '@/domain/analysis/contract.ts';
import { applyHumanItemPatch, commitAnalysisHistory, createAnalysisHistory, redoAnalysisHistory, undoAnalysisHistory, type HumanItemPatch } from '@/domain/mind-map/workspace.ts';
import { emptyTranscriptState, type TranscriptState } from '@/domain/transcription/utterance.ts';

export default function Home() {
  const [showSearch, setShowSearch] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedNode, setSelectedNode] = useState('');
  const [focusSequence, setFocusSequence] = useState(0);
  const [focusRequest, setFocusRequest] = useState<{ sequence: number; itemId?: string; evidenceUtteranceIds: string[] } | null>(null);
  const [mapOperationStatus, setMapOperationStatus] = useState('');
  const [analysisHistory, setAnalysisHistory] = useState(() => createAnalysisHistory(emptyAnalysisState));
  const analysisHistoryRef = useRef(analysisHistory);
  const [mapSessionGeneration, setMapSessionGeneration] = useState(0);
  const [liveTranscript, setLiveTranscript] = useState<TranscriptState>(emptyTranscriptState);

  const receiveAnalysisState = useCallback((state: AnalysisState, options?: { resetHistory?: boolean; resetLayout?: boolean }) => {
    const next = commitAnalysisHistory(analysisHistoryRef.current, state, options?.resetHistory);
    analysisHistoryRef.current = next;
    setAnalysisHistory(next);
    if (options?.resetLayout) {
      setMapSessionGeneration((generation) => generation + 1);
      setFocusRequest(null);
      setSelectedNode('');
      setMapOperationStatus('新しいsessionのマップworkspaceを開始しました。');
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

  const normalizedQuery = query.trim().toLocaleLowerCase('ja');
  const filteredTranscript = liveTranscript.utterances.filter((item) => !normalizedQuery || `${item.speaker} ${item.text}`.toLocaleLowerCase('ja').includes(normalizedQuery));
  const visibleInsights = analysisHistory.present.items.filter((item) => !['withdrawn', 'superseded'].includes(item.status));
  const insightCategories = [...new Set(visibleInsights.map((item) => item.kind))];
  const insightCounts = visibleInsights.reduce<Record<string, number>>((counts, item) => {
    counts[item.kind] = (counts[item.kind] ?? 0) + 1;
    return counts;
  }, {});

  const selectNode = (itemId: string | undefined, utteranceIds: string[]) => {
    const nextSequence = focusSequence + 1;
    setFocusSequence(nextSequence);
    setFocusRequest({ sequence: nextSequence, itemId, evidenceUtteranceIds: utteranceIds });
    const target = itemId ? analysisHistory.present.items.find((item) => item.id === itemId) : [...analysisHistory.present.items].reverse().find((item) => utteranceIds.some((id) => item.evidenceUtteranceIds.includes(id)));
    if (target) {
      setSelectedNode(target.id);
      setMapOperationStatus(`「${target.title}」をマップで表示しました。`);
    } else setMapOperationStatus('この発話に対応する分析nodeはまだありません。「分析を更新」を実行してください。');
  };

  return (
    <main className="min-h-screen bg-[#f3f2ed] text-[#1d2927] xl:grid xl:h-screen xl:min-h-0 xl:grid-rows-[auto_auto_1fr] xl:overflow-hidden">
      <header className="border-b border-[#d9ded8] bg-[#f9f8f4]/95 px-4 py-3 backdrop-blur md:px-6">
        <div className="mx-auto flex max-w-[1600px] items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[#153f38] text-sm font-bold text-white">TM</div>
            <div className="min-w-0"><p className="truncate text-sm font-semibold">Realtime Architecture Sync</p><p className="text-xs text-[#596763]">Microsoft Teams · 技術ディスカッション</p></div>
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden rounded-full border border-[#cdd6d1] bg-white px-3 py-1.5 text-xs text-[#53635f] sm:inline-flex">ローカル処理</span>
            <span className="inline-flex items-center gap-2 rounded-full bg-[#e7f3ed] px-3 py-1.5 text-xs font-semibold text-[#176044]"><span className="h-2 w-2 rounded-full bg-[#2b9b6b]" /> 発話 {liveTranscript.utterances.length}件</span>
          </div>
        </div>
      </header>

      <CapturePanel analysisState={analysisHistory.present} getAnalysisState={getAnalysisState} onAnalysisStateChange={receiveAnalysisState} onTranscriptChange={setLiveTranscript} />

      <section className="mx-auto grid w-full max-w-[1600px] gap-3 p-3 xl:min-h-0 xl:grid-cols-[minmax(250px,0.72fr)_minmax(520px,1.65fr)_minmax(270px,0.78fr)] xl:p-4">
        <aside className="flex min-h-[360px] flex-col overflow-hidden rounded-2xl border border-[#d9ded8] bg-[#fbfaf7] shadow-[0_8px_30px_rgba(35,54,49,0.05)] xl:min-h-0">
          <div className="flex items-center justify-between border-b border-[#e2e5e0] px-4 py-3">
            <div><h2 className="text-sm font-semibold">発話タイムライン</h2><p className="mt-0.5 text-xs text-[#5c6a66]">リアルタイム文字起こし</p></div>
            <button aria-expanded={showSearch} onClick={() => setShowSearch((value) => !value)} className="rounded-lg border border-[#d8ddd8] bg-white px-2.5 py-1.5 text-xs text-[#4b5955] hover:bg-[#f3f5f2] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#153f38]">検索</button>
          </div>
          {showSearch && <div className="border-b border-[#e2e5e0] p-2"><input autoFocus aria-label="発話を検索" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="キーワードを入力" className="w-full rounded-lg border border-[#cbd3ce] bg-white px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-[#4b887c]" /></div>}
          <div className="flex-1 space-y-1 overflow-y-auto p-2">
            {filteredTranscript.map((item) => (
              <article key={`${item.id}-${item.revision}`} className={`group rounded-xl p-3 ${analysisHistory.present.items.some((node) => node.id === selectedNode && node.evidenceUtteranceIds.includes(item.id)) ? 'bg-[#eaf2ed]' : 'hover:bg-[#f0f3ef]'}`}>
                <div className="mb-2 flex items-center gap-2"><span aria-hidden="true" className="avatar avatar-mint">{item.speaker === 'self' ? '自' : '相'}</span><span className="text-xs font-semibold">{item.speaker === 'self' ? '自分' : item.source === 'synthetic' ? '合成デモ' : '相手側'}</span><time className="ml-auto text-xs text-[#5c6a66]">{Math.floor(item.startMs / 60_000).toString().padStart(2, '0')}:{Math.floor((item.startMs % 60_000) / 1_000).toString().padStart(2, '0')}</time></div>
                <p className="text-[13px] leading-6 text-[#46534f]">{item.text}</p>
                {item.phase === 'partial' ? <span className="mt-2 block text-xs text-[#76551f]">認識中</span> : <button onClick={() => selectNode(undefined, [item.id])} className="mt-2 text-xs font-semibold text-[#276758] opacity-0 transition focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100">対応nodeを表示 →</button>}
              </article>
            ))}
            {filteredTranscript.length === 0 && <p className="p-4 text-center text-xs text-[#5c6a66]">一致する発話はありません</p>}
            <div className="mx-3 flex items-center gap-2 rounded-lg border border-dashed border-[#b8c8c1] bg-[#f2f7f3] px-3 py-2 text-xs text-[#4f685f]"><span className="typing-dots" aria-hidden="true"><i /><i /><i /></span>capture panelから入力を開始してください</div>
          </div>
          <div className="border-t border-[#e2e5e0] p-3"><div className="flex items-center justify-between rounded-xl bg-[#eef3ef] px-3 py-2.5"><span className="text-xs font-medium text-[#4b5c57]">入力：capture panel</span><span className="text-xs text-[#5c6a66]">生音声は保存されません</span></div></div>
        </aside>

        <LiveMindMap key={mapSessionGeneration} analysisState={analysisHistory.present} focusRequest={focusRequest} canUndo={analysisHistory.past.length > 0} canRedo={analysisHistory.future.length > 0} onUndo={undoMap} onRedo={redoMap} onPatchItem={patchMapItem} onSelectionChange={setSelectedNode} operationStatus={mapOperationStatus} />

        <aside className="flex min-h-[420px] flex-col overflow-hidden rounded-2xl border border-[#d9ded8] bg-[#fbfaf7] shadow-[0_8px_30px_rgba(35,54,49,0.05)] xl:min-h-0">
          <div className="border-b border-[#e2e5e0] px-4 py-3"><h2 className="text-sm font-semibold">会議インサイト</h2><p className="mt-0.5 text-xs text-[#5c6a66]">重要な変化を自動検出</p></div>
          <div className="flex-1 space-y-2 overflow-y-auto p-3">
            {visibleInsights.map((item) => (
              <article key={item.id} className={`insight insight-${item.kind}`}><div className="mb-2 flex items-center justify-between"><span>{item.kind} · {item.provenance === 'ai-suggested' ? 'AI提案' : item.provenance === 'human-confirmed' ? '人が確認' : '人が編集'}</span><span className="insight-meta">確信度 {Math.round(item.confidence * 100)}%</span></div><p>{item.title}</p><button onClick={() => selectNode(item.id, item.evidenceUtteranceIds)}>根拠 {item.evidenceUtteranceIds.join(' · ')}</button></article>
            ))}
          </div>
          <div className="border-t border-[#e2e5e0] p-3"><div className="mb-2 flex items-center justify-between text-xs"><span className="font-semibold">構造化の内訳</span><span className="font-semibold text-[#267153]">{visibleInsights.length}件</span></div><div className="grid grid-cols-2 gap-2">{insightCategories.map((category) => <div className="metric" key={category}><b>{insightCounts[category] ?? 0}</b><span>{category}</span></div>)}</div></div>
        </aside>
      </section>
    </main>
  );
}
