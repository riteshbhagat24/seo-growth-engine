import "dotenv/config";
import { hostname } from "node:os";
import { createDb, getPool } from "@sge/db";
import { serverEnv } from "@sge/config";
import { jobHandlers } from "@sge/core";
import { runTick } from "@sge/jobs";

/**
 * Worker entry point.
 *   pnpm --filter @sge/worker start   long-running (VPS / container)
 *   pnpm --filter @sge/worker once    one bounded batch, for cPanel cron
 */
const ONCE = process.argv.includes("--once");
const BUDGET_MS = Number(process.env.WORKER_TICK_BUDGET_MS ?? 240_000); // < 5-minute cron interval
const IDLE_SLEEP_MS = 5_000;
const WORKER_ID = `${hostname()}:${process.pid}`;

function log(message: string, meta: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), service: "worker", worker: WORKER_ID, message, ...meta }));
}

async function main() {
  const env = serverEnv();
  if (!env.WORKER_DATABASE_URL) throw new Error("WORKER_DATABASE_URL is not configured");
  const workerDb = createDb(env.WORKER_DATABASE_URL);
  const appDb = createDb(env.APP_DATABASE_URL);
  const handlers = jobHandlers();
  const tick = () =>
    runTick({
      workerDb,
      appDb,
      handlers,
      workerId: WORKER_ID,
      budgetMs: BUDGET_MS,
      maxJobMs: 50_000,
      concurrency: Number(process.env.WORKER_CONCURRENCY ?? 4),
      perOrgConcurrency: 2,
      log
    });
  log("worker started", { mode: ONCE ? "once" : "daemon", budgetMs: BUDGET_MS });

  const close = async () => {
    await getPool(env.WORKER_DATABASE_URL!).end();
    await getPool(env.APP_DATABASE_URL).end();
  };

  if (ONCE) {
    log("tick finished", { ...(await tick()) });
    await close();
    return;
  }

  let stopping = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => (stopping = true));
  while (!stopping) {
    const r = await tick();
    if (r.claimed > 0) log("tick finished", { ...r });
    else await new Promise((res) => setTimeout(res, IDLE_SLEEP_MS));
  }
  await close();
  log("worker stopped");
}

main().catch((err) => {
  console.error(JSON.stringify({ service: "worker", message: "fatal", error: String(err) }));
  process.exit(1);
});
