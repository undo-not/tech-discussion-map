import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { CapturePanel } from '../components/capture-panel.tsx';
import { emptyAnalysisState, type AnalysisState } from '../domain/analysis/contract.ts';

type CaptionInstance = {
  resolveStart: () => void;
  stopCalls: number;
  fail: () => void;
  failResume: () => void;
};

type TeamsAudioInstance = {
  startCalls: number[];
  listenCalls: number;
  stopCalls: number;
  fail: () => void;
  emit: (event: unknown) => void;
};

const captionHarness = vi.hoisted(() => ({ instances: [] as CaptionInstance[] }));
const microphoneHarness = vi.hoisted(() => ({
  captures: [] as Array<{ stopCalls: number }>,
  clients: [] as CaptionInstance[],
}));
const teamsAudioHarness = vi.hoisted(() => ({ instances: [] as TeamsAudioInstance[] }));

vi.mock('@/adapters/audio/browser-microphone.ts', () => ({
  isLoopbackRuntime: () => true,
  listMicrophones: () => Promise.resolve([]),
  startMicrophoneCapture: () => {
    const record = { stopCalls: 0 };
    microphoneHarness.captures.push(record);
    return Promise.resolve({
      pause: () => undefined,
      resume: () => undefined,
      stop: () => { record.stopCalls += 1; return Promise.resolve(); },
    });
  },
}));

vi.mock('@/adapters/persistence/legacy-store-migration.ts', () => ({
  purgeLegacyPlaintextTranscripts: () => Promise.resolve(),
}));

vi.mock('@/adapters/transcription/local-caption-client.ts', () => ({
  LocalCaptionClient: class {
    onFailure: (reason: string) => void = () => undefined;
    readonly #record: CaptionInstance;
    readonly #started: Promise<void>;

    constructor() {
      let resolveStart: () => void = () => undefined;
      this.#started = new Promise<void>((resolve) => { resolveStart = resolve; });
      let resumeFails = false;
      this.#record = {
        resolveStart,
        stopCalls: 0,
        fail: () => this.onFailure('synthetic-failure'),
        failResume: () => { resumeFails = true; },
      };
      captionHarness.instances.push(this.#record);
      this.#resume = () => resumeFails ? Promise.reject(new Error('synthetic-resume-failure')) : Promise.resolve();
    }

    readonly #resume: () => Promise<void>;
    start(): Promise<void> { return this.#started; }
    pause(): Promise<void> { return Promise.resolve(); }
    resume(): Promise<void> { return this.#resume(); }
    stop(): Promise<void> { this.#record.stopCalls += 1; return Promise.resolve(); }
  },
}));

vi.mock('@/adapters/transcription/local-companion-client.ts', () => ({
  LocalCompanionTranscriptionClient: class {
    onFailure: (reason: string) => void = () => undefined;
    readonly #record: CaptionInstance;
    readonly #started: Promise<void>;

    constructor() {
      let resolveStart: () => void = () => undefined;
      this.#started = new Promise<void>((resolve) => { resolveStart = resolve; });
      this.#record = {
        resolveStart,
        stopCalls: 0,
        fail: () => this.onFailure('synthetic-failure'),
        failResume: () => undefined,
      };
      microphoneHarness.clients.push(this.#record);
    }

    start(): Promise<void> { return this.#started; }
    sendPcm(): Promise<void> { return Promise.resolve(); }
    pause(): Promise<void> { return Promise.resolve(); }
    resume(): Promise<void> { return Promise.resolve(); }
    stop(): Promise<void> { this.#record.stopCalls += 1; return Promise.resolve(); }
  },
}));

vi.mock('@/adapters/audio/local-teams-audio-client.ts', () => ({
  LocalTeamsAudioClient: class {
    onFailure: (reason: string) => void = () => undefined;
    readonly #record: TeamsAudioInstance;

    constructor(onEvent: (event: unknown) => void) {
      this.#record = {
        startCalls: [], listenCalls: 0, stopCalls: 0,
        fail: () => this.onFailure('synthetic-remote-failure'),
        emit: (event) => onEvent(event),
      };
      teamsAudioHarness.instances.push(this.#record);
    }

    probe(): Promise<unknown> {
      return Promise.resolve({
        windowsBuild: 26100, minimumBuild: 20348, supportedBuild: true, teamsProcessCount: 1,
        selectedProcessId: 4242, targetFound: true, activationAttempted: true,
        activationSucceeded: true, activationHresult: '0x00000000',
      });
    }
    start(processId: number): Promise<void> { this.#record.startCalls.push(processId); return Promise.resolve(); }
    listen(): void { this.#record.listenCalls += 1; }
    stop(): Promise<void> { this.#record.stopCalls += 1; return Promise.resolve(); }
  },
}));

afterEach(() => {
  cleanup();
  captionHarness.instances.length = 0;
  microphoneHarness.captures.length = 0;
  microphoneHarness.clients.length = 0;
  teamsAudioHarness.instances.length = 0;
});

describe('CapturePanel input ownership', () => {
  test('a delayed cancelled caption start cannot stop or hide its successful replacement', async () => {
    let analysisState: AnalysisState = emptyAnalysisState;
    render(<CapturePanel
      analysisState={analysisState}
      getAnalysisState={() => analysisState}
      onAnalysisStateChange={(next) => { analysisState = next; }}
    />);

    fireEvent.click(screen.getByRole('checkbox', { name: /全参加者がこのアプリの文字起こし・分析に同意/ }));
    const firstStartButton = screen.getByRole('button', { name: 'Teams字幕OCRを開始' });
    fireEvent.click(firstStartButton);
    fireEvent.click(firstStartButton);
    expect(captionHarness.instances).toHaveLength(1);

    fireEvent.click(await screen.findByRole('button', { name: '終了' }));
    await screen.findByRole('button', { name: 'Teams字幕OCRを開始' });
    fireEvent.click(screen.getByRole('button', { name: 'Teams字幕OCRを開始' }));
    expect(captionHarness.instances).toHaveLength(2);

    captionHarness.instances[1].resolveStart();
    await screen.findByRole('button', { name: '一時停止' });
    expect(screen.getByText(/入力: Teams caption OCR/)).toBeTruthy();

    captionHarness.instances[0].resolveStart();
    await waitFor(() => expect(captionHarness.instances[0].stopCalls).toBeGreaterThan(0));
    captionHarness.instances[0].fail();
    expect(captionHarness.instances[1].stopCalls).toBe(0);
    expect(screen.getByRole('button', { name: '一時停止' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '終了' })).toBeTruthy();
    expect(screen.getByText(/入力: Teams caption OCR/)).toBeTruthy();
  });

  test('consent revocation discards a caption client that finishes starting later', async () => {
    let analysisState: AnalysisState = emptyAnalysisState;
    render(<CapturePanel
      analysisState={analysisState}
      getAnalysisState={() => analysisState}
      onAnalysisStateChange={(next) => { analysisState = next; }}
    />);

    const consent = screen.getByRole('checkbox', { name: /全参加者がこのアプリの文字起こし・分析に同意/ });
    fireEvent.click(consent);
    fireEvent.click(screen.getByRole('button', { name: 'Teams字幕OCRを開始' }));
    expect(captionHarness.instances).toHaveLength(1);
    fireEvent.click(consent);
    captionHarness.instances[0].resolveStart();

    await waitFor(() => expect(captionHarness.instances[0].stopCalls).toBeGreaterThan(0));
    expect(screen.getByText('CAPTURE OFF')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '一時停止' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Teams字幕OCRを開始' }) as HTMLButtonElement).disabled).toBe(true);
  });

  test('failure from the owned caption client releases the input slot for retry', async () => {
    let analysisState: AnalysisState = emptyAnalysisState;
    render(<CapturePanel
      analysisState={analysisState}
      getAnalysisState={() => analysisState}
      onAnalysisStateChange={(next) => { analysisState = next; }}
    />);

    fireEvent.click(screen.getByRole('checkbox', { name: /全参加者がこのアプリの文字起こし・分析に同意/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Teams字幕OCRを開始' }));
    captionHarness.instances[0].resolveStart();
    await screen.findByRole('button', { name: '一時停止' });

    captionHarness.instances[0].fail();
    await screen.findByRole('button', { name: 'Teams字幕OCRを開始' });
    expect(screen.getByText('CAPTURE OFF')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Teams字幕OCRを開始' }));
    expect(captionHarness.instances).toHaveLength(2);
  });

  test('caption resume failure releases ownership and allows a fresh input session', async () => {
    let analysisState: AnalysisState = emptyAnalysisState;
    render(<CapturePanel
      analysisState={analysisState}
      getAnalysisState={() => analysisState}
      onAnalysisStateChange={(next) => { analysisState = next; }}
    />);

    fireEvent.click(screen.getByRole('checkbox', { name: /全参加者がこのアプリの文字起こし・分析に同意/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Teams字幕OCRを開始' }));
    captionHarness.instances[0].resolveStart();
    fireEvent.click(await screen.findByRole('button', { name: '一時停止' }));
    captionHarness.instances[0].failResume();
    fireEvent.click(await screen.findByRole('button', { name: '再開' }));

    await screen.findByRole('button', { name: 'Teams字幕OCRを開始' });
    fireEvent.click(screen.getByRole('button', { name: 'Teams字幕OCRを開始' }));
    expect(captionHarness.instances).toHaveLength(2);
  });

  test('a delayed cancelled microphone client cannot tear down its successful replacement', async () => {
    let analysisState: AnalysisState = emptyAnalysisState;
    render(<CapturePanel
      analysisState={analysisState}
      getAnalysisState={() => analysisState}
      onAnalysisStateChange={(next) => { analysisState = next; }}
    />);

    fireEvent.click(screen.getByRole('checkbox', { name: /全参加者がこのアプリの文字起こし・分析に同意/ }));
    fireEvent.click(screen.getByRole('button', { name: 'マイクを開始' }));
    await waitFor(() => expect(microphoneHarness.clients).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: '終了' }));
    await screen.findByRole('button', { name: 'マイクを開始' });

    fireEvent.click(screen.getByRole('button', { name: 'マイクを開始' }));
    await waitFor(() => expect(microphoneHarness.clients).toHaveLength(2));
    microphoneHarness.clients[1].resolveStart();
    await screen.findByRole('button', { name: '一時停止' });

    microphoneHarness.clients[0].resolveStart();
    await waitFor(() => expect(microphoneHarness.clients[0].stopCalls).toBeGreaterThan(0));
    microphoneHarness.clients[0].fail();
    expect(microphoneHarness.clients[1].stopCalls).toBe(0);
    expect(microphoneHarness.captures[1].stopCalls).toBe(0);
    expect(screen.getByRole('button', { name: '一時停止' })).toBeTruthy();
    expect(screen.getByText(/入力: microphone/)).toBeTruthy();
  });

  test('unmount discards a caption client that finishes starting later', async () => {
    let analysisState: AnalysisState = emptyAnalysisState;
    const view = render(<CapturePanel
      analysisState={analysisState}
      getAnalysisState={() => analysisState}
      onAnalysisStateChange={(next) => { analysisState = next; }}
    />);

    fireEvent.click(screen.getByRole('checkbox', { name: /全参加者がこのアプリの文字起こし・分析に同意/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Teams字幕OCRを開始' }));
    expect(captionHarness.instances).toHaveLength(1);
    view.unmount();
    captionHarness.instances[0].resolveStart();

    await waitFor(() => expect(captionHarness.instances[0].stopCalls).toBeGreaterThan(0));
  });

  test('caption failure never activates the audio fallback automatically', async () => {
    let analysisState: AnalysisState = emptyAnalysisState;
    render(<CapturePanel analysisState={analysisState} getAnalysisState={() => analysisState} onAnalysisStateChange={(next) => { analysisState = next; }} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /全参加者がこのアプリの文字起こし・分析に同意/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Teams字幕OCRを開始' }));
    captionHarness.instances[0].resolveStart();
    await screen.findByRole('button', { name: '一時停止' });
    captionHarness.instances[0].fail();
    await screen.findByRole('button', { name: 'Teams音声を診断' });
    expect(teamsAudioHarness.instances).toHaveLength(0);
    expect(microphoneHarness.captures).toHaveLength(0);
  });

  test('audio fallback requires probe and second start, then degrades to microphone-only on remote failure', async () => {
    let analysisState: AnalysisState = emptyAnalysisState;
    render(<CapturePanel analysisState={analysisState} getAnalysisState={() => analysisState} onAnalysisStateChange={(next) => { analysisState = next; }} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /全参加者がこのアプリの文字起こし・分析に同意/ }));

    fireEvent.click(screen.getByRole('button', { name: 'Teams音声を診断' }));
    const start = await screen.findByRole('button', { name: '診断済み音声フォールバックを開始' });
    expect(microphoneHarness.captures).toHaveLength(0);
    expect(teamsAudioHarness.instances[0].stopCalls).toBe(1);

    fireEvent.click(start);
    await waitFor(() => expect(microphoneHarness.clients).toHaveLength(1));
    microphoneHarness.clients[0].resolveStart();
    await screen.findByText(/入力: audio fallback \(active\)/);
    expect(teamsAudioHarness.instances[1].startCalls).toEqual([4242]);
    expect(teamsAudioHarness.instances[1].listenCalls).toBe(1);
    expect(screen.queryByRole('button', { name: '一時停止' })).toBeNull();

    teamsAudioHarness.instances[1].emit({
      type: 'utterance',
      utterance: { id: 'remote-000001', revision: 1, phase: 'final', source: 'remote', speaker: 'remote-group', startMs: 0, endMs: 1000, text: '合成された相手側発話' },
    });
    expect((await screen.findAllByText(/合成された相手側発話/)).length).toBeGreaterThan(0);
    teamsAudioHarness.instances[1].fail();
    await screen.findByText(/入力: audio fallback \(degraded-microphone-only\)/);
    expect(microphoneHarness.captures[0].stopCalls).toBe(0);
    expect(microphoneHarness.clients[0].stopCalls).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: '終了' }));
    await screen.findByText('CAPTURE OFF');
    expect(microphoneHarness.captures[0].stopCalls).toBe(1);
    expect(microphoneHarness.clients[0].stopCalls).toBe(1);
  });
});
