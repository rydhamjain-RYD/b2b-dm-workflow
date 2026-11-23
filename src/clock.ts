// Injectable clock so tests can fast-forward time (hold expiry etc.).
let offsetMs = 0;

export function now(): number {
  return Date.now() + offsetMs;
}

export function advanceClock(ms: number): void {
  offsetMs += ms;
}

export function resetClock(): void {
  offsetMs = 0;
}
