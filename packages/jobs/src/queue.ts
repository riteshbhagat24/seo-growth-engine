import { and, eq, schema, sql, type Db, type Tx } from "@sge/db";
import type { Job } from "@sge/db/schema";

const { jobs } = schema;

export interface EnqueueInput {
  type: string;
  organizationId: string | null;
  websiteId?: string | null;
  payload?: Record<string, unknown>;
  runAt?: Date;
  priority?: number;
  maxAttempts?: number;
  /** Same key twice → one job (the existing one is returned). */
  idempotencyKey?: string;
  createdByUserId?: string | null;
}

/**
 * Enqueue inside the caller's transaction: tenant code passes an app_user tx
 * (RLS restricts it to its own organisation), the scheduler a worker tx.
 */
export async function enqueue(tx: Tx, input: EnqueueInput): Promise<{ id: string; created: boolean }> {
  const [row] = await tx
    .insert(jobs)
    .values({
      type: input.type,
      organizationId: input.organizationId,
      websiteId: input.websiteId ?? null,
      payload: input.payload ?? {},
      runAt: input.runAt ?? new Date(),
      priority: input.priority ?? 0,
      maxAttempts: input.maxAttempts ?? 5,
      idempotencyKey: input.idempotencyKey ?? null,
      createdByUserId: input.createdByUserId ?? null
    })
    .onConflictDoNothing({ target: jobs.idempotencyKey })
    .returning({ id: jobs.id });
  if (row) return { id: row.id, created: true };
  const [existing] = await tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.idempotencyKey, input.idempotencyKey!));
  if (!existing) throw new Error("enqueue: idempotency conflict with an invisible job");
  return { id: existing.id, created: false };
}

export interface ClaimOptions {
  workerId: string;
  limit: number;
  leaseSeconds: number;
  /** Max simultaneously running jobs per organisation (fairness). */
  perOrgConcurrency?: number;
  /** Only claim this organisation's jobs (member-triggered processing). */
  organizationId?: string;
  types?: string[];
}

/**
 * Claims due jobs fairly across organisations: candidates are ranked within
 * each organisation and interleaved, and organisations already at their
 * concurrency cap are skipped. FOR UPDATE SKIP LOCKED makes concurrent
 * claimers safe (a job is never claimed twice).
 */
export async function claimJobs(workerDb: Db, o: ClaimOptions): Promise<Job[]> {
  const perOrg = o.perOrgConcurrency ?? 2;
  const orgFilter = o.organizationId ? sql`and j.organization_id = ${o.organizationId}::uuid` : sql``;
  // Drizzle expands JS arrays into parameter lists; pass one string instead (types never contain commas).
  const typeFilter = o.types?.length ? sql`and j.type = any(string_to_array(${o.types.join(",")}::text, ','))` : sql``;
  const r = await workerDb.execute(sql`
    with running as (
      select organization_id, count(*)::int as n from jobs where status = 'running' group by organization_id
    ), candidates as (
      select j.id,
             row_number() over (partition by j.organization_id order by j.priority desc, j.run_at, j.created_at) as rn,
             coalesce(r.n, 0) as running
      from jobs j left join running r on r.organization_id is not distinct from j.organization_id
      where j.status = 'queued' and j.run_at <= now() ${orgFilter} ${typeFilter}
    ), eligible as (
      select id from candidates where rn + running <= ${perOrg}::int order by rn, random() limit ${o.limit}::int
    )
    update jobs set status = 'running', locked_by = ${o.workerId}, attempts = attempts + 1,
           locked_until = now() + make_interval(secs => ${o.leaseSeconds}::int),
           started_at = coalesce(started_at, now()), updated_at = now()
    where id in (select id from jobs where id in (select id from eligible) and status = 'queued' for update skip locked)
    returning *`);
  return r.rows.map(toJob);
}

/** Raw rows come back snake_case; map to the Drizzle shape. */
function toJob(r: Record<string, unknown>): Job {
  const d = (v: unknown) => (v == null ? null : new Date(v as string));
  return {
    id: r.id as string,
    organizationId: (r.organization_id as string) ?? null,
    websiteId: (r.website_id as string) ?? null,
    type: r.type as string,
    payload: (r.payload as Record<string, unknown>) ?? {},
    status: r.status as Job["status"],
    priority: r.priority as number,
    runAt: d(r.run_at)!,
    attempts: r.attempts as number,
    maxAttempts: r.max_attempts as number,
    lockedBy: (r.locked_by as string) ?? null,
    lockedUntil: d(r.locked_until),
    idempotencyKey: (r.idempotency_key as string) ?? null,
    progress: (r.progress as Record<string, unknown>) ?? null,
    lastError: (r.last_error as string) ?? null,
    createdByUserId: (r.created_by_user_id as string) ?? null,
    startedAt: d(r.started_at),
    finishedAt: d(r.finished_at),
    createdAt: d(r.created_at)!,
    updatedAt: d(r.updated_at)!
  };
}

const owned = (job: Job, workerId: string) =>
  and(eq(jobs.id, job.id), eq(jobs.status, "running"), eq(jobs.lockedBy, workerId));

/** Extends the lease. false => the job was cancelled or lost (stop working on it). */
export async function heartbeat(workerDb: Db, job: Job, workerId: string, leaseSeconds: number): Promise<boolean> {
  const r = await workerDb
    .update(jobs)
    .set({ lockedUntil: sql`now() + make_interval(secs => ${leaseSeconds}::int)`, updatedAt: new Date() })
    .where(owned(job, workerId))
    .returning({ id: jobs.id });
  return r.length === 1;
}

export async function completeJob(workerDb: Db, job: Job, workerId: string, progress?: Record<string, unknown>): Promise<boolean> {
  const r = await workerDb
    .update(jobs)
    .set({ status: "succeeded", finishedAt: new Date(), lockedBy: null, lockedUntil: null, lastError: null, ...(progress ? { progress } : {}) })
    .where(owned(job, workerId))
    .returning({ id: jobs.id });
  return r.length === 1;
}

/**
 * Re-queue a long job to continue later (chunked work). Not a failure: the
 * attempt counter is reset so long jobs don't exhaust their retries.
 */
export async function continueJob(
  workerDb: Db,
  job: Job,
  workerId: string,
  progress: Record<string, unknown> | undefined,
  delayMs = 0
): Promise<boolean> {
  const r = await workerDb
    .update(jobs)
    .set({
      status: "queued",
      attempts: 0,
      lockedBy: null,
      lockedUntil: null,
      runAt: sql`now() + make_interval(secs => ${Math.ceil(delayMs / 1000)}::int)`,
      ...(progress ? { progress } : {})
    })
    .where(owned(job, workerId))
    .returning({ id: jobs.id });
  return r.length === 1;
}

/** Exponential backoff: 30 s, 1 min, 2 min, 4 min … capped at 1 h. */
export const backoffSeconds = (attempts: number) => Math.min(3600, 30 * 2 ** Math.max(0, attempts - 1));

export async function failJob(workerDb: Db, job: Job, workerId: string, error: string, opts: { permanent?: boolean } = {}): Promise<"retry" | "failed" | "lost"> {
  const final = opts.permanent || job.attempts >= job.maxAttempts;
  const r = await workerDb
    .update(jobs)
    .set(
      final
        ? { status: "failed", finishedAt: new Date(), lockedBy: null, lockedUntil: null, lastError: error.slice(0, 1000) }
        : {
            status: "queued",
            lockedBy: null,
            lockedUntil: null,
            lastError: error.slice(0, 1000),
            runAt: sql`now() + make_interval(secs => ${backoffSeconds(job.attempts)}::int)`
          }
    )
    .where(owned(job, workerId))
    .returning({ id: jobs.id });
  if (r.length === 0) return "lost";
  return final ? "failed" : "retry";
}

/** Jobs whose worker died: retry if attempts remain, else fail. */
export async function recoverExpired(workerDb: Db): Promise<number> {
  const r = await workerDb.execute(sql`
    update jobs set
      status = case when attempts >= max_attempts then 'failed'::job_status else 'queued'::job_status end,
      finished_at = case when attempts >= max_attempts then now() else null end,
      last_error = 'Worker stopped before finishing (lease expired)',
      locked_by = null, locked_until = null, updated_at = now()
    where status = 'running' and locked_until < now()
    returning id`);
  return r.rows.length;
}

/** Tenant-side cancel (app_user tx in tenant context). Running jobs stop at their next heartbeat. */
export async function cancelJob(tx: Tx, jobId: string): Promise<boolean> {
  const r = await tx
    .update(jobs)
    .set({ status: "cancelled", finishedAt: new Date(), lockedBy: null, lockedUntil: null })
    .where(and(eq(jobs.id, jobId), sql`${jobs.status} in ('queued', 'running')`))
    .returning({ id: jobs.id });
  return r.length === 1;
}

/**
 * Tenant-side retry of a failed or cancelled job (app_user tx in tenant context; RLS limits it to the
 * workspace's own jobs). Handlers must re-check their own state: a requeue never forces work to repeat.
 */
export async function requeueJob(tx: Tx, jobId: string): Promise<boolean> {
  const r = await tx
    .update(jobs)
    .set({ status: "queued", attempts: 0, runAt: new Date(), lastError: null, finishedAt: null, lockedBy: null, lockedUntil: null })
    .where(and(eq(jobs.id, jobId), sql`${jobs.status} in ('failed', 'cancelled')`))
    .returning({ id: jobs.id });
  return r.length === 1;
}

/** Enqueues every due schedule exactly once per slot, then advances it. */
export async function processSchedules(workerDb: Db, limit = 100): Promise<number> {
  const r = await workerDb.execute(sql`
    with due as (
      select * from schedules where enabled and next_run_at <= now()
      order by next_run_at limit ${limit}::int for update skip locked
    ), enq as (
      insert into jobs (id, organization_id, website_id, type, payload, idempotency_key)
      select gen_random_uuid(), d.organization_id, d.website_id, d.job_type, d.payload,
             'schedule:' || d.id || ':' || extract(epoch from d.next_run_at)::bigint
      from due d
      on conflict (idempotency_key) do nothing
      returning id
    )
    update schedules s set
      last_run_at = now(),
      next_run_at = greatest(s.next_run_at + make_interval(mins => s.interval_minutes), now()),
      updated_at = now()
    from due where s.id = due.id
    returning s.id`);
  return r.rows.length;
}
