'use client';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { AnalysisItem, AnalysisKind, AnalysisState } from '@/domain/analysis/contract.ts';
import { advanceDegradedViewportTracking, canCommitMapEdit, degradedViewportFilterKey, latestRenderedMapItems, mapCanvasHeight, mapNodeHeight, mapNodeWidth, maximumRenderedNodes, nearestNodeId, reconcileMapLayout, resetMapLayout, scrollTargetForNode, scrollTargetForVisibleItems, visibleSelectionId, type DegradedViewportTracking, type HumanItemPatch, type MapLayout } from '@/domain/mind-map/workspace.ts';

const kindLabels: Record<AnalysisKind, string> = { topic: '論点', claim: '主張', question: '質問', decision: '決定', action: 'Action', dependency: '依存', risk: 'リスク' };
const kindStyles: Record<AnalysisKind, string> = {
  topic: 'border-[#8fb1c3] bg-[#f4f9fb]', claim: 'border-[#a9b9c7] bg-[#f7f9fa]', question: 'border-[#dfb45e] bg-[#fffaf0]',
  decision: 'border-[#69aa8c] bg-[#f2faf6]', action: 'border-[#78a2bf] bg-[#f2f8fc]', dependency: 'border-[#a89bc1] bg-[#f8f5fc]', risk: 'border-[#d28b7e] bg-[#fff6f4]',
};
const provenanceLabel = { 'ai-suggested': 'AI提案', 'human-confirmed': '人が確認', 'human-edited': '人が編集' } as const;

type LiveMindMapProps = {
  analysisState: AnalysisState;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onPatchItem: (itemId: string, patch: HumanItemPatch) => boolean;
};

export function LiveMindMap({ analysisState, canUndo, canRedo, onUndo, onRedo, onPatchItem }: LiveMindMapProps) {
  const [layout, setLayout] = useState<MapLayout>({ positions: {} });
  const [selectedId, setSelectedId] = useState('');
  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<AnalysisKind | 'all'>('all');
  const [showTombstones, setShowTombstones] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [reframeGeneration, setReframeGeneration] = useState(0);
  const [editing, setEditing] = useState(false);
  const [editingItemId, setEditingItemId] = useState('');
  const [draftTitle, setDraftTitle] = useState('');
  const [draftDetail, setDraftDetail] = useState('');
  const [editError, setEditError] = useState('');
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const lastFocusedNodeRef = useRef('');
  const degradedViewportTrackingRef = useRef<DegradedViewportTracking>({ processedKey: '', trackedScroll: null });

  useEffect(() => {
    const frame = requestAnimationFrame(() => setLayout((current) => analysisState.revision === 0 && analysisState.items.length === 0 ? resetMapLayout() : reconcileMapLayout(current, analysisState)));
    return () => cancelAnimationFrame(frame);
  }, [analysisState]);
  const renderedLayout = useMemo(() => analysisState.revision === 0 && analysisState.items.length === 0 ? resetMapLayout() : reconcileMapLayout(layout, analysisState), [analysisState, layout]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('ja');
    return analysisState.items.filter((item) =>
      (showTombstones || !['withdrawn', 'superseded'].includes(item.status)) &&
      (kindFilter === 'all' || item.kind === kindFilter) &&
      (!normalized || `${item.title} ${item.detail} ${item.evidenceUtteranceIds.join(' ')}`.toLocaleLowerCase('ja').includes(normalized)),
    );
  }, [analysisState, kindFilter, query, showTombstones]);
  const degraded = filtered.length > maximumRenderedNodes;
  const visibleItems = useMemo(() => latestRenderedMapItems(filtered), [filtered]);
  const visibleIds = useMemo(() => new Set(visibleItems.map((item) => item.id)), [visibleItems]);
  const selected = analysisState.items.find((item) => item.id === selectedId) ?? null;
  const canvasHeight = mapCanvasHeight(renderedLayout, visibleIds);

  const focusNode = (id: string) => {
    if (editingItemId && editingItemId !== id) {
      setEditing(false);
      setEditingItemId('');
    }
    setEditError('');
    setSelectedId(id);
    requestAnimationFrame(() => {
      const node = document.getElementById(`map-node-${id}`);
      const viewport = viewportRef.current;
      node?.focus({ preventScroll: true });
      const position = renderedLayout.positions[id];
      if (!viewport || !position) return;
      const target = scrollTargetForNode({ scrollLeft: viewport.scrollLeft, scrollTop: viewport.scrollTop, width: viewport.clientWidth, height: viewport.clientHeight }, position, zoom);
      viewport.scrollTo({ left: target.left, top: target.top, behavior: 'auto' });
    });
  };

  useEffect(() => {
    const nextId = visibleSelectionId(selectedId, visibleItems.map((item) => item.id));
    if (nextId === selectedId) return;
    const shouldRestoreFocus = lastFocusedNodeRef.current !== '' && lastFocusedNodeRef.current === selectedId && document.activeElement === document.body;
    const frame = requestAnimationFrame(() => {
      setEditError('');
      if (editingItemId && editingItemId !== nextId) {
        setEditing(false);
        setEditingItemId('');
      }
      if (shouldRestoreFocus && nextId) focusNode(nextId);
      else setSelectedId(nextId);
    });
    return () => cancelAnimationFrame(frame);
    // focusNode intentionally uses the latest rendered layout and zoom for a user-visible selection replacement.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, visibleItems]);

  const degradedFilterKey = degradedViewportFilterKey(query, kindFilter, showTombstones, zoom, reframeGeneration);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      const current = { left: viewport.scrollLeft, top: viewport.scrollTop };
      const decision = advanceDegradedViewportTracking(degradedViewportTrackingRef.current, degradedFilterKey, degraded, current);
      degradedViewportTrackingRef.current = decision.next;
      if (!decision.shouldEvaluate) return;
      const target = scrollTargetForVisibleItems({ scrollLeft: current.left, scrollTop: current.top, width: viewport.clientWidth, height: viewport.clientHeight }, visibleItems.map((item) => item.id), renderedLayout, zoom);
      if (!target) return;
      degradedViewportTrackingRef.current = { processedKey: degradedFilterKey, trackedScroll: target };
      if (target.left !== current.left || target.top !== current.top) viewport.scrollTo({ left: target.left, top: target.top, behavior: 'auto' });
    });
    return () => cancelAnimationFrame(frame);
  }, [degraded, degradedFilterKey, renderedLayout, visibleItems, zoom]);

  const beginEditing = (item: AnalysisItem) => {
    setSelectedId(item.id);
    setEditingItemId(item.id);
    setDraftTitle(item.title);
    setDraftDetail(item.detail);
    setEditError('');
    setEditing(true);
    requestAnimationFrame(() => titleInputRef.current?.focus());
  };
  const handleNodeKey = (event: KeyboardEvent<HTMLButtonElement>, item: AnalysisItem) => {
    const directions = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' } as const;
    if (event.key in directions) {
      event.preventDefault();
      focusNode(nearestNodeId(item.id, directions[event.key as keyof typeof directions], visibleItems.map((candidate) => candidate.id), renderedLayout));
    } else if (!event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.key.toLowerCase() === 'e') {
      event.preventDefault();
      beginEditing(item);
    } else if (!event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.key.toLowerCase() === 'c' && item.provenance === 'ai-suggested') {
      event.preventDefault();
      setEditError(onPatchItem(item.id, { confirm: true }) ? '' : '確認を保存できませんでした。nodeの根拠と状態を確認してください。');
    }
  };
  const beginEdit = () => {
    if (!selected) return;
    beginEditing(selected);
  };
  const submitEdit = () => {
    if (!selected || !canCommitMapEdit(editingItemId, selected.id)) {
      setEditError('選択nodeが変わったため保存しませんでした。編集を開き直してください。');
      return;
    }
    if (onPatchItem(editingItemId, { title: draftTitle, detail: draftDetail })) {
      setEditError('');
      setEditing(false);
      setEditingItemId('');
      requestAnimationFrame(() => focusNode(selected.id));
    } else setEditError('編集を保存できませんでした。文字数とnodeの根拠を確認してください。');
  };

  return (
    <section aria-label="ライブ・ディスカッションマップ" className="relative flex min-h-[620px] flex-col overflow-hidden rounded-2xl border border-[#d2d9d4] bg-[#e9eee9] shadow-[0_8px_30px_rgba(35,54,49,0.07)] xl:min-h-0">
      <div className="z-20 flex flex-wrap items-start justify-between gap-2 border-b border-[#d2dad4] bg-[#f7f9f6]/95 p-3">
        <div><div className="flex items-center gap-2"><h1 className="text-base font-semibold">ライブ・ディスカッションマップ</h1><span className="rounded-full bg-white px-2 py-0.5 text-xs font-semibold text-[#4f6a61]">{visibleItems.length} / {filtered.length} NODES</span></div><p className="mt-0.5 text-xs text-[#53625e]">矢印キーで移動 · Eで編集 · CでAI提案を確認</p></div>
        <div className="flex flex-wrap gap-1 text-xs">
          <button disabled={!canUndo} onClick={onUndo} className="map-tool border bg-white disabled:opacity-40">元に戻す</button>
          <button disabled={!canRedo} onClick={onRedo} className="map-tool border bg-white disabled:opacity-40">やり直す</button>
          <button aria-label="縮小" onClick={() => setZoom((value) => Math.max(.55, value - .1))} className="map-tool border bg-white">−</button>
          <button onClick={() => { setZoom(1); setReframeGeneration((value) => value + 1); }} className="map-tool border bg-white">全体</button>
          <button aria-label="拡大" onClick={() => setZoom((value) => Math.min(1.35, value + .1))} className="map-tool border bg-white">＋</button>
        </div>
        <div className="flex w-full flex-wrap gap-2">
          <input aria-label="マップを検索" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="title・detail・根拠IDを検索" className="min-w-52 flex-1 rounded-lg border border-[#cbd3ce] bg-white px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-[#4b887c]" />
          <select aria-label="種類で絞り込み" value={kindFilter} onChange={(event) => setKindFilter(event.target.value as AnalysisKind | 'all')} className="rounded-lg border bg-white px-2 text-xs"><option value="all">全種類</option>{Object.entries(kindLabels).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}</select>
          <label className="flex items-center gap-1 rounded-lg border bg-white px-2"><input type="checkbox" checked={showTombstones} onChange={(event) => setShowTombstones(event.target.checked)} />撤回・統合済みも表示</label>
        </div>
      </div>

      {degraded && <p role="status" className="z-20 bg-[#fff4d9] px-3 py-2 text-xs font-semibold text-[#76551f]">大規模会議の縮退表示: 最新の{maximumRenderedNodes} nodeを表示中。検索・filterで対象を絞ってください。</p>}
      <div ref={viewportRef} className="mindmap-grid relative flex-1 overflow-auto" aria-label="マップviewport">
        <div className="relative origin-top-left transition-transform" style={{ width: 1_000, height: canvasHeight, transform: `scale(${zoom})` }}>
          <svg aria-hidden="true" className="absolute inset-0 h-full w-full overflow-visible">
            {visibleItems.flatMap((item) => item.links.filter((link) => visibleIds.has(link.targetId)).map((link) => {
              const from = renderedLayout.positions[item.id]; const to = renderedLayout.positions[link.targetId];
              if (!from || !to) return null;
              return <line key={`${item.id}-${link.targetId}-${link.relation}`} x1={from.x + mapNodeWidth / 2} y1={from.y + mapNodeHeight / 2} x2={to.x + mapNodeWidth / 2} y2={to.y + mapNodeHeight / 2} stroke="#8fa79f" strokeWidth="2" strokeDasharray={link.relation === 'contradicts' ? '5 4' : undefined} />;
            }))}
          </svg>
          {visibleItems.map((item) => {
            const position = renderedLayout.positions[item.id] ?? { x: 0, y: 0 };
            return <button id={`map-node-${item.id}`} key={item.id} tabIndex={selectedId === item.id ? 0 : -1} aria-current={selectedId === item.id ? 'true' : undefined} aria-label={`${kindLabels[item.kind]} ${item.title}、${provenanceLabel[item.provenance]}、根拠 ${item.evidenceUtteranceIds.join('、')}`} onClick={() => { if (editingItemId && editingItemId !== item.id) { setEditing(false); setEditingItemId(''); } setEditError(''); setSelectedId(item.id); }} onFocus={() => { lastFocusedNodeRef.current = item.id; }} onKeyDown={(event) => handleNodeKey(event, item)} className={`absolute rounded-xl border-2 p-3 text-left shadow-sm transition focus-visible:outline focus-visible:outline-4 focus-visible:outline-[#153f38] ${kindStyles[item.kind]} ${selectedId === item.id ? 'ring-4 ring-[#2b9b6b]/25' : ''} ${['withdrawn', 'superseded'].includes(item.status) ? 'opacity-45' : ''}`} style={{ left: position.x, top: position.y, width: mapNodeWidth, minHeight: mapNodeHeight }}>
              <span className="flex items-center justify-between gap-2 text-[10px] font-bold uppercase"><span>{kindLabels[item.kind]} · {item.status}</span><span className={item.provenance === 'ai-suggested' ? 'text-[#8a5a16]' : 'text-[#176044]'}>{provenanceLabel[item.provenance]}</span></span>
              <strong className="mt-1 block line-clamp-2 text-sm">{item.title}</strong>
              <span className="mt-1 block truncate text-[10px] text-[#52615c]">根拠 {item.evidenceUtteranceIds.join(' · ')}</span>
            </button>;
          })}
          {visibleItems.length === 0 && <p className="absolute left-1/2 top-1/2 -translate-x-1/2 text-sm text-[#5c6a66]">分析nodeがありません。合成デモまたは文字起こしを開始してください。</p>}
        </div>
      </div>

      {selected && <aside aria-label="選択nodeの詳細" className="z-20 border-t border-[#d2dad4] bg-white/95 p-3 text-xs">
        {editing ? <div onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); const focusId = editingItemId; setEditError(''); setEditing(false); setEditingItemId(''); requestAnimationFrame(() => focusNode(focusId)); } }} className="grid gap-2 md:grid-cols-[1fr_2fr_auto]">
          <input ref={titleInputRef} aria-label="node title" value={draftTitle} maxLength={160} onChange={(event) => setDraftTitle(event.target.value)} className="rounded border px-2 py-1" />
          <div><input aria-label="node detail" value={draftDetail} maxLength={600} onChange={(event) => setDraftDetail(event.target.value)} className="w-full rounded border px-2 py-1" /><p className="mt-1 text-[10px] text-[#76551f]">OpenAI分析を許可している場合、この編集内容もredaction後の次回contextに含まれます。社外秘の固有名詞は入力前に確認してください。</p></div>
          <div className="flex gap-1"><button disabled={!draftTitle.trim() || !draftDetail.trim()} onClick={submitEdit} className="rounded bg-[#153f38] px-3 py-1 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40">保存</button><button onClick={() => { const focusId = editingItemId; setEditError(''); setEditing(false); setEditingItemId(''); requestAnimationFrame(() => focusNode(focusId)); }} className="rounded border px-3 py-1">取消</button></div>
          {editError && <p role="alert" className="text-[#a23f32] md:col-span-3">{editError}</p>}
        </div> : <div className="flex flex-wrap items-center gap-2"><b>{selected.title}</b><span>{selected.detail}</span><span className="text-[#52615c]">根拠 {selected.evidenceUtteranceIds.join(' · ')}</span><button onClick={beginEdit} className="ml-auto rounded border px-2 py-1 font-semibold">編集</button>{selected.provenance === 'ai-suggested' && <button onClick={() => setEditError(onPatchItem(selected.id, { confirm: true }) ? '' : '確認を保存できませんでした。nodeの根拠と状態を確認してください。')} className="rounded bg-[#176044] px-2 py-1 font-semibold text-white">AI提案を確認</button>}{editError && <span role="alert" className="w-full text-[#a23f32]">{editError}</span>}</div>}
      </aside>}
    </section>
  );
}
