import type { Db } from "@sge/db";
import type { Job } from "@sge/db/schema";
import { claimJobs, completeJob, continueJob, failJob, heartbeat, processSchedules, recoverExpired } from "./queue";

export interface JobContext {
  job: Job;
  /** app_user connection: open tenant transactions with withContext(job.organizationId). */
  appDb: Db;
  /** Epoch ms by which the handler must return (finish or ask to continue). */
  deadline: number;
  /** Extends the lease; false => the job was cancelled, stop now. */
  heartbeat: () => Promise<boolean>;
}

export type JobOutcome =
  | { done: true; progress?: Record<string, unknown> }
  | { continue: true; progress?: Record<string, unknown>; delayMs?: number }
  | { cancelled: true };

export type JobHandler = (ctx: JobContext) => Promise<JobOutcome>;

/** Throw this for failures that retrying can't fix. */
export class PermanentJobError extends Error {
  readonly permanent = true;
}

export interface TickOptions {
  workerDb: Db;
  appDb: Db;
  handlers: Record<string, JobHandler>;
  workerId: string;
  /** Total wall-clock budget for this tick. */
  budgetMs: number;
  /** Max time one handler call may take (it should chunk its work to fit). */
  maxJobMs?: number;
  concurrency?: number;
  perOrgConcurrency?: number;
  organizationId?: string;
  /** Only claim these job types (e.g. a web tick leaves browser jobs to the worker). Default: any. */
  types?: string[];
  runSchedules?: boolean;
  now?: () => number;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface TickResult {
  claimed: number;
  succeeded: number;
  continued: number;
  retried: number;
  failed: number;
  cancelled: number;
  recovered: number;
  scheduled: number;
}

/**
 * Processes jobs until none are due or the budget is spent. Safe to run from
 * many places at once (cron, `after()`, a long-running worker).
 */
export async function runTick(o: TickOptions): Promise<TickResult> {
  const now = o.now ?? Date.now;
  const end = now() + o.budgetMs;
  const maxJobMs = Math.min(o.maxJobMs ?? 25_000, o.budgetMs);
  const leaseSeconds = Math.ceil(maxJobMs / 1000) + 30;
  const log = o.log ?? (() => undefined);
  const res: TickResult = { claimed: 0, succeeded: 0, continued: 0, retried: 0, failed: 0, cancelled: 0, recovered: 0, scheduled: 0 };

  res.recovered = await recoverExpired(o.workerDb);
  if (o.runSchedules !== false && !o.organizationId) res.scheduled = await processSchedules(o.workerDb);

  // Leave room to record results: don't start a job that can't get a fair slice.
  while (end - now() > Math.min(5_000, maxJobMs / 2)) {
    const batch = await claimJobs(o.workerDb, {
      workerId: o.workerId,
      limit: o.concurrency ?? 2,
      leaseSeconds,
      perOrgConcurrency: o.perOrgConcurrency,
      organizationId: o.organizationId,
      types: o.types
    });
    if (batch.length === 0) break;
    res.claimed += batch.length;
    await Promise.all(batch.map((job) => runOne(job)));
  }
  return res;

  async function runOne(job: Job): Promise<void> {
    const handler = o.handlers[job.type];
    if (!handler) {
      await failJob(o.workerDb, job, o.workerId, `No handler for job type "${job.type}"`, { permanent: true });
      res.failed++;
      return;
    }
    const deadline = Math.min(end - 2_000, now() + maxJobMs);
    try {
      const out = await handler({
        job,
        appDb: o.appDb,
        deadline,
        heartbeat: () => heartbeat(o.workerDb, job, o.workerId, leaseSeconds)
      });
      if ("cancelled" in out) {
        res.cancelled++;
      } else if ("continue" in out) {
        if (await continueJob(o.workerDb, job, o.workerId, out.progress, out.delayMs)) res.continued++;
        else res.cancelled++;
      } else {
        if (await completeJob(o.workerDb, job, o.workerId, out.progress)) res.succeeded++;
        else res.cancelled++;
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const outcome = await failJob(o.workerDb, job, o.workerId, message, { permanent: e instanceof PermanentJobError });
      if (outcome === "failed") res.failed++;
      else if (outcome === "retry") res.retried++;
      log("job error", { jobId: job.id, type: job.type, outcome, error: message });
    }
  }
}
