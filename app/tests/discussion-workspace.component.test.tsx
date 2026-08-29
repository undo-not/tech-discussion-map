import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { DiscussionWorkspace } from '../components/discussion-workspace.tsx';
import type { AnalysisItem, AnalysisState } from '../domain/analysis/contract.ts';

const analysisItem = (id: string, kind: AnalysisItem['kind'], status: AnalysisItem['status'], title = id): AnalysisItem => ({
  id, kind, status, title, detail: `${title} detail`, confidence: 0.8,
  provenance: 'ai-suggested', evidenceUtteranceIds: [`u-${id}`], links: [],
});
const analysisState = (revision: number, items: AnalysisItem[]): AnalysisState => ({ contractVersion: 1, revision, items, appliedDeltas: [] });
const transcript = {
  utterances: [{ id: 'u-decision', revision: 1, phase: 'final' as const, source: 'synthetic' as const, speaker: 'unknown' as const, startMs: 0, endMs: 1, text: '合成された決定根拠' }],
  finalForAnalysis: [],
};
const items = [analysisItem('topic', 'topic', 'open', '中心論点'), analysisItem('decision', 'decision', 'proposed', '採用候補'), analysisItem('action', 'action', 'open', '次の作業')];

function props(state = analysisState(1, items)) {
  return {
    analysisState: state, transcript, selectedItemId: '', canUndo: false, canRedo: false,
    onUndo: vi.fn(), onRedo: vi.fn(), onPatchItem: vi.fn(() => true), onSelectionChange: vi.fn(), onFocusItem: vi.fn(),
    presentationMode: false, onPresentationModeChange: vi.fn(),
  };
}

afterEach(cleanup);

describe('DiscussionWorkspace', () => {
  test('switches deterministic views while keeping the map mounted and selection shared', () => {
    const callbacks = props();
    render(<DiscussionWorkspace {...callbacks} />);
    expect(document.getElementById('map-node-topic')).not.toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: '決定ボード' }));
    expect(screen.getByRole('region', { name: '決定ボード' })).toBeTruthy();
    fireEvent.click(document.querySelector('[data-workspace-item="decision"]') as HTMLElement);
    expect(callbacks.onFocusItem).toHaveBeenCalledWith('decision', ['u-decision']);
    fireEvent.click(screen.getByRole('tab', { name: 'Action・Risk' }));
    expect(document.querySelector('[data-workspace-item="action"]')).not.toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: '議論フォーカス' }));
    expect(document.getElementById('map-node-topic')).not.toBeNull();
  });

  test('explicit evidence navigation switches to focus when active board cannot represent the target', async () => {
    const callbacks = props();
    const view = render(<DiscussionWorkspace {...callbacks} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Action・Risk' }));
    view.rerender(<DiscussionWorkspace {...callbacks} focusRequest={{ sequence: 1, itemId: 'decision', evidenceUtteranceIds: ['u-decision'] }} />);
    await waitFor(() => expect(screen.getByRole('tab', { name: '議論フォーカス' }).getAttribute('aria-selected')).toBe('true'));
  });

  test('shows one semantic change entry and does not replay it for the same revision', async () => {
    const callbacks = props();
    const view = render(<DiscussionWorkspace {...callbacks} />);
    const next = analysisState(2, items.map((item) => item.id === 'decision' ? { ...item, status: 'blocked' } : item));
    view.rerender(<DiscussionWorkspace {...callbacks} analysisState={next} />);
    await waitFor(() => expect(document.querySelectorAll('[data-change-id="2-status-changed-decision"]')).toHaveLength(1));
    view.rerender(<DiscussionWorkspace {...callbacks} analysisState={next} />);
    expect(document.querySelectorAll('[data-change-id="2-status-changed-decision"]')).toHaveLength(1);
  });

  test('presentation mode is an explicit user control', () => {
    const callbacks = props();
    render(<DiscussionWorkspace {...callbacks} />);
    fireEvent.click(screen.getByRole('button', { name: '発表モード' }));
    expect(callbacks.onPresentationModeChange).toHaveBeenCalledWith(true);
  });
});
