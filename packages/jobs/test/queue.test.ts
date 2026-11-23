import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import { uuidv7 } from "uuidv7";
import { createDb, eq, getPool, schema, sql, withContext } from "@sge/db";
import {
  cancelJob,
  claimJobs,
  enqueue,
  heartbeat,
  PermanentJobError,
  processSchedules,
  recoverExpired,
  requeueJob,
  runTick,
  type JobHandler
} from "../src/index";

const appDb = createDb(process.env.TEST_DATABASE_URL!);
const workerDb = createDb(process.env.TEST_WORKER_DATABASE_URL!);
const owner = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL_OWNER, max: 1 });

afterAll(async () => {
  await owner.end();
  await getPool(process.env.TEST_DATABASE_URL!).end();
  await getPool(process.env.TEST_WORKER_DATABASE_URL!).end();
});

async function makeOrg(): Promise<string> {
  const id = uuidv7();
  await withContext(appDb, { organizationId: id }, (tx) =>
    tx.insert(schema.organizations).values({ id, slug: `org-${id.slice(-12)}`, name: "Org", type: "agency" })
  );
  return id;
}

const add = (org: string, type = "test.noop", extra: Partial<Parameters<typeof enqueue>[1]> = {}) =>
  withContext(appDb, { organizationId: org }, (tx) => enqueue(tx, { type, organizationId: org, ...extra }));

const jobRow = (id: string) =>
  workerDb.select().from(schema.jobs).where(eq(schema.jobs.id, id)).then((r) => r[0]!);

/** Isolate each test's claims to its own job types. */
const t = (name: string) => `${name}.${uuidv7().slice(-8)}`;

describe("enqueue and isolation", () => {
  it("is idempotent by key", async () => {
    const org = await makeOrg();
    const a = await add(org, "test.idem", { idempotencyKey: `k-${org}` });
    const b = await add(org, "test.idem", { idempotencyKey: `k-${org}` });
    expect(a.created).toBe(true);
    expect(b).toEqual({ id: a.id, created: false });
  });

  it("tenants see only their own jobs; the worker sees all but no tenant tables", async () => {
    const [a, b] = [await makeOrg(), await makeOrg()];
    const ja = await add(a);
    const fromB = await withContext(appDb, { organizationId: b }, (tx) =>
      tx.select().from(schema.jobs).where(eq(schema.jobs.id, ja.id))
    );
    expect(fromB).toEqual([]);
    expect((await jobRow(ja.id)).organizationId).toBe(a);

    // Tenants can't enqueue into another tenant.
    await expect(withContext(appDb, { organizationId: b }, (tx) => enqueue(tx, { type: "x", organizationId: a }))).rejects.toThrow();
    // The worker role can't read tenant data.
    await expect(workerDb.execute(sql`select * from organizations`)).rejects.toThrow();
    await expect(workerDb.execute(sql`select * from websites`)).rejects.toThrow();
    await expect(workerDb.execute(sql`select * from auth.users`)).rejects.toThrow();
  });
});

describe("claiming", () => {
  it("is fair across organisations and respects per-org concurrency", async () => {
    const [big, small] = [await makeOrg(), await makeOrg()];
    const type = t("fair");
    for (let i = 0; i < 10; i++) await add(big, type);
    const s = await add(small, type);
    const claimed = await claimJobs(workerDb, { workerId: "w1", limit: 3, leaseSeconds: 60, perOrgConcurrency: 2, types: [type] });
    expect(claimed.map((j) => j.id)).toContain(s.id);
    expect(claimed.filter((j) => j.organizationId === big)).toHaveLength(2);
    // big is at its cap of 2 running: nothing more from it.
    const more = await claimJobs(workerDb, { workerId: "w1", limit: 5, leaseSeconds: 60, perOrgConcurrency: 2, types: [type] });
    expect(more).toEqual([]);
  });

  it("never hands the same job to two workers", async () => {
    const org = await makeOrg();
    const type = t("race");
    for (let i = 0; i < 30; i++) await add(org, type);
    // Racing claimers skip each other's locked rows, so a round may claim fewer
    // than requested; keep going until the queue is empty.
    const ids: string[] = [];
    for (let round = 0; round < 10; round++) {
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) => claimJobs(workerDb, { workerId: `w${i}`, limit: 10, leaseSeconds: 60, perOrgConcurrency: 100, types: [type] }))
      );
      const got = results.flat().map((j) => j.id);
      if (got.length === 0) break;
      ids.push(...got);
    }
    expect(new Set(ids).size).toBe(ids.length); // never claimed twice
    expect(ids.length).toBe(30); // and nothing left behind
  });

  it("can be limited to one organisation", async () => {
    const [a, b] = [await makeOrg(), await makeOrg()];
    const type = t("scoped");
    await add(a, type);
    const jb = await add(b, type);
    const claimed = await claimJobs(workerDb, { workerId: "w", limit: 5, leaseSeconds: 60, organizationId: b, types: [type] });
    expect(claimed.map((j) => j.id)).toEqual([jb.id]);
  });
});

describe("runTick", () => {
  const tick = (handlers: Record<string, JobHandler>, org: string, budgetMs = 10_000) =>
    runTick({ workerDb, appDb, handlers, workerId: "tick", budgetMs, maxJobMs: 5_000, organizationId: org });

  it("completes, continues and resumes with progress", async () => {
    const org = await makeOrg();
    const type = t("chunked");
    const j = await add(org, type);
    const seen: unknown[] = [];
    const handler: JobHandler = async ({ job }) => {
      const step = Number(job.progress?.step ?? 0);
      seen.push(step);
      return step < 2 ? { continue: true, progress: { step: step + 1 } } : { done: true, progress: { step: "done" } };
    };
    const r = await tick({ [type]: handler }, org);
    expect(seen).toEqual([0, 1, 2]);
    expect(r).toMatchObject({ succeeded: 1, continued: 2 });
    expect(await jobRow(j.id)).toMatchObject({ status: "succeeded", progress: { step: "done" }, attempts: 1 });
  });

  it("retries with backoff, then fails; permanent errors fail at once; unknown types fail", async () => {
    const org = await makeOrg();
    const [flaky, fatal, unknown] = [t("flaky"), t("fatal"), t("unknown")];
    const jf = await add(org, flaky, { maxAttempts: 2 });
    const jp = await add(org, fatal);
    const ju = await add(org, unknown);
    const handlers: Record<string, JobHandler> = {
      [flaky]: async () => {
        throw new Error("boom");
      },
      [fatal]: async () => {
        throw new PermanentJobError("bad input");
      }
    };
    await tick(handlers, org);
    const f1 = await jobRow(jf.id);
    expect(f1).toMatchObject({ status: "queued", attempts: 1, lastError: "boom" });
    expect(f1.runAt.getTime()).toBeGreaterThan(Date.now() + 20_000); // backoff
    expect(await jobRow(jp.id)).toMatchObject({ status: "failed", lastError: "bad input" });
    expect(await jobRow(ju.id)).toMatchObject({ status: "failed", lastError: expect.stringMatching(/No handler/) });

    await workerDb.update(schema.jobs).set({ runAt: new Date(Date.now() - 1000) }).where(eq(schema.jobs.id, jf.id));
    await tick(handlers, org);
    expect(await jobRow(jf.id)).toMatchObject({ status: "failed", attempts: 2 });
  });

  it("stops within its time budget", async () => {
    const org = await makeOrg();
    const type = t("slow");
    for (let i = 0; i < 20; i++) await add(org, type);
    const started = Date.now();
    await runTick({
      workerDb,
      appDb,
      workerId: "budget",
      budgetMs: 1_500,
      maxJobMs: 400,
      organizationId: org,
      handlers: { [type]: async () => (await new Promise((r) => setTimeout(r, 300)), { done: true }) }
    });
    expect(Date.now() - started).toBeLessThan(2_500);
    const left = await workerDb.select().from(schema.jobs).where(sql`type = ${type} and status = 'queued'`);
    expect(left.length).toBeGreaterThan(0);
  });
});

describe("leases, cancellation and schedules", () => {
  it("recovers jobs whose worker died", async () => {
    const org = await makeOrg();
    const type = t("lease");
    const a = await add(org, type);
    const b = await add(org, type, { maxAttempts: 1 });
    await claimJobs(workerDb, { workerId: "dead", limit: 2, leaseSeconds: 60, perOrgConcurrency: 5, types: [type] });
    await workerDb.update(schema.jobs).set({ lockedUntil: new Date(Date.now() - 1000) }).where(sql`type = ${type}`);
    expect(await recoverExpired(workerDb)).toBeGreaterThanOrEqual(2);
    expect(await jobRow(a.id)).toMatchObject({ status: "queued", lockedBy: null });
    expect(await jobRow(b.id)).toMatchObject({ status: "failed" });
  });

  it("a tenant can cancel; the worker loses the job and can't overwrite the status", async () => {
    const org = await makeOrg();
    const type = t("cancel");
    const j = await add(org, type);
    const [claimed] = await claimJobs(workerDb, { workerId: "w", limit: 1, leaseSeconds: 60, types: [type] });
    expect(await withContext(appDb, { organizationId: org }, (tx) => cancelJob(tx, j.id))).toBe(true);
    expect(await heartbeat(workerDb, claimed!, "w", 60)).toBe(false);
    expect(await jobRow(j.id)).toMatchObject({ status: "cancelled" });
  });

  it("enqueues each schedule slot exactly once and advances it", async () => {
    const org = await makeOrg();
    const type = t("sched");
    const [s] = await withContext(appDb, { organizationId: org }, (tx) =>
      tx
        .insert(schema.schedules)
        .values({ organizationId: org, jobType: type, intervalMinutes: 60, nextRunAt: new Date(Date.now() - 60_000) })
        .returning()
    );
    await Promise.all([processSchedules(workerDb), processSchedules(workerDb)]);
    const queued = await workerDb.select().from(schema.jobs).where(eq(schema.jobs.type, type));
    expect(queued).toHaveLength(1);
    const [after] = await workerDb.select().from(schema.schedules).where(eq(schema.schedules.id, s!.id));
    expect(after!.nextRunAt.getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
  });
});

describe("type filters and tenant requeue", () => {
  it("a tick limited to some types leaves the others queued (not failed)", async () => {
    const org = await makeOrg();
    const [mine, other] = [t("web"), t("browser")];
    const a = await add(org, mine);
    const b = await add(org, other);
    await runTick({ workerDb, appDb, handlers: { [mine]: async () => ({ done: true }) }, workerId: "typed", budgetMs: 10_000, maxJobMs: 5_000, organizationId: org, types: [mine] });
    expect((await jobRow(a.id)).status).toBe("succeeded");
    expect((await jobRow(b.id)).status).toBe("queued");
  });

  it("a workspace can requeue its own failed job, never another workspace's", async () => {
    const [a, b] = [await makeOrg(), await makeOrg()];
    const type = t("requeue");
    const j = await add(a, type, { maxAttempts: 1 });
    await runTick({ workerDb, appDb, handlers: { [type]: async () => { throw new PermanentJobError("nope"); } }, workerId: "rq", budgetMs: 10_000, maxJobMs: 5_000, organizationId: a });
    expect((await jobRow(j.id)).status).toBe("failed");
    expect(await withContext(appDb, { organizationId: b }, (tx) => requeueJob(tx, j.id))).toBe(false);
    expect((await jobRow(j.id)).status).toBe("failed");
    expect(await withContext(appDb, { organizationId: a }, (tx) => requeueJob(tx, j.id))).toBe(true);
    expect(await jobRow(j.id)).toMatchObject({ status: "queued", attempts: 0, lastError: null });
    expect(await withContext(appDb, { organizationId: a }, (tx) => requeueJob(tx, j.id))).toBe(false); // only failed/cancelled
  });
});
