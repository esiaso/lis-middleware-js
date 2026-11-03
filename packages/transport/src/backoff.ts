/**
 * Exponential backoff with full jitter: a random delay in [min, min(max, min·2^attempt)].
 * Jitter stops many workers reconnecting in lock-step after a network blip.
 */
export function backoffDelay(attempt: number, minMs: number, maxMs: number, random: () => number = Math.random): number {
  const ceiling = Math.min(maxMs, minMs * 2 ** Math.min(attempt, 30));
  return Math.round(minMs + (ceiling - minMs) * random());
}
