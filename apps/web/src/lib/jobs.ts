import "server-only";
import { after } from "next/server";
import { createDb } from "@sge/db";
import { jobHandlers } from "@sge/core";
import { runTick } from "@sge/jobs";
import { serverEnv } from "@sge/config";
import { db } from "./db";

/** Max seconds a serverless invocation may run (set per route via maxDuration). */
export const PROCESSING_SECONDS = 60;
const BUDGET_MS = (PROCESSING_SECONDS - 15) * 1000;

export const jobsEnabled = () => Boolean(serverEnv().WORKER_DATABASE_URL);

function workerDb() {
  const url = serverEnv().WORKER_DATABASE_URL;
  if (!url) throw new Error("WORKER_DATABASE_URL is not configured");
  return createDb(url);
}

export function processJobs(opts: { organizationId?: string; budgetMs?: number } = {}) {
  return runTick({
    workerDb: workerDb(),
    appDb: db(),
    handlers: jobHandlers({ psiApiKey: serverEnv().PSI_API_KEY }),
    workerId: `web:${process.pid}:${Math.random().toString(36).slice(2, 8)}`,
    budgetMs: opts.budgetMs ?? BUDGET_MS,
    maxJobMs: Math.min(40_000, (opts.budgetMs ?? BUDGET_MS) - 3_000),
    concurrency: 2,
    perOrgConcurrency: 2,
    organizationId: opts.organizationId,
    log: (message, meta) => console.log(JSON.stringify({ service: "web-jobs", message, ...meta }))
  });
}

/**
 * Processes this workspace's due jobs after the response is sent. Lets a
 * serverless deployment (Vercel) make progress without a separate worker;
 * a real worker or the cron endpoint does the same work if present. Safe to
 * call often: concurrent ticks never claim the same job.
 */
export function processAfterResponse(organizationId: string) {
  if (!jobsEnabled()) return;
  after(async () => {
    try {
      await processJobs({ organizationId });
    } catch (err) {
      console.error("[jobs] background processing failed:", (err as Error).message);
    }
  });
}
