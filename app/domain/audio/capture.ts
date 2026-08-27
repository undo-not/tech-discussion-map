export const captureStates = [
  'active',
  'remote-audio-undetected',
  'degraded-microphone-only',
  'stopped',
] as const;

export type CaptureState = (typeof captureStates)[number];

export type CaptureEvent =
  | { type: 'capture-started'; explicitReconnect: boolean }
  | { type: 'remote-silence' }
  | { type: 'remote-signal' }
  | { type: 'stream-failed' }
  | { type: 'stop' };

export function isCaptureState(value: unknown): value is CaptureState {
  return typeof value === 'string' && captureStates.includes(value as CaptureState);
}

export function transitionCaptureState(current: CaptureState, event: CaptureEvent): CaptureState {
  switch (event.type) {
    case 'capture-started':
      if (current === 'stopped' || (current === 'degraded-microphone-only' && event.explicitReconnect)) {
        return 'active';
      }
      return current;
    case 'remote-silence':
      return current === 'active' ? 'remote-audio-undetected' : current;
    case 'remote-signal':
      return current === 'remote-audio-undetected' ? 'active' : current;
    case 'stream-failed':
      return current === 'active' || current === 'remote-audio-undetected'
        ? 'degraded-microphone-only'
        : current;
    case 'stop':
      return 'stopped';
  }
}
