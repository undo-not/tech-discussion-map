export const transcriptionSessionStates = [
  'idle',
  'requesting-permission',
  'starting-local-engine',
  'listening',
  'paused',
  'stopped',
  'permission-denied',
  'device-unavailable',
  'engine-unavailable',
] as const;

export type TranscriptionSessionState = (typeof transcriptionSessionStates)[number];

export type TranscriptionSessionEvent =
  | { type: 'start-requested' }
  | { type: 'demo-started' }
  | { type: 'permission-granted' }
  | { type: 'started' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'stop' }
  | { type: 'permission-denied' }
  | { type: 'device-unavailable' }
  | { type: 'engine-unavailable' };

export function transitionTranscriptionSession(
  current: TranscriptionSessionState,
  event: TranscriptionSessionEvent,
): TranscriptionSessionState {
  switch (event.type) {
    case 'demo-started':
      return current === 'idle' || current === 'stopped' || current === 'engine-unavailable' || current === 'permission-denied' || current === 'device-unavailable' ? 'listening' : current;
    case 'start-requested':
      return current === 'idle' || current === 'stopped' || current === 'engine-unavailable' || current === 'permission-denied' || current === 'device-unavailable'
        ? 'requesting-permission'
        : current;
    case 'permission-granted':
      return current === 'requesting-permission' ? 'starting-local-engine' : current;
    case 'started':
      return current === 'starting-local-engine' ? 'listening' : current;
    case 'pause':
      return current === 'listening' ? 'paused' : current;
    case 'resume':
      return current === 'paused' ? 'listening' : current;
    case 'stop':
      return 'stopped';
    case 'permission-denied':
      return current === 'requesting-permission' ? 'permission-denied' : current;
    case 'device-unavailable':
      return current === 'requesting-permission' || current === 'listening' ? 'device-unavailable' : current;
    case 'engine-unavailable':
      return current === 'requesting-permission' || current === 'starting-local-engine' || current === 'listening' || current === 'paused' ? 'engine-unavailable' : current;
  }
}
