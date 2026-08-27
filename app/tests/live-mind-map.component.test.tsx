import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { LiveMindMap } from '../components/live-mind-map.tsx';
import { validateAnalysisState, type AnalysisState } from '../domain/analysis/contract.ts';

const utterances = Array.from({ length: 240 }, (_, index) => ({
  id: `component-u${index}`, revision: 1, phase: 'final' as const, source: 'synthetic' as const,
  speaker: 'unknown' as const, startMs: index, endMs: index + 1, text: `合成発話 ${index}`,
}));
const kinds = ['topic', 'claim', 'question', 'decision', 'action', 'dependency', 'risk'] as const;

function stateWithNodes(count: number, revision = 0): AnalysisState {
  return validateAnalysisState({
    contractVersion: 1, revision, appliedDeltas: [],
    items: Array.from({ length: count }, (_, index) => ({
      id: `component-node-${index}`, kind: kinds[index % kinds.length], title: `合成node ${index}`, detail: `詳細 ${index}`,
      status: 'open', confidence: 0.8, provenance: 'ai-suggested', evidenceUtteranceIds: [`component-u${index}`], links: [],
    })),
  }, utterances);
}

const baseProps = {
  canUndo: false, canRedo: false, onUndo: vi.fn(), onRedo: vi.fn(), onPatchItem: vi.fn(() => true),
};

describe('LiveMindMap DOM integration', () => {
  let frames: FrameRequestCallback[];

  beforeEach(() => {
    frames = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 520 });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 620 });
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value(options: ScrollToOptions) {
      if (typeof options.left === 'number') this.scrollLeft = options.left;
      if (typeof options.top === 'number') this.scrollTop = options.top;
    } });
  });

  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  const flushFrames = () => {
    while (frames.length > 0) {
      const pending = frames.splice(0);
      act(() => { for (const callback of pending) callback(performance.now()); });
    }
  };

  test('an evidence navigation request selects and focuses the live node', async () => {
    const state = stateWithNodes(3);
    render(<LiveMindMap {...baseProps} analysisState={state} focusRequest={{ sequence: 1, evidenceUtteranceIds: ['component-u2'] }} />);
    flushFrames();
    await waitFor(() => expect(document.activeElement).toBe(document.getElementById('map-node-component-node-2')));
    expect(screen.getByLabelText(/合成node 2/).getAttribute('aria-current')).toBe('true');
  });

  test('the explicit top command reframes a normal 100-node map', () => {
    render(<LiveMindMap {...baseProps} analysisState={stateWithNodes(100)} />);
    flushFrames();
    const viewport = screen.getByRole('region', { name: 'マップviewport' });
    viewport.scrollTop = 900;
    viewport.scrollLeft = 400;
    fireEvent.click(screen.getByRole('button', { name: '先頭へ' }));
    flushFrames();
    expect(viewport.scrollTop).toBe(68);
    expect(viewport.scrollLeft).toBe(36);
  });

  test('a focus callback created before the 100-node boundary keeps degraded following active', () => {
    const first = stateWithNodes(100);
    const view = render(<LiveMindMap {...baseProps} analysisState={first} focusRequest={{ sequence: 1, itemId: 'component-node-99', evidenceUtteranceIds: ['component-u99'] }} />);
    view.rerender(<LiveMindMap {...baseProps} analysisState={stateWithNodes(101, 1)} focusRequest={{ sequence: 1, itemId: 'component-node-99', evidenceUtteranceIds: ['component-u99'] }} />);
    flushFrames();
    const viewport = screen.getByRole('region', { name: 'マップviewport' });
    const followedTop = viewport.scrollTop;
    expect(followedTop).toBeGreaterThan(0);

    view.rerender(<LiveMindMap {...baseProps} analysisState={stateWithNodes(202, 2)} focusRequest={{ sequence: 1, itemId: 'component-node-99', evidenceUtteranceIds: ['component-u99'] }} />);
    flushFrames();
    expect(viewport.scrollTop).toBeGreaterThan(followedTop);
  });
});
