import type { AnalysisItem, AnalysisState } from '../analysis/contract.ts';

export type WorkspaceView = 'focus' | 'decisions' | 'actions-risks';
export type WorkspaceColumnId = 'proposed' | 'blocked' | 'confirmed';
export type WorkspaceColumn = { id: WorkspaceColumnId; label: string; items: AnalysisItem[] };
export type WorkspaceProjection = {
  activeItems: AnalysisItem[];
  currentIssue: AnalysisItem | null;
  decisions: WorkspaceColumn[];
  actionsAndRisks: WorkspaceColumn[];
  highlights: {
    decisions: AnalysisItem[];
    questions: AnalysisItem[];
    risks: AnalysisItem[];
    actions: AnalysisItem[];
  };
};

export type WorkspaceChangeKind = 'added' | 'updated' | 'status-changed';
export type WorkspaceChange = {
  id: string;
  revision: number;
  itemId: string;
  kind: WorkspaceChangeKind;
  title: string;
  previousStatus: AnalysisItem['status'] | null;
  nextStatus: AnalysisItem['status'];
  evidenceUtteranceIds: string[];
};

const inactiveStatuses = new Set<AnalysisItem['status']>(['withdrawn', 'superseded']);

function latestFirst(items: AnalysisItem[]): AnalysisItem[] {
  return [...items].reverse();
}

function projectColumns(items: AnalysisItem[]): WorkspaceColumn[] {
  return [
    { id: 'proposed', label: '提案・進行中', items: items.filter((item) => item.status === 'proposed' || item.status === 'open') },
    { id: 'blocked', label: '保留・阻害', items: items.filter((item) => item.status === 'blocked') },
    { id: 'confirmed', label: '確認済み・完了', items: items.filter((item) => item.status === 'confirmed' || item.status === 'done') },
  ];
}

export function projectWorkspace(state: AnalysisState): WorkspaceProjection {
  const activeItems = state.items.filter((item) => !inactiveStatuses.has(item.status));
  const newest = latestFirst(activeItems);
  const currentIssue = newest.find((item) =>
    (item.kind === 'question' || item.kind === 'topic') &&
    (item.status === 'proposed' || item.status === 'open' || item.status === 'blocked')) ?? null;
  const decisions = newest.filter((item) => item.kind === 'decision');
  const actionsAndRisks = newest.filter((item) => item.kind === 'action' || item.kind === 'risk');
  return {
    activeItems,
    currentIssue,
    decisions: projectColumns(decisions),
    actionsAndRisks: projectColumns(actionsAndRisks),
    highlights: {
      decisions: decisions.slice(0, 8),
      questions: newest.filter((item) => item.kind === 'question').slice(0, 8),
      risks: newest.filter((item) => item.kind === 'risk').slice(0, 8),
      actions: newest.filter((item) => item.kind === 'action').slice(0, 8),
    },
  };
}

function semanticItemValue(item: AnalysisItem): string {
  return JSON.stringify({
    kind: item.kind,
    title: item.title,
    detail: item.detail,
    confidence: item.confidence,
    provenance: item.provenance,
    evidenceUtteranceIds: [...item.evidenceUtteranceIds].sort(),
    links: item.links.map((link) => `${link.targetId}:${link.relation}`).sort(),
  });
}

export function diffWorkspace(previous: AnalysisState, next: AnalysisState): WorkspaceChange[] {
  if (previous.revision === next.revision) return [];
  const previousItems = new Map(previous.items.map((item) => [item.id, item]));
  const changes: WorkspaceChange[] = [];
  for (const item of next.items) {
    const before = previousItems.get(item.id);
    let kind: WorkspaceChangeKind | null = null;
    if (!before) kind = 'added';
    else if (before.status !== item.status) kind = 'status-changed';
    else if (semanticItemValue(before) !== semanticItemValue(item)) kind = 'updated';
    if (!kind) continue;
    changes.push({
      id: `${next.revision}-${kind}-${item.id}`,
      revision: next.revision,
      itemId: item.id,
      kind,
      title: item.title,
      previousStatus: before?.status ?? null,
      nextStatus: item.status,
      evidenceUtteranceIds: [...item.evidenceUtteranceIds],
    });
  }
  return changes;
}

export function viewContainsItem(view: WorkspaceView, item: AnalysisItem): boolean {
  if (view === 'focus') return true;
  if (view === 'decisions') return item.kind === 'decision';
  return item.kind === 'action' || item.kind === 'risk';
}
