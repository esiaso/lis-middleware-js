import { reapInbox, type Db } from '@lis/db';
import { runIntakeBatch, type IntakeOutcome } from './process.js';

export interface LoopOptions {
  db: Db;
  worker: string;
  signal: AbortSignal;
  idleDelayMs?: number;
  reapEveryMs?: number;
  onOutcome?: (o: IntakeOutcome) => void;
  onError?: (e: Error) => void;
}

/** Jobs worker main loop: drain the analyzer inbox, sleep when empty, reap expired leases. */
export async function runIntakeLoop(o: LoopOptions): Promise<void> {
  const idle = o.idleDelayMs ?? 1000;
  const reapEvery = o.reapEveryMs ?? 30_000;
  let lastReap = 0;
  while (!o.signal.aborted) {
    try {
      if (Date.now() - lastReap >= reapEvery) {
        await reapInbox(o.db);
        lastReap = Date.now();
      }
      const outcomes = await runIntakeBatch(o.db, o.worker);
      outcomes.forEach((x) => o.onOutcome?.(x));
      if (outcomes.length > 0) continue;
    } catch (e) {
      // Database restart or network blip: log, wait, carry on.
      o.onError?.(e as Error);
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, idle);
      o.signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
    });
  }
}
