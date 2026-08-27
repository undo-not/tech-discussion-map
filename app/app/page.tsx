'use client';

import { useEffect, useState } from 'react';
import workspace from '@/fixtures/workspace.json';

export default function Home() {
  const [isPlaying, setIsPlaying] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedNode, setSelectedNode] = useState('root');
  const [zoom, setZoom] = useState(1);
  const [evidence, setEvidence] = useState('utt-001');
  const [visibleCount, setVisibleCount] = useState(workspace.transcript.length);

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
  const visibleNodes = workspace.nodes.filter((node) => node.utteranceIds.every((id) => visibleUtteranceIds.has(id)));
  const visibleInsights = workspace.insights.filter((item) => item.utteranceIds.every((id) => visibleUtteranceIds.has(id)));
  const insightCategories = [...new Set(workspace.insights.map((item) => item.type))];
  const insightCounts = visibleInsights.reduce<Record<string, number>>((counts, item) => {
    counts[item.type] = (counts[item.type] ?? 0) + 1;
    return counts;
  }, {});

  const selectNode = (nodeId: string, utteranceIds: string[]) => {
    setSelectedNode(nodeId);
    setEvidence(utteranceIds.join(' · '));
  };

  const togglePlayback = () => {
    if (!isPlaying && visibleCount >= workspace.transcript.length) setVisibleCount(1);
    setIsPlaying((value) => !value);
  };

  return (
    <main className="min-h-screen bg-[#f3f2ed] text-[#1d2927] xl:grid xl:h-screen xl:min-h-0 xl:grid-rows-[auto_1fr] xl:overflow-hidden">
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

        <section className="relative min-h-[590px] overflow-hidden rounded-2xl border border-[#d2d9d4] bg-[#e9eee9] shadow-[0_8px_30px_rgba(35,54,49,0.07)] xl:min-h-0">
          <div className="absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-3 p-4">
            <div><div className="mb-1 flex items-center gap-2"><h1 className="text-base font-semibold">ライブ・ディスカッションマップ</h1><span className="rounded-full bg-white/80 px-2 py-0.5 text-xs font-semibold text-[#4f6a61]">{visibleNodes.length} NODES</span></div><p className="text-xs text-[#53625e]">発話と根拠を保ったまま、論点を自動整理</p></div>
            <div className="flex rounded-lg border border-[#d0d8d2] bg-white/80 p-1 shadow-sm"><button aria-label="縮小" onClick={() => setZoom((value) => Math.max(.8, value - .1))} className="map-tool">−</button><button aria-label="全体表示" onClick={() => setZoom(1)} className="map-tool text-xs">全体</button><button aria-label="拡大" onClick={() => setZoom((value) => Math.min(1.2, value + .1))} className="map-tool">＋</button></div>
          </div>

          <div className="mindmap-grid absolute inset-0 overflow-hidden transition-transform" style={{ transform: `scale(${zoom})` }}>
            <div className="map-edge edge-a" /><div className="map-edge edge-b" /><div className="map-edge edge-c" /><div className="map-edge edge-d" />
            {visibleNodes.map((node) => node.kind === 'root' ? (
              <button key={node.id} aria-pressed={selectedNode === node.id} onClick={() => selectNode(node.id, node.utteranceIds)} className={`map-node node-root ${selectedNode === node.id ? 'is-selected' : ''}`}><span className="node-kicker">{node.label} · 人が確認</span><strong>{node.title}</strong><small>根拠：{node.utteranceIds.join(' · ')}</small></button>
            ) : (
              <button key={node.id} aria-pressed={selectedNode === node.id} onClick={() => selectNode(node.id, node.utteranceIds)} className={`map-node node-${node.id} ${selectedNode === node.id ? 'is-selected' : ''}`}><span className={`node-dot ${node.kind}`} /><span><small>{node.label} · {node.source === 'human' ? '人が確認' : 'AI提案'}</small><strong>{node.title}</strong><em>{node.detail}</em></span></button>
            ))}
          </div>

          <div role="status" aria-live="polite" className="absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-3 rounded-full border border-[#d2dad4] bg-white/90 px-4 py-2 text-xs text-[#4f5e59] shadow-sm backdrop-blur"><span><b className="legend decision" /> 決定</span><span><b className="legend question" /> 質問</span><span><b className="legend risk" /> リスク</span><span className="hidden sm:inline">根拠 {evidence}</span><span className="sr-only sm:hidden">根拠 {evidence}</span></div>
        </section>

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
