'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { LiveMindMap } from '@/components/live-mind-map';
import type { AnalysisItem, AnalysisKind, AnalysisState } from '@/domain/analysis/contract.ts';
import type { HumanItemPatch, MapLayout } from '@/domain/mind-map/workspace.ts';
import type { TranscriptState } from '@/domain/transcription/utterance.ts';
import { diffWorkspace, projectWorkspace, viewContainsItem, type WorkspaceChange, type WorkspaceColumn, type WorkspaceView } from '@/domain/workspace/projection.ts';

const viewLabels: Record<WorkspaceView, string> = {
  focus: '議論フォーカス',
  decisions: '決定ボード',
  'actions-risks': 'Action・Risk',
};
const kindLabels: Record<AnalysisKind, string> = { topic: '論点', claim: '主張', question: '質問', decision: '決定', action: 'Action', dependency: '依存', risk: 'リスク' };
const changeLabels = { added: '追加', updated: '内容更新', 'status-changed': '状態変更' } as const;
const changeSymbols = { added: '＋', updated: '✎', 'status-changed': '→' } as const;

type FocusRequest = { sequence: number; itemId?: string; evidenceUtteranceIds: string[] } | null;

type DiscussionWorkspaceProps = {
  analysisState: AnalysisState;
  transcript: TranscriptState;
  selectedItemId: string;
  focusRequest?: FocusRequest;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onPatchItem: (itemId: string, patch: HumanItemPatch) => boolean;
  onSelectionChange: (itemId: string) => void;
  onFocusItem: (itemId: string | undefined, evidenceUtteranceIds: string[]) => void;
  operationStatus?: string;
  presentationMode: boolean;
  onPresentationModeChange: (value: boolean) => void;
};

function workspaceTarget(state: AnalysisState, request: NonNullable<FocusRequest>): AnalysisItem | undefined {
  return request.itemId
    ? state.items.find((item) => item.id === request.itemId)
    : [...state.items].reverse().find((item) => request.evidenceUtteranceIds.some((id) => item.evidenceUtteranceIds.includes(id)));
}

function BoardCard({ item, selected, changed, onSelect }: { item: AnalysisItem; selected: boolean; changed: boolean; onSelect: () => void }) {
  return (
    <button
      id={`workspace-item-${item.id}`}
      data-workspace-item={item.id}
      aria-current={selected ? 'true' : undefined}
      onClick={onSelect}
      className={`w-full rounded-xl border bg-white p-3 text-left shadow-sm transition focus-visible:outline focus-visible:outline-3 focus-visible:outline-[#153f38] ${selected ? 'border-[#2b9b6b] ring-4 ring-[#2b9b6b]/20' : 'border-[#d7dfda]'} ${changed ? 'workspace-change-once' : ''}`}
    >
      <span className="flex items-center justify-between gap-2 text-[10px] font-bold uppercase text-[#53625e]"><span>{kindLabels[item.kind]} · {item.status}</span><span>{item.provenance === 'ai-suggested' ? 'AI提案' : item.provenance === 'human-confirmed' ? '人が確認' : '人が編集'}</span></span>
      <strong className="mt-1 block text-sm leading-5">{item.title}</strong>
      <span className="mt-1 line-clamp-2 text-xs leading-5 text-[#53625e]">{item.detail}</span>
      <span className="mt-2 block text-[10px] font-semibold text-[#276758]">根拠 {item.evidenceUtteranceIds.join(' · ')}</span>
    </button>
  );
}

function Board({ label, columns, selectedItemId, highlightedIds, onSelectItem }: { label: string; columns: WorkspaceColumn[]; selectedItemId: string; highlightedIds: string[]; onSelectItem: (item: AnalysisItem) => void }) {
  return (
    <section aria-label={label} className="flex min-h-[520px] flex-col overflow-hidden rounded-2xl border border-[#d2d9d4] bg-[#edf1ed] shadow-[0_8px_30px_rgba(35,54,49,0.07)] xl:min-h-0">
      <div className="border-b border-[#d2dad4] bg-[#f7f9f6] px-4 py-3"><h2 className="text-base font-semibold">{label}</h2><p className="mt-0.5 text-xs text-[#53625e]">同じ分析stateを状態別に投影。カード選択はマップと共有されます。</p></div>
      <div className="grid flex-1 gap-2 overflow-auto p-3 md:grid-cols-3">
        {columns.map((column) => <section key={column.id} aria-label={column.label} className="min-w-0 rounded-xl border border-[#d8dfda] bg-[#f8faf7] p-2"><div className="mb-2 flex items-center justify-between"><h3 className="text-xs font-bold">{column.label}</h3><span className="rounded-full bg-[#e7eee9] px-2 py-0.5 text-[10px] font-bold">{column.items.length}</span></div><div className="space-y-2">{column.items.map((item) => <BoardCard key={item.id} item={item} selected={selectedItemId === item.id} changed={highlightedIds.includes(item.id)} onSelect={() => onSelectItem(item)} />)}{column.items.length === 0 && <p className="rounded-lg border border-dashed border-[#c8d1cb] p-3 text-center text-xs text-[#68756f]">該当項目なし</p>}</div></section>)}
      </div>
    </section>
  );
}

export function DiscussionWorkspace({ analysisState, transcript, selectedItemId, focusRequest = null, canUndo, canRedo, onUndo, onRedo, onPatchItem, onSelectionChange, onFocusItem, operationStatus = '', presentationMode, onPresentationModeChange }: DiscussionWorkspaceProps) {
  const [view, setView] = useState<WorkspaceView>('focus');
  const [showSearch, setShowSearch] = useState(false);
  const [query, setQuery] = useState('');
  const [mapLayout, setMapLayout] = useState<MapLayout>({ positions: {} });
  const [recentChanges, setRecentChanges] = useState<WorkspaceChange[]>([]);
  const [highlightedIds, setHighlightedIds] = useState<string[]>([]);
  const [highlightedView, setHighlightedView] = useState<WorkspaceView>('focus');
  const previousStateRef = useRef(analysisState);
  const lastHandledFocusSequenceRef = useRef(0);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const projection = useMemo(() => projectWorkspace(analysisState), [analysisState]);

  useEffect(() => {
    const previous = previousStateRef.current;
    if (previous.revision === analysisState.revision) return;
    const changes = diffWorkspace(previous, analysisState);
    previousStateRef.current = analysisState;
    setRecentChanges(changes.slice(-6).reverse());
    setHighlightedIds(changes.map((change) => change.itemId));
    setHighlightedView(view);
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = setTimeout(() => setHighlightedIds([]), 1_100);
  }, [analysisState, view]);
  useEffect(() => () => { if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current); }, []);

  useEffect(() => {
    if (!focusRequest) return;
    if (lastHandledFocusSequenceRef.current === focusRequest.sequence) return;
    lastHandledFocusSequenceRef.current = focusRequest.sequence;
    const target = workspaceTarget(analysisState, focusRequest);
    if (!target) return;
    if (!viewContainsItem(view, target)) {
      const frame = requestAnimationFrame(() => setView('focus'));
      return () => cancelAnimationFrame(frame);
    }
    if (view === 'focus') return;
    const frame = requestAnimationFrame(() => document.getElementById(`workspace-item-${target.id}`)?.focus({ preventScroll: false }));
    return () => cancelAnimationFrame(frame);
  }, [analysisState, focusRequest, view]);

  const normalizedQuery = query.trim().toLocaleLowerCase('ja');
  const filteredTranscript = transcript.utterances.filter((item) => !normalizedQuery || `${item.speakerAlias ?? item.speaker} ${item.text}`.toLocaleLowerCase('ja').includes(normalizedQuery));
  const activeInsights = analysisState.items.filter((item) => !['withdrawn', 'superseded'].includes(item.status)).slice(-100).reverse();
  const nodeByEvidence = new Map<string, AnalysisItem>();
  for (const item of analysisState.items) for (const utteranceId of item.evidenceUtteranceIds) nodeByEvidence.set(utteranceId, item);

  return (
    <section aria-label="共有ディスカッションworkspace" className="mx-auto flex w-full max-w-[1800px] min-h-0 flex-col gap-2 p-2 md:p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#d5dcd7] bg-[#fbfaf7] p-2 shadow-sm">
        <div role="tablist" aria-label="議論の表示方法" className="flex flex-wrap gap-1">
          {(Object.keys(viewLabels) as WorkspaceView[]).map((candidate) => <button key={candidate} role="tab" aria-selected={view === candidate} onClick={() => setView(candidate)} className={`rounded-lg px-3 py-2 text-xs font-bold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#153f38] ${view === candidate ? 'bg-[#153f38] text-white' : 'border border-[#d5dcd7] bg-white text-[#43534e]'}`}>{viewLabels[candidate]}</button>)}
        </div>
        <div className="flex items-center gap-2">
          {projection.currentIssue && <p className="hidden max-w-xl truncate text-xs lg:block"><b>現在の論点:</b> {projection.currentIssue.title}</p>}
          <button aria-pressed={presentationMode} onClick={() => onPresentationModeChange(!presentationMode)} className={`rounded-lg border px-3 py-2 text-xs font-bold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#153f38] ${presentationMode ? 'border-[#276758] bg-[#e2f0e8] text-[#176044]' : 'border-[#d5dcd7] bg-white'}`}>{presentationMode ? '発表モード ON' : '発表モード'}</button>
        </div>
      </div>

      {projection.currentIssue && <div className="rounded-xl border border-[#d9b66e] bg-[#fff8e8] px-4 py-2 text-sm" aria-label="現在の論点"><span className="mr-2 text-xs font-bold text-[#7a5a28]">CURRENT ISSUE</span><b>{projection.currentIssue.title}</b><span className="ml-2 text-xs text-[#6a6252]">{projection.currentIssue.status}</span></div>}
      {operationStatus && <p role="status" aria-live="polite" className="rounded-lg border border-[#d2dad4] bg-white px-3 py-1.5 text-xs text-[#52615c]">{operationStatus}</p>}

      <div className={`grid min-h-0 flex-1 gap-2 ${presentationMode ? 'xl:grid-cols-[minmax(210px,.58fr)_minmax(600px,2fr)_minmax(230px,.68fr)]' : 'xl:grid-cols-[minmax(250px,.72fr)_minmax(520px,1.65fr)_minmax(270px,.78fr)]'}`}>
        <aside className="flex min-h-[300px] flex-col overflow-hidden rounded-2xl border border-[#d9ded8] bg-[#fbfaf7] shadow-[0_8px_30px_rgba(35,54,49,0.05)] xl:min-h-0">
          <div className="flex items-center justify-between border-b border-[#e2e5e0] px-3 py-2"><div><h2 className="text-sm font-semibold">発話タイムライン</h2><p className="text-[10px] text-[#5c6a66]">根拠から表示項目へ移動</p></div><button aria-expanded={showSearch} onClick={() => setShowSearch((value) => !value)} className="rounded-lg border bg-white px-2 py-1 text-xs">検索</button></div>
          {showSearch && <div className="border-b p-2"><input autoFocus aria-label="発話を検索" value={query} onChange={(event) => setQuery(event.target.value)} className="w-full rounded-lg border px-3 py-2 text-xs" placeholder="キーワードを入力" /></div>}
          <div className="flex-1 space-y-1 overflow-y-auto p-2">{filteredTranscript.map((item) => { const node = nodeByEvidence.get(item.id); const selected = node?.id === selectedItemId; return <article key={`${item.id}-${item.revision}`} className={`group rounded-xl p-3 ${selected ? 'bg-[#eaf2ed]' : 'hover:bg-[#f0f3ef]'}`}><div className="mb-1 flex gap-2 text-xs"><b>{item.speakerAlias ?? (item.speaker === 'self' ? '自分' : item.source === 'synthetic' ? '合成デモ' : '相手側')}</b><time className="ml-auto">{Math.floor(item.startMs / 60_000).toString().padStart(2, '0')}:{Math.floor((item.startMs % 60_000) / 1_000).toString().padStart(2, '0')}</time></div><p className="text-[13px] leading-6 text-[#46534f]">{item.text}</p>{item.phase === 'partial' ? <span className="mt-1 block text-xs text-[#76551f]">認識中</span> : <button onClick={() => onFocusItem(undefined, [item.id])} className="mt-1 text-xs font-bold text-[#276758] opacity-0 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100">{node ? '対応項目を表示 →' : '分析項目を確認 →'}</button>}</article>; })}{filteredTranscript.length === 0 && <p className="p-4 text-center text-xs text-[#5c6a66]">発話はまだありません</p>}</div>
        </aside>

        <div className="min-h-0">
          <div hidden={view !== 'focus'} className="h-full"><LiveMindMap analysisState={analysisState} focusRequest={focusRequest} canUndo={canUndo} canRedo={canRedo} onUndo={onUndo} onRedo={onRedo} onPatchItem={onPatchItem} onSelectionChange={onSelectionChange} selectedItemId={selectedItemId} layout={mapLayout} onLayoutChange={setMapLayout} active={view === 'focus'} highlightedItemIds={view === highlightedView ? highlightedIds : []} presentationMode={presentationMode} /></div>
          {view === 'decisions' && <Board label="決定ボード" columns={projection.decisions} selectedItemId={selectedItemId} highlightedIds={view === highlightedView ? highlightedIds : []} onSelectItem={(item) => onSelectionChange(item.id)} />}
          {view === 'actions-risks' && <Board label="Action・Riskボード" columns={projection.actionsAndRisks} selectedItemId={selectedItemId} highlightedIds={view === highlightedView ? highlightedIds : []} onSelectItem={(item) => onSelectionChange(item.id)} />}
        </div>

        <aside className="flex min-h-[320px] flex-col overflow-hidden rounded-2xl border border-[#d9ded8] bg-[#fbfaf7] shadow-[0_8px_30px_rgba(35,54,49,0.05)] xl:min-h-0"><div className="border-b px-3 py-2"><h2 className="text-sm font-semibold">会議インサイト</h2><p className="text-[10px] text-[#5c6a66]">論点・決定・未解決・Action</p></div><div className="flex-1 space-y-2 overflow-y-auto p-2">{activeInsights.map((item) => <article key={item.id} className={`insight insight-${item.kind} ${highlightedIds.includes(item.id) ? 'workspace-change-once' : ''}`}><div className="mb-1 flex justify-between"><span>{kindLabels[item.kind]} · {item.status}</span><span className="insight-meta">{Math.round(item.confidence * 100)}%</span></div><p>{item.title}</p><button onClick={() => onFocusItem(item.id, item.evidenceUtteranceIds)}>根拠 {item.evidenceUtteranceIds.join(' · ')}</button></article>)}{activeInsights.length === 0 && <p className="p-4 text-center text-xs text-[#5c6a66]">分析項目はまだありません</p>}</div></aside>
      </div>

      <section aria-label="今回の更新" className="rounded-xl border border-[#d4ddd7] bg-[#f9faf7] px-3 py-2"><div className="flex min-w-0 items-center gap-2 overflow-x-auto"><b className="shrink-0 text-xs">今回の更新</b><div role="status" aria-live="polite" className="flex min-w-0 gap-2">{recentChanges.map((change) => <button key={change.id} data-change-id={change.id} onClick={() => onFocusItem(change.itemId, change.evidenceUtteranceIds)} className="shrink-0 rounded-lg border border-[#d5ddd7] bg-white px-3 py-1.5 text-left text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#153f38]"><span aria-hidden="true" className="mr-1 font-bold text-[#276758]">{changeSymbols[change.kind]}</span><b>{changeLabels[change.kind]}</b> {change.title}{change.kind === 'status-changed' && <span> ({change.previousStatus} → {change.nextStatus})</span>}</button>)}{recentChanges.length === 0 && <span className="text-xs text-[#66736f]">次の分析更新を待機中</span>}</div></div></section>
    </section>
  );
}
