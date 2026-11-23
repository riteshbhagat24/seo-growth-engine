/**
 * Backlink job types on the shared @sge/jobs queue. Every handler runs under app_user + RLS in the job's
 * workspace (`tenant()`), never with cross-tenant rights.
 */
import type { Db } from "@sge/db";
import { enqueue, PermanentJobError, type JobHandler } from "@sge/jobs";
import { DeferError, isRetryable, JobTimeoutError } from "./errors";
import type { Runtime } from "./runtime";
import type { SqlTx } from "./sql";

export const BACKLINK_JOBS = {
  discover: "backlinks.discover",
  qualify: "backlinks.qualify",
  plan: "backlinks.plan",
  execute: "backlinks.execute",
  /** Browser-form submissions: only claimed by a worker that has Chromium. */
  executeBrowser: "backlinks.execute_browser",
  verify: "backlinks.verify",
  /** Daily per-website schedule: plan, weekly discovery and re-verification, follow-up reminders. */
  tick: "backlinks.tick"
} as const;
export type BacklinkJobType = (typeof BACKLINK_JOBS)[keyof typeof BACKLINK_JOBS];

export const BACKLINK_JOB_LABEL: Record<BacklinkJobType, string> = {
  [BACKLINK_JOBS.discover]: "Backlink discovery",
  [BACKLINK_JOBS.qualify]: "Backlink prospect check",
  [BACKLINK_JOBS.plan]: "Backlink campaign planning",
  [BACKLINK_JOBS.execute]: "Backlink submission",
  [BACKLINK_JOBS.executeBrowser]: "Backlink submission (browser)",
  [BACKLINK_JOBS.verify]: "Backlink verification",
  [BACKLINK_JOBS.tick]: "Backlink schedule"
};

export interface EnqueueInput {
  organizationId: string;
  websiteId?: string | null;
  campaignId?: string | null;
  jobType: BacklinkJobType;
  payload?: Record<string, unknown>;
  /** Lower runs sooner (engine convention, 0–100; default 100). */
  priority?: number;
  runAt?: Date;
  maxAttempts?: number;
  /** Globally unique; include the subject's id. Namespaced with "bl:". */
  idempotencyKey?: string;
}

/** Enqueue inside the caller's tenant transaction (RLS restricts it to that workspace). */
export async function enqueueJob(tx: SqlTx, input: EnqueueInput): Promise<{ id: string; created: boolean }> {
  return enqueue(tx.tx, {
    type: input.jobType,
    organizationId: input.organizationId,
    websiteId: input.websiteId ?? null,
    payload: { ...(input.payload ?? {}), ...(input.campaignId ? { campaign_id: input.campaignId } : {}) },
    runAt: input.runAt,
    // @sge/jobs runs higher priorities first.
    priority: 100 - Math.max(0, Math.min(100, input.priority ?? 100)),
    maxAttempts: input.maxAttempts ?? 5,
    idempotencyKey: input.idempotencyKey ? `bl:${input.idempotencyKey}` : undefined
  });
}

/** Queued jobs of a campaign are cancelled when it is paused (running ones re-check the campaign). */
export async function cancelCampaignJobs(tx: SqlTx, campaignId: string): Promise<number> {
  return tx.exec(
    `update jobs set status = 'cancelled', finished_at = now(), updated_at = now()
      where payload ->> 'campaign_id' = $1 and status = 'queued' and type like 'backlinks.%'`,
    [campaignId]
  );
}

export interface EngineJob {
  id: string;
  organization_id: string;
  website_id: string | null;
  payload: Record<string, any>;
  attempts: number;
  max_attempts: number;
}

export interface EngineJobContext {
  job: EngineJob;
  workerId: string;
  /** Aborted when the job's time slice ends. */
  signal: AbortSignal;
  db: Db;
  rt: Runtime;
  log(level: "debug" | "info" | "warn" | "error", message: string, data?: unknown): Promise<void>;
}

export type EngineHandler = (ctx: EngineJobContext) => Promise<unknown>;

/**
 * Adapts an engine handler to @sge/jobs:
 *  - DeferError → `{ continue }` (runs again later without using up an attempt);
 *  - non-retryable errors → PermanentJobError (fails at once);
 *  - the time slice ends → the signal aborts, then the attempt fails as retryable.
 */
export function engineHandler(fn: EngineHandler, rt: Runtime, workerId = "worker"): JobHandler {
  return async ({ job, appDb, deadline }) => {
    if (!job.organizationId) throw new PermanentJobError("Backlink jobs always belong to a workspace");
    const notes: { level: string; message: string }[] = [];
    const controller = new AbortController();
    const sliceMs = Math.max(1_000, deadline - Date.now());
    const ctx: EngineJobContext = {
      job: {
        id: job.id,
        organization_id: job.organizationId,
        website_id: job.websiteId,
        payload: job.payload ?? {},
        attempts: job.attempts,
        max_attempts: job.maxAttempts
      },
      workerId,
      signal: controller.signal,
      db: appDb,
      rt,
      log: async (level, message) => {
        if (notes.length < 20) notes.push({ level, message: message.slice(0, 300) });
      }
    };
    const timers: NodeJS.Timeout[] = [];
    try {
      const result = await Promise.race([
        fn(ctx),
        new Promise<never>((_, reject) => {
          timers.push(setTimeout(() => controller.abort(), sliceMs));
          timers.push(setTimeout(() => reject(new JobTimeoutError(Math.round(sliceMs / 1000))), sliceMs + 2_000));
        })
      ]);
      return { done: true, progress: { result: compact(result), notes } };
    } catch (e) {
      if (e instanceof DeferError) return { continue: true, delayMs: e.seconds * 1000, progress: { deferred: e.message, notes } };
      const message = e instanceof Error ? e.message : String(e);
      if (!isRetryable(e)) throw new PermanentJobError(message);
      throw e instanceof Error ? e : new Error(message);
    } finally {
      for (const t of timers) clearTimeout(t);
    }
  };
}

/** Job progress is shown on the Jobs page; keep it small. */
function compact(v: unknown): unknown {
  try {
    const s = JSON.stringify(v ?? null);
    return s.length <= 2000 ? JSON.parse(s) : { summary: s.slice(0, 2000) };
  } catch {
    return null;
  }
}

/** Seconds until the next UTC midnight (+5 s). */
export function secondsToUtcMidnight(now = new Date()): number {
  return Math.ceil((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now.getTime()) / 1000) + 5;
}

/** Seconds until the first day of next month (UTC) — when monthly plan allowances reset. */
export function secondsToNextMonth(now = new Date()): number {
  return Math.ceil((Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) - now.getTime()) / 1000) + 60;
}

export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)}`;
}
