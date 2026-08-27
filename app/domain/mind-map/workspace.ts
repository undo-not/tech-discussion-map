import { validateAnalysisState, type AnalysisItem, type AnalysisKind, type AnalysisState } from '../analysis/contract.ts';
import type { TranscriptUtterance } from '../transcription/utterance.ts';

export type MapPosition = { x: number; y: number };
export type MapLayout = { positions: Record<string, MapPosition> };
export type AnalysisHistory = { past: AnalysisState[]; present: AnalysisState; future: AnalysisState[] };
export type HumanItemPatch = { title?: string; detail?: string; status?: AnalysisItem['status']; confirm?: boolean };

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
  if (patch.title !== undefined) item.title = patch.title.trim();
  if (patch.detail !== undefined) item.detail = patch.detail.trim();
  if (patch.status !== undefined) item.status = patch.status;
  const edited = patch.title !== undefined || patch.detail !== undefined || patch.status !== undefined;
  item.provenance = edited ? 'human-edited' : patch.confirm ? 'human-confirmed' : item.provenance;
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
