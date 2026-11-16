import "dotenv/config";
import { sql } from "drizzle-orm";
import { createDb, getPool } from "@sge/db";
import { serverEnv } from "@sge/config";
import { runTick } from "./runner";

/**
 * Worker entry point.
 *   pnpm --filter @sge/worker start   long-running (VPS / container)
 *   pnpm --filter @sge/worker once    one bounded batch, for cPanel cron
 *
 * M0 has no queues yet: the handler only proves database connectivity.
 * M3 replaces it with pg-boss consumers.
 */
const ONCE = process.argv.includes("--once");
const BUDGET_MS = Number(process.env.WORKER_TICK_BUDGET_MS ?? 240_000); // < 5-min cron interval
const IDLE_SLEEP_MS = 5_000;

async function main() {
  const env = serverEnv();
  const db = createDb(env.APP_DATABASE_URL);
  await db.execute(sql`select 1`);
  log("worker started", { mode: ONCE ? "once" : "daemon" });

  const handler = async () => false; // no queues until M3

  if (ONCE) {
    const result = await runTick(handler, BUDGET_MS);
    log("tick finished", { ...result });
    await getPool(env.APP_DATABASE_URL).end();
    return;
  }

  let stopping = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => (stopping = true));
  while (!stopping) {
    const result = await runTick(handler, BUDGET_MS);
    if (result.stoppedBecause === "idle") await new Promise((r) => setTimeout(r, IDLE_SLEEP_MS));
  }
  await getPool(env.APP_DATABASE_URL).end();
  log("worker stopped");
}

function log(message: string, meta: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), service: "worker", message, ...meta }));
}

main().catch((err) => {
  console.error(JSON.stringify({ service: "worker", message: "fatal", error: String(err) }));
  process.exit(1);
});
