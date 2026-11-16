export interface TickResult {
  processed: number;
  stoppedBecause: "idle" | "time_budget";
}

export type Handler = () => Promise<boolean>; // true = did work, false = queue empty

/**
 * Processes work until the queue is empty or the time budget is spent.
 * The same loop serves the long-running worker and the cPanel cron "--once" mode,
 * so a cron run can never overlap the next one if the budget < cron interval.
 */
export async function runTick(handler: Handler, budgetMs: number, now: () => number = Date.now): Promise<TickResult> {
  const deadline = now() + budgetMs;
  let processed = 0;
  while (now() < deadline) {
    const didWork = await handler();
    if (!didWork) return { processed, stoppedBecause: "idle" };
    processed++;
  }
  return { processed, stoppedBecause: "time_budget" };
}
