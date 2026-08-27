export type InputStartGate = { nextAttempt: number; pendingAttempt: number | null };

export type StoppableInput = { stop(): Promise<void> };

export function createInputStartGate(): InputStartGate {
  return { nextAttempt: 1, pendingAttempt: null };
}

export function beginInputStart(gate: InputStartGate): number | null {
  if (gate.pendingAttempt !== null) return null;
  const attempt = gate.nextAttempt;
  gate.nextAttempt += 1;
  gate.pendingAttempt = attempt;
  return attempt;
}

export function inputStartIsCurrent(gate: InputStartGate, attempt: number): boolean {
  return gate.pendingAttempt === attempt;
}

export function finishInputStart(gate: InputStartGate, attempt: number): void {
  if (gate.pendingAttempt === attempt) gate.pendingAttempt = null;
}

export function cancelInputStart(gate: InputStartGate): void {
  gate.pendingAttempt = null;
}

export async function adoptStartedInput<T extends StoppableInput>(
  gate: InputStartGate,
  attempt: number,
  input: T,
  slotAvailable: () => boolean,
  adopt: (value: T) => void,
): Promise<boolean> {
  if (!inputStartIsCurrent(gate, attempt) || !slotAvailable()) {
    await input.stop();
    return false;
  }
  adopt(input);
  return true;
}
