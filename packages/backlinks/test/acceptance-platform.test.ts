/**
 * Acceptance tests 10–12, ported: workspace and website isolation, crawler security, job retry and failure
 * handling — now on the monorepo's tenancy (RLS + client scope), @sge/crawler safeFetch and @sge/jobs queue.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { addWebsite, AppError, createClient } from "@sge/core";
import { backoffSeconds, claimJobs, recoverExpired, runTick } from "@sge/jobs";
import {
  backlinksOverview,
  BACKLINK_JOBS,
  createBacklinkCampaign,
  createRuntime,
  decideBacklinkApproval,
  engineHandler,
  enqueueJob,
  Fetcher,
  importOpportunities,
  PolicyBlockedError,
  resolveBacklinkTask,
  retryBacklinkJob,
  saveSource,
  setWebsiteAutomation,
  tenant,
  UrlPolicy
} from "../src/index";
import { startEgressProxy } from "../src/browser/egress-proxy";
import { verifyLink } from "../src/verification/verify";
import {
  closeAll,
  db,
  makeAgency,
  makeDue,
  newWebsite,
  one,
  ownerInTenant,
  q,
  registerTestDestination,
  startTestDestination,
  testRuntime,
  TestRunner,
  worker,
  workerDb,
  type Agency,
  type TestDestination
} from "./helpers";

let dest: TestDestination;
let runner: TestRunner;
let A: Agency;
let B: Agency;

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    if (e instanceof PolicyBlockedError) return e.code;
    if (e instanceof AppError) return `app:${e.code}`;
    return `unexpected:${(e as Error).message}`;
  }
}

beforeAll(async () => {
  dest = await startTestDestination();
  runner = new TestRunner(testRuntime(dest));
  A = await makeAgency("Agency A");
  B = await makeAgency("Agency B");
}, 120_000);

afterAll(async () => {
  await dest?.close();
  await closeAll();
});

describe("Platform guarantees (acceptance)", () => {
  test("TEST 10: workspace and website isolation, roles and client scope", async () => {
    const clientA = await createClient(db, A.owner, A.access, { name: "Client One" });
    const w1 = await addWebsite(db, A.owner, A.access, { url: "client-one.com", clientId: clientA.id });
    const w2 = await addWebsite(db, A.owner, A.access, { url: "agency-a.com" });
    const c1 = await createBacklinkCampaign(db, A.owner, A.access, { websiteId: w1.id, name: "C1", startDiscovery: false });
    await createBacklinkCampaign(db, A.owner, A.access, { websiteId: w2.id, name: "C2", startDiscovery: false });
    await importOpportunities(db, A.owner, A.access, c1.id, { urls: ["https://clinic-directory.com/add"] });

    // Workspace B sees none of A's rows, in any backlink table.
    const tables = [
      "websites",
      "backlink_campaigns",
      "backlink_campaign_settings",
      "backlink_opportunities",
      "backlink_prospects",
      "jobs",
      "audit_logs",
      "schedules"
    ];
    for (const t of tables) {
      const [{ n }] = await q(B.orgId, `select count(*) as n from ${t} where organization_id = $1`, [A.orgId]);
      expect(n, t).toBe(0);
    }
    // ...can't change them...
    expect(await tenant(db, B.orgId, (tx) => tx.exec(`update websites set display_name = 'hijacked' where id = $1`, [w1.id]))).toBe(0);
    expect(await tenant(db, B.orgId, (tx) => tx.exec(`delete from backlink_campaigns where id = $1`, [c1.id]))).toBe(0);
    // ...can't write rows into A...
    await expect(
      tenant(db, B.orgId, (tx) => tx.exec(`insert into backlink_exclusions (organization_id, kind, value) values ($1, 'domain', 'x.com')`, [A.orgId]))
    ).rejects.toThrow(/row-level security/);
    // ...and can't reference A's website even when RLS is out of the way (composite foreign keys).
    await expect(
      ownerInTenant(B.orgId, `insert into backlink_campaigns (organization_id, website_id, name, industry) values ($1, $2, 'x', 'other')`, [
        B.orgId,
        w1.id
      ])
    ).rejects.toThrow(/foreign key/);
    // Website-level isolation inside one workspace: a submission can't mix website 2 with website 1's campaign.
    const opp = await one(A.orgId, `select id from backlink_opportunities where campaign_id = $1 limit 1`, [c1.id]);
    await expect(
      tenant(db, A.orgId, (tx) =>
        tx.exec(
          `insert into backlink_submissions (organization_id, website_id, campaign_id, opportunity_id, adapter_key, submission_method, destination_domain, target_url)
           values ($1, $2, $3, $4, 'manual-editorial', 'manual_editorial', 'x.com', 'https://agency-a.com/')`,
          [A.orgId, w2.id, c1.id, opp.id]
        )
      )
    ).rejects.toThrow(/foreign key/);
    // A source of another workspace can't be referenced (global catalogue or own sources only).
    const [bSource] = await ownerInTenant<{ id: string }>(
      B.orgId,
      `insert into backlink_sources (organization_id, domain, name, source_type, homepage_url, adapter_key) values ($1, 'b-only.com', 'B', 'other', 'https://b-only.com/', 'manual-editorial') returning id`,
      [B.orgId]
    );
    await expect(
      tenant(db, A.orgId, (tx) => tx.exec(`update backlink_opportunities set source_id = $2 where id = $1`, [opp.id, bSource!.id]))
    ).rejects.toThrow(/not available to this workspace/);
    // The global catalogue is readable by everyone and writable by no one.
    const [{ n: catalogue }] = await q(B.orgId, `select count(*) as n from backlink_sources where organization_id is null`);
    expect(catalogue).toBeGreaterThan(100);
    expect(await tenant(db, B.orgId, (tx) => tx.exec(`update backlink_sources set name = 'x' where organization_id is null`))).toBe(0);
    // app_user with no workspace set sees nothing.
    const raw = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await raw.connect();
    expect((await raw.query("select count(*)::int as n from backlink_campaigns")).rows[0].n).toBe(0);
    await expect(raw.query("select email from auth.users")).rejects.toThrow(/permission denied/);
    await raw.end();

    // Roles: specialists prospect but can't approve or enable automation; client users see only their client.
    const specialist = await A.addMember("specialist");
    const manager = await A.addMember("manager");
    const clientUser = await A.addMember("client", [clientA.id]);
    await createBacklinkCampaign(db, specialist.actor, specialist.access, { websiteId: w2.id, name: "By specialist", startDiscovery: false });
    expect(await code(decideBacklinkApproval(db, specialist.actor, specialist.access, opp.id, "approved"))).toBe("app:forbidden");
    expect(await code(setWebsiteAutomation(db, manager.actor, manager.access, w1.id, { mode: "manual" }))).toBe("app:forbidden");
    expect((await backlinksOverview(db, clientUser.actor, clientUser.access, w1.id)).campaigns.map((c) => c.name)).toEqual(["C1"]);
    expect(await code(backlinksOverview(db, clientUser.actor, clientUser.access, w2.id))).toBe("app:not_found");
    expect(await code(createBacklinkCampaign(db, clientUser.actor, clientUser.access, { websiteId: w1.id, name: "x" }))).toBe("app:forbidden");
    // Workspace sources: recording automation permission needs an admin, a note, and never "test destination".
    const src = { name: "Partner", homepageUrl: "https://partner-dir.com/", sourceType: "industry_directory" as const, adapterKey: "http-form" };
    expect(
      await code(
        saveSource(db, specialist.actor, specialist.access, {
          ...src,
          automationPermission: "explicit_permission",
          permissionNote: "Email from partner"
        })
      )
    ).toBe("app:forbidden");
    expect(await code(saveSource(db, A.owner, A.access, { ...src, automationPermission: "explicit_permission" }))).toBe("app:invalid_input");
    expect(await code(saveSource(db, A.owner, A.access, { ...src, automationPermission: "test_destination" as never }))).toBe("app:invalid_input");
    expect(await code(saveSource(db, A.owner, A.access, { ...src, automationPermission: "own_property", permissionNote: "ours" }))).toBe(
      "app:invalid_input"
    );
    const saved = await saveSource(db, A.owner, A.access, {
      ...src,
      automationPermission: "explicit_permission",
      permissionNote: "Email from partner, 2026-11-20",
      secret: "s3cret-token-value"
    });
    const stored = await one(A.orgId, `select credentials_enc, credentials_hint, permission_evidence from backlink_sources where id = $1`, [
      saved.id
    ]);
    expect(stored.credentials_enc).toMatch(/^v1:/);
    expect(stored.credentials_enc).not.toContain("s3cret");
    expect(stored.credentials_hint).toBe("…alue");
    expect(stored.permission_evidence).toMatchObject({ basis: "Email from partner, 2026-11-20", granted_by: A.owner.userId });
    // Autopilot needs a recorded reason.
    expect(await code(setWebsiteAutomation(db, A.owner, A.access, w2.id, { mode: "autopilot", autopilotSourceIds: [saved.id] }))).toBe(
      "app:invalid_input"
    );
  });

  test("TEST 11: crawler security (SSRF, rebinding, redirects, size, schemes, robots, browser egress)", async () => {
    const policy = new UrlPolicy();
    const blocked: [string, string][] = [
      ["file:///etc/passwd", "scheme"],
      ["gopher://127.0.0.1:70/", "scheme"],
      ["ftp://example.com/", "scheme"],
      ["javascript:alert(1)", "scheme"],
      ["http://user:pass@example.com/", "credentials"],
      ["http://example.com:22/", "port"],
      ["http://localhost/", "hostname"],
      ["http://metadata.google.internal/", "hostname"],
      ["http://printer.local/", "hostname"],
      ["http://intranet/", "hostname"],
      ["http://127.0.0.1/", "private_address"],
      ["http://2130706433/", "private_address"],
      ["http://0x7f.1/", "private_address"],
      ["http://017700000001/", "private_address"],
      ["http://[::1]/", "private_address"],
      ["http://[::ffff:127.0.0.1]/", "private_address"],
      ["http://169.254.169.254/latest/meta-data/", "private_address"],
      ["http://10.0.0.1/", "private_address"],
      ["http://192.168.1.1/", "private_address"],
      ["http://172.16.0.1/", "private_address"],
      ["http://100.64.0.1/", "private_address"],
      ["http://[fd00::1]/", "private_address"],
      ["http://0.0.0.0/", "private_address"],
      ["http://[64:ff9b::7f00:1]/", "private_address"]
    ];
    for (const [url, c] of blocked) {
      let got = "ok";
      try {
        policy.assertAllowed(url);
      } catch (e) {
        got = e instanceof PolicyBlockedError ? e.code : "other";
      }
      expect(got, url).toBe(c);
    }
    const fetcher = runner.rt.fetcher;
    // A non-allow-listed port on loopback is blocked even though the test destination's port is allowed.
    expect(await code(fetcher.fetch(`http://127.0.0.1:${dest.port + 1}/`))).toBe("port");

    // DNS answers in private space (or mixing public and private records) are blocked.
    const dnsFetcher = (answers: Record<string, string[]>, calls: string[] = []) =>
      new Fetcher({
        test: {
          resolver: async (h) => {
            calls.push(h);
            return (answers[h] ?? []).map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
          }
        }
      });
    const f = dnsFetcher({
      "internal.attacker.com": ["10.1.2.3"],
      "mixed.attacker.com": ["93.184.215.14", "127.0.0.1"],
      "v6mapped.attacker.com": ["::ffff:169.254.169.254"]
    });
    for (const h of ["internal.attacker.com", "mixed.attacker.com", "v6mapped.attacker.com"])
      expect(await code(f.fetch(`http://${h}/`, { respectRobots: false }))).toBe("private_address");

    // DNS rebinding: the name is resolved once per hop and the connection pinned to the vetted (public) answer, so
    // a later private answer is never asked for, let alone used.
    let n = 0;
    const rebind = new Fetcher({
      timeoutMs: 1500,
      test: { resolver: async () => (n++ === 0 ? [{ address: "203.0.114.10", family: 4 }] : [{ address: "127.0.0.1", family: 4 }]) }
    });
    await rebind.fetch("http://rebind.attacker.com/", { respectRobots: false }).catch(() => undefined);
    expect(n).toBe(1);

    // Malicious redirects are re-validated hop by hop; loops are cut off; limits apply.
    expect(await code(fetcher.fetch(`${dest.url}/redirect-private`))).toBe("private_address");
    expect(await code(fetcher.fetch(`${dest.url}/redirect-loop`))).toBe("too_many_redirects");
    expect(await code(fetcher.fetch(`${dest.url}/big`, { maxBytes: 1024 * 1024 }))).toBe("too_large");
    expect(await code(fetcher.fetch(`${dest.url}/slow`, { timeoutMs: 1500 }))).toBe("timeout");
    expect(await code(fetcher.fetch(`${dest.url}/binary`))).toBe("content_type");
    // Decompression bombs can't inflate: responses are never decompressed (no Accept-Encoding, raw bytes kept).
    const bomb = await fetcher.fetch(`${dest.url}/gzip-bomb`, { maxBytes: 1024 * 1024 });
    expect(bomb.text.length).toBeLessThan(1024 * 1024);
    // robots.txt is respected by the crawler and the verifier.
    expect(await code(fetcher.fetch(`${dest.url}/private/page`))).toBe("robots");
    expect((await verifyLink(fetcher, `${dest.url}/private/page`, "https://x.com/")).result).toBe("blocked_by_robots");
    expect((await verifyLink(fetcher, "http://169.254.169.254/", "https://x.com/")).result).toBe("blocked_by_policy");

    // Browser worker: all traffic (loopback included) goes through the SSRF-checking egress proxy.
    const other = http.createServer((_q, s) => s.end("<h1>internal admin panel</h1>"));
    await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
    const otherPort = (other.address() as AddressInfo).port;
    const proxy = await startEgressProxy(fetcher.policy);
    const browser = await chromium.launch({ headless: true, proxy: { server: proxy.url, bypass: "<-loopback>" } });
    try {
      const page = await browser.newPage();
      const viaInternal = await page.goto(`http://127.0.0.1:${otherPort}/`).catch((e: Error) => e);
      expect(viaInternal instanceof Error ? "" : await page.content()).not.toContain("internal admin panel");
      const meta = await page.goto("http://169.254.169.254/latest/meta-data/").catch((e: Error) => e);
      expect(meta instanceof Error || meta?.status() === 403).toBe(true);
      expect((await page.goto(`${dest.url}/`))?.status()).toBe(200);
      const targets = proxy.blocked.map((b) => b.target).join(" ");
      expect(targets).toMatch(new RegExp(`127\\.0\\.0\\.1:${otherPort}`));
      expect(targets).toContain("169.254.169.254");
    } finally {
      await browser.close();
      await proxy.close();
      other.close();
    }
  }, 120_000);

  test("TEST 12: retries, backoff, idempotency, leases, time slices, plan allowances and the failure queue", async () => {
    // Idempotent enqueue.
    const enq = (key?: string, type: string = BACKLINK_JOBS.plan) =>
      tenant(db, A.orgId, (tx) =>
        enqueueJob(tx, {
          organizationId: A.orgId,
          jobType: type as never,
          payload: { test: true },
          idempotencyKey: key,
          runAt: new Date(Date.now() + 3600_000)
        })
      );
    const k1 = await enq(`same-key:${A.orgId}`);
    expect(await enq(`same-key:${A.orgId}`)).toEqual({ id: k1.id, created: false });

    // Atomic claiming: 8 concurrent claimers, 3 jobs -> each claimed exactly once.
    const type = `backlinks.test_claim_${Date.now()}`;
    for (let i = 0; i < 3; i++)
      await tenant(db, A.orgId, (tx) => enqueueJob(tx, { organizationId: A.orgId, jobType: type as never, payload: { i } }));
    const claims = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        claimJobs(workerDb, { workerId: `claimer-${i}`, limit: 1, leaseSeconds: 60, perOrgConcurrency: 50, types: [type] })
      )
    );
    const claimed = claims.flat().map((j) => j.id);
    expect(claimed).toHaveLength(3);
    expect(new Set(claimed).size).toBe(3);
    // Crash recovery: expired leases go back to the queue; exhausted jobs fail.
    await worker.query(
      `update jobs set locked_until = now() - interval '1 second', max_attempts = case when id = $1 then 1 else max_attempts end where id = any($2::uuid[])`,
      [claimed[0], claimed]
    );
    expect(await recoverExpired(workerDb)).toBe(3);
    const statuses = (await worker.query(`select id, status from jobs where id = any($1::uuid[])`, [claimed])).rows;
    expect(statuses.find((s) => s.id === claimed[0]).status).toBe("failed");
    expect(statuses.filter((s) => s.status === "queued")).toHaveLength(2);
    await worker.query(`delete from jobs where type = $1`, [type]);

    // Time slices: a handler that overruns is aborted and retried with backoff.
    const slowType = `backlinks.test_slow_${Date.now()}`;
    let aborted = false;
    const slow = engineHandler(
      (ctx) =>
        new Promise((r) => {
          ctx.signal.addEventListener("abort", () => (aborted = true));
          setTimeout(r, 6000);
        }),
      createRuntime()
    );
    await tenant(db, A.orgId, (tx) => enqueueJob(tx, { organizationId: A.orgId, jobType: slowType as never, maxAttempts: 2 }));
    await runTick({
      workerDb,
      appDb: db,
      handlers: { [slowType]: slow },
      workerId: "slow",
      budgetMs: 8_000,
      maxJobMs: 1_000,
      organizationId: A.orgId,
      types: [slowType]
    });
    const timedOut = (await worker.query(`select status, attempts, last_error, run_at > now() as delayed from jobs where type = $1`, [slowType]))
      .rows[0];
    expect(aborted).toBe(true);
    expect(timedOut).toMatchObject({ status: "queued", attempts: 1, delayed: true });
    expect(timedOut.last_error).toMatch(/time slice/);
    await worker.query(`delete from jobs where type = $1`, [slowType]);
    for (let i = 1; i <= 8; i++) expect(backoffSeconds(i)).toBeLessThanOrEqual(3600);
    expect(backoffSeconds(3)).toBeGreaterThan(backoffSeconds(1));

    // A real submission with injected temporary failures (HTTP 503 x2): retried with backoff, one listing only.
    const sourceId = await registerTestDestination(A.orgId, A.owner.userId, dest, "listing-api-v1");
    const site = async (name: string, url: string) => {
      const w = await newWebsite(A, name, url, "autopilot", [sourceId]);
      await createBacklinkCampaign(db, A.owner, A.access, {
        websiteId: w,
        name: `${name} campaign`,
        preferredCategories: ["industry_directory"],
        allowedAdapters: ["listing-api-v1"],
        approvalRequired: false,
        minQualityScore: 40
      });
      return w;
    };
    const subOf = (w: string) => one(A.orgId, `select * from backlink_submissions where website_id = $1`, [w]);
    await fetch(`${dest.url}/admin/fail-next`, {
      method: "POST",
      headers: { "x-admin-token": "test-admin-token" },
      body: JSON.stringify({ count: 2, status: 503 })
    });
    const wr = await site("Retry Robotics", "https://retry-robotics.com/");
    const execOutcomes: string[] = [];
    for (let i = 0; i < 6; i++) {
      const out = await runner.drain();
      execOutcomes.push(...out.filter((o) => o.jobType === BACKLINK_JOBS.execute).map((o) => o.outcome));
      const s = await subOf(wr);
      if (s.status !== "SUBMISSION_QUEUED" && s.status !== "SUBMITTING") break;
      await makeDue({ jobType: BACKLINK_JOBS.execute });
    }
    expect(execOutcomes).toEqual(["retry", "retry", "succeeded"]);
    const sr = await subOf(wr);
    expect(["SUBMITTED", "PENDING_VERIFICATION"]).toContain(sr.status);
    expect(sr.attempt_count).toBe(3);
    const evs = await q(A.orgId, `select message from backlink_submission_events where submission_id = $1`, [sr.id]);
    expect(evs.filter((e) => /Temporary failure, will retry/.test(e.message)).length).toBe(2);
    expect(dest.state.listings.filter((l) => l.business_name === "Retry Robotics")).toHaveLength(1);
    expect(
      (await worker.query(`select status, attempts from jobs where type = $1 and payload ->> 'submission_id' = $2`, [BACKLINK_JOBS.execute, sr.id]))
        .rows[0]
    ).toEqual({ status: "succeeded", attempts: 3 });

    // Permanent failure (revoked API token): FAILED, task created, job failed; fix + resume succeeds.
    await registerTestDestination(A.orgId, A.owner.userId, dest, "listing-api-v1", { token: "revoked-token" });
    const wp = await site("Permafail Partners", "https://permafail-partners.com/");
    await runner.drain();
    const sp = await subOf(wp);
    expect(sp.status).toBe("FAILED");
    expect(sp.error_message).toMatch(/Authentication failed/);
    const failedJob = (
      await worker.query(`select id, status from jobs where type = $1 and payload ->> 'submission_id' = $2`, [BACKLINK_JOBS.execute, sp.id])
    ).rows[0];
    expect(failedJob.status).toBe("failed");
    const task = await one(A.orgId, `select id, task_type from backlink_tasks where submission_id = $1`, [sp.id]);
    expect(task.task_type).toBe("adapter_error");
    // The failure queue: a workspace can retry its own failed job, never another workspace's.
    expect(await code(retryBacklinkJob(db, B.owner, B.access, failedJob.id))).toBe("app:not_found");
    await retryBacklinkJob(db, A.owner, A.access, failedJob.id);
    await runner.drain(); // the retried job sees the FAILED submission and does nothing (no blind resubmission)
    expect((await subOf(wp)).status).toBe("FAILED");
    expect(dest.state.listings.filter((l) => l.business_name === "Permafail Partners")).toHaveLength(0);
    await registerTestDestination(A.orgId, A.owner.userId, dest, "listing-api-v1", { token: "test-api-token" });
    await resolveBacklinkTask(db, A.owner, A.access, task.id, { action: "resume", note: "token rotated" });
    await runner.drain();
    expect(["SUBMITTED", "PENDING_VERIFICATION"]).toContain((await subOf(wp)).status);

    // Plan allowance: with no automated submissions left this month, execution is deferred (not failed, no attempt used).
    await ownerInTenant(A.orgId, `update subscriptions set overrides = '{"backlink_submissions_month": 0}' where organization_id = $1`, [A.orgId]);
    const wq = await site("Quota Quill", "https://quota-quill.com/");
    const out = await runner.drain();
    expect(out.filter((o) => o.jobType === BACKLINK_JOBS.execute).map((o) => o.outcome)).toEqual(["deferred"]);
    const sq = await subOf(wq);
    expect(sq.status).toBe("SUBMISSION_QUEUED");
    const deferred = (
      await worker.query(
        `select status, attempts, run_at > now() + interval '1 minute' as later from jobs where type = $1 and payload ->> 'submission_id' = $2`,
        [BACKLINK_JOBS.execute, sq.id]
      )
    ).rows[0];
    expect(deferred).toEqual({ status: "queued", attempts: 0, later: true });
    expect(dest.state.listings.some((l) => l.business_name === "Quota Quill")).toBe(false);
    await ownerInTenant(A.orgId, `update subscriptions set overrides = '{}' where organization_id = $1`, [A.orgId]);
  }, 300_000);
});
