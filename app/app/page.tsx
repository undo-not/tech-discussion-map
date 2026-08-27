'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CapturePanel } from '@/components/capture-panel';
import { LiveMindMap } from '@/components/live-mind-map';
import { emptyAnalysisState, type AnalysisState } from '@/domain/analysis/contract.ts';
import { applyHumanItemPatch, commitAnalysisHistory, createAnalysisHistory, redoAnalysisHistory, undoAnalysisHistory, type HumanItemPatch } from '@/domain/mind-map/workspace.ts';
import { emptyTranscriptState, type TranscriptState } from '@/domain/transcription/utterance.ts';
import workspace from '@/fixtures/workspace.json';

export default function Home() {
  const [isPlaying, setIsPlaying] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedNode, setSelectedNode] = useState('root');
  const [visibleCount, setVisibleCount] = useState(workspace.transcript.length);
  const [analysisHistory, setAnalysisHistory] = useState(() => createAnalysisHistory(emptyAnalysisState));
  const analysisHistoryRef = useRef(analysisHistory);
  const [mapSessionGeneration, setMapSessionGeneration] = useState(0);
  const [liveTranscript, setLiveTranscript] = useState<TranscriptState>(emptyTranscriptState);

  const receiveAnalysisState = useCallback((state: AnalysisState, options?: { resetHistory?: boolean; resetLayout?: boolean }) => {
    const next = commitAnalysisHistory(analysisHistoryRef.current, state, options?.resetHistory);
    analysisHistoryRef.current = next;
    setAnalysisHistory(next);
    if (options?.resetLayout) setMapSessionGeneration((generation) => generation + 1);
  }, []);
  const getAnalysisState = useCallback(() => analysisHistoryRef.current.present, []);
  const undoMap = useCallback(() => {
    try {
      const next = undoAnalysisHistory(analysisHistoryRef.current, liveTranscript.utterances);
      analysisHistoryRef.current = next;
      setAnalysisHistory(next);
    } catch { /* fail closed: keep the current validated workspace */ }
  }, [liveTranscript]);
  const redoMap = useCallback(() => {
    try {
      const next = redoAnalysisHistory(analysisHistoryRef.current, liveTranscript.utterances);
      analysisHistoryRef.current = next;
      setAnalysisHistory(next);
    } catch { /* fail closed: keep the current validated workspace */ }
  }, [liveTranscript]);
  const patchMapItem = useCallback((itemId: string, patch: HumanItemPatch) => {
    try {
      const current = analysisHistoryRef.current;
      const next = commitAnalysisHistory(current, applyHumanItemPatch(current.present, itemId, patch, liveTranscript.utterances));
      analysisHistoryRef.current = next;
      setAnalysisHistory(next);
      return true;
    } catch { return false; }
  }, [liveTranscript]);

  useEffect(() => {
    if (!isPlaying || visibleCount >= workspace.transcript.length) return;
    const timer = window.setTimeout(() => {
      const nextCount = visibleCount + 1;
      setVisibleCount(nextCount);
      if (nextCount >= workspace.transcript.length) setIsPlaying(false);
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [isPlaying, visibleCount]);

  const visibleTranscript = workspace.transcript.slice(0, visibleCount);
  const filteredTranscript = visibleTranscript.filter((item) => `${item.name} ${item.text}`.toLowerCase().includes(query.trim().toLowerCase()));
  const visibleUtteranceIds = new Set(visibleTranscript.map((item) => item.id));
  const visibleInsights = workspace.insights.filter((item) => item.utteranceIds.every((id) => visibleUtteranceIds.has(id)));
  const insightCategories = [...new Set(workspace.insights.map((item) => item.type))];
  const insightCounts = visibleInsights.reduce<Record<string, number>>((counts, item) => {
    counts[item.type] = (counts[item.type] ?? 0) + 1;
    return counts;
  }, {});

  const selectNode = (nodeId: string, utteranceIds: string[]) => {
    setSelectedNode(nodeId);
    void utteranceIds;
  };

  const togglePlayback = () => {
    if (!isPlaying && visibleCount >= workspace.transcript.length) setVisibleCount(1);
    setIsPlaying((value) => !value);
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
            <span className="hidden rounded-full border border-[#cdd6d1] bg-white px-3 py-1.5 text-xs text-[#53635f] sm:inline-flex">4名が参加中</span>
            <span className="inline-flex items-center gap-2 rounded-full bg-[#e7f3ed] px-3 py-1.5 text-xs font-semibold text-[#176044]"><span className="h-2 w-2 animate-pulse rounded-full bg-[#2b9b6b]" /> LIVE <time dateTime="PT18M42S">18:42</time></span>
            <button aria-pressed={isPlaying} onClick={togglePlayback} className="rounded-lg bg-[#153f38] px-3 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-[#0d302a] focus:outline-none focus:ring-2 focus:ring-[#4b887c] focus:ring-offset-2">{isPlaying ? '一時停止' : visibleCount >= workspace.transcript.length ? '最初から再生' : 'デモを再生'}</button>
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
              <article key={item.id} className={`group rounded-xl p-3 ${selectedNode === item.mapNodeId ? 'bg-[#eaf2ed]' : 'hover:bg-[#f0f3ef]'}`}>
                <div className="mb-2 flex items-center gap-2"><span aria-hidden="true" className={`avatar avatar-${item.tone}`}>{item.initials}</span><span className="text-xs font-semibold">{item.name}</span><time dateTime={item.time} className="ml-auto text-xs text-[#5c6a66]">{item.time}</time></div>
                <p className="text-[13px] leading-6 text-[#46534f]">{item.text}</p>
                <button onClick={() => selectNode(item.mapNodeId, [item.id])} className="mt-2 text-xs font-semibold text-[#276758] opacity-0 transition focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100">マップで表示 →</button>
              </article>
            ))}
            {filteredTranscript.length === 0 && <p className="p-4 text-center text-xs text-[#5c6a66]">一致する発話はありません</p>}
            <div className="mx-3 flex items-center gap-2 rounded-lg border border-dashed border-[#b8c8c1] bg-[#f2f7f3] px-3 py-2 text-xs text-[#4f685f]"><span className="typing-dots" aria-hidden="true"><i /><i /><i /></span>{isPlaying ? '発話を認識しています…' : 'デモは一時停止中です'}</div>
          </div>
          <div className="border-t border-[#e2e5e0] p-3"><div className="flex items-center justify-between rounded-xl bg-[#eef3ef] px-3 py-2.5"><span className="text-xs font-medium text-[#4b5c57]">入力：デモ会話</span><span className="text-xs text-[#5c6a66]">音声は保存されません</span></div></div>
        </aside>

        <LiveMindMap key={mapSessionGeneration} analysisState={analysisHistory.present} canUndo={analysisHistory.past.length > 0} canRedo={analysisHistory.future.length > 0} onUndo={undoMap} onRedo={redoMap} onPatchItem={patchMapItem} />

        <aside className="flex min-h-[420px] flex-col overflow-hidden rounded-2xl border border-[#d9ded8] bg-[#fbfaf7] shadow-[0_8px_30px_rgba(35,54,49,0.05)] xl:min-h-0">
          <div className="border-b border-[#e2e5e0] px-4 py-3"><h2 className="text-sm font-semibold">会議インサイト</h2><p className="mt-0.5 text-xs text-[#5c6a66]">重要な変化を自動検出</p></div>
          <div className="flex-1 space-y-2 overflow-y-auto p-3">
            {visibleInsights.map((item) => (
              <article key={item.id} className={`insight insight-${item.tone}`}><div className="mb-2 flex items-center justify-between"><span>{item.type} · {item.source === 'human' ? '人が確認' : 'AI提案'}</span><span className="insight-meta">{item.meta}</span></div><p>{item.text}</p><button onClick={() => selectNode(item.mapNodeId, item.utteranceIds)}>根拠 {item.utteranceIds.join(' · ')}</button></article>
            ))}
          </div>
          <div className="border-t border-[#e2e5e0] p-3"><div className="mb-2 flex items-center justify-between text-xs"><span className="font-semibold">会議の健全性</span><span className="font-semibold text-[#267153]">良好</span></div><div className="grid grid-cols-2 gap-2">{insightCategories.map((category) => <div className="metric" key={category}><b>{insightCounts[category] ?? 0}</b><span>{category}</span></div>)}</div></div>
        </aside>
      </section>
    </main>
  );
}
