import { validateAnalysisState, type AnalysisItem, type AnalysisKind, type AnalysisState } from '../analysis/contract.ts';
import type { TranscriptUtterance } from '../transcription/utterance.ts';

export type MapPosition = { x: number; y: number };
export type MapLayout = { positions: Record<string, MapPosition> };
export type MapViewport = { scrollLeft: number; scrollTop: number; width: number; height: number };
export type AnalysisHistory = { past: AnalysisState[]; present: AnalysisState; future: AnalysisState[] };
export type HumanItemPatch = { title?: string; detail?: string; status?: AnalysisItem['status']; confirm?: boolean };
export type DegradedAutoPosition = { shouldPosition: boolean; nextKey: string };

export const maximumHistoryEntries = 50;
export const maximumRenderedNodes = 100;
export const mapNodeWidth = 210;
export const mapNodeHeight = 104;

const laneByKind: Record<AnalysisKind, number> = {
  question: 0, risk: 0, topic: 1, claim: 1, decision: 2, action: 2, dependency: 2,
};
const laneX = [60, 390, 720] as const;

export function createAnalysisHistory(initial: AnalysisState): AnalysisHistory {
  return { past: [], present: structuredClone(initial), future: [] };
}

export function commitAnalysisHistory(history: AnalysisHistory, next: AnalysisState, reset = false): AnalysisHistory {
  if (reset) return createAnalysisHistory(next);
  if (next === history.present || JSON.stringify(next) === JSON.stringify(history.present)) return history;
  return { past: [...history.past, structuredClone(history.present)].slice(-maximumHistoryEntries), present: structuredClone(next), future: [] };
}

function restoredState(current: AnalysisState, target: AnalysisState, utterances: TranscriptUtterance[]): AnalysisState {
  return validateAnalysisState({
    ...structuredClone(target),
    revision: current.revision + 1,
    appliedDeltas: structuredClone(current.appliedDeltas),
  }, utterances);
}

export function undoAnalysisHistory(history: AnalysisHistory, utterances: TranscriptUtterance[]): AnalysisHistory {
  const target = history.past.at(-1);
  if (!target) return history;
  return {
    past: history.past.slice(0, -1),
    present: restoredState(history.present, target, utterances),
    future: [structuredClone(history.present), ...history.future].slice(0, maximumHistoryEntries),
  };
}

export function redoAnalysisHistory(history: AnalysisHistory, utterances: TranscriptUtterance[]): AnalysisHistory {
  const target = history.future[0];
  if (!target) return history;
  return {
    past: [...history.past, structuredClone(history.present)].slice(-maximumHistoryEntries),
    present: restoredState(history.present, target, utterances),
    future: history.future.slice(1),
  };
}

export function applyHumanItemPatch(state: AnalysisState, itemId: string, patch: HumanItemPatch, utterances: TranscriptUtterance[]): AnalysisState {
  const next = structuredClone(state);
  const item = next.items.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error('mind-map-unknown-item');
  const title = patch.title?.trim();
  const detail = patch.detail?.trim();
  const edited = (title !== undefined && title !== item.title) || (detail !== undefined && detail !== item.detail) || (patch.status !== undefined && patch.status !== item.status);
  const confirmed = patch.confirm === true && item.provenance === 'ai-suggested';
  if (!edited && !confirmed) return structuredClone(state);
  if (title !== undefined) item.title = title;
  if (detail !== undefined) item.detail = detail;
  if (patch.status !== undefined) item.status = patch.status;
  item.provenance = edited ? 'human-edited' : 'human-confirmed';
  next.revision += 1;
  return validateAnalysisState(next, utterances);
}

export function reconcileMapLayout(previous: MapLayout, state: AnalysisState): MapLayout {
  const positions = { ...previous.positions };
  const occupied = new Set(Object.values(positions).map((position) => `${position.x}:${position.y}`));
  const laneSlots = [0, 0, 0];
  for (const position of Object.values(positions)) {
    const lane = laneX.reduce((best, x, index) => Math.abs(position.x - x) < Math.abs(position.x - laneX[best]) ? index : best, 0);
    laneSlots[lane] = Math.max(laneSlots[lane], Math.floor((position.y - 92) / 132) + 1);
  }
  for (const item of state.items) {
    if (positions[item.id]) continue;
    const lane = laneByKind[item.kind];
    let slot = laneSlots[lane];
    let position = { x: laneX[lane], y: 92 + slot * 132 };
    while (occupied.has(`${position.x}:${position.y}`)) { slot += 1; position = { x: laneX[lane], y: 92 + slot * 132 }; }
    laneSlots[lane] = slot + 1;
    positions[item.id] = position;
    occupied.add(`${position.x}:${position.y}`);
  }
  return { positions };
}

export function resetMapLayout(): MapLayout {
  return { positions: {} };
}

export function latestRenderedMapItems(items: AnalysisItem[]): AnalysisItem[] {
  return items.slice(-maximumRenderedNodes);
}

export function mapCanvasHeight(layout: MapLayout, visibleIds: Set<string>): number {
  const maximumY = Object.entries(layout.positions).reduce((result, [id, position]) => visibleIds.has(id) ? Math.max(result, position.y) : result, 0);
  return Math.max(620, maximumY + mapNodeHeight + 80);
}

export function nearestNodeId(currentId: string, direction: 'left' | 'right' | 'up' | 'down', candidateIds: string[], layout: MapLayout): string {
  const current = layout.positions[currentId];
  if (!current) return candidateIds[0] ?? currentId;
  const directional = candidateIds
    .filter((id) => id !== currentId && layout.positions[id])
    .map((id) => ({ id, position: layout.positions[id] }))
    .filter(({ position }) => direction === 'left' ? position.x < current.x : direction === 'right' ? position.x > current.x : direction === 'up' ? position.y < current.y : position.y > current.y)
    .sort((left, right) => {
      const leftDistance = Math.hypot(left.position.x - current.x, left.position.y - current.y);
      const rightDistance = Math.hypot(right.position.x - current.x, right.position.y - current.y);
      return leftDistance - rightDistance || left.id.localeCompare(right.id);
    });
  return directional[0]?.id ?? currentId;
}

export function visibleSelectionId(selectedId: string, visibleIds: string[]): string {
  return visibleIds.includes(selectedId) ? selectedId : visibleIds[0] ?? '';
}

export function canCommitMapEdit(editingItemId: string, selectedItemId: string): boolean {
  return editingItemId !== '' && editingItemId === selectedItemId;
}

export function degradedAutoPosition(previousKey: string, filterKey: string, degraded: boolean): DegradedAutoPosition {
  if (!degraded) return { shouldPosition: false, nextKey: '' };
  return { shouldPosition: previousKey !== filterKey, nextKey: filterKey };
}

export function scrollTargetForNode(viewport: MapViewport, position: MapPosition, zoom: number, padding = 24): { left: number; top: number } {
  const nodeLeft = position.x * zoom;
  const nodeTop = position.y * zoom;
  const nodeRight = (position.x + mapNodeWidth) * zoom;
  const nodeBottom = (position.y + mapNodeHeight) * zoom;
  let left = viewport.scrollLeft;
  let top = viewport.scrollTop;
  if (nodeLeft < viewport.scrollLeft + padding) left = nodeLeft - padding;
  else if (nodeRight > viewport.scrollLeft + viewport.width - padding) left = nodeRight - viewport.width + padding;
  if (nodeTop < viewport.scrollTop + padding) top = nodeTop - padding;
  else if (nodeBottom > viewport.scrollTop + viewport.height - padding) top = nodeBottom - viewport.height + padding;
  return { left: Math.max(0, Math.round(left)), top: Math.max(0, Math.round(top)) };
}

export function scrollTargetForVisibleItems(viewport: MapViewport, itemIds: string[], layout: MapLayout, zoom: number): { left: number; top: number } | null {
  const positions = itemIds.map((id) => layout.positions[id]).filter((position): position is MapPosition => Boolean(position));
  if (positions.length === 0) return null;
  const viewportRight = viewport.scrollLeft + viewport.width;
  const viewportBottom = viewport.scrollTop + viewport.height;
  const intersects = positions.some((position) => {
    const left = position.x * zoom;
    const top = position.y * zoom;
    return left < viewportRight && (position.x + mapNodeWidth) * zoom > viewport.scrollLeft && top < viewportBottom && (position.y + mapNodeHeight) * zoom > viewport.scrollTop;
  });
  if (intersects) return { left: viewport.scrollLeft, top: viewport.scrollTop };
  const first = [...positions].sort((left, right) => left.y - right.y || left.x - right.x)[0];
  return { left: Math.max(0, Math.round(first.x * zoom - 24)), top: Math.max(0, Math.round(first.y * zoom - 24)) };
}
