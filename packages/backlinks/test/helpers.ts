/**
 * Acceptance-test environment: the real database (migrations + seed catalogue, RLS on), the approved test
 * destination over real HTTP, the shared @sge/jobs runner and real Chromium. Nothing inside the engine is mocked.
 */
import pg from "pg";
import { randomUUID } from "node:crypto";
import { createDb, getPool, type Db } from "@sge/db";
import {
  acceptInvitation,
  addWebsite,
  createAgencyWorkspace,
  encryptSecret,
  inviteMember,
  resolveWorkspace,
  type Actor,
  type Role,
  type WorkspaceAccess
} from "@sge/core";
import { PermanentJobError, runTick, type JobHandler } from "@sge/jobs";
import {
  approveBusinessProfile,
  backlinkJobHandlers,
  createRuntime,
  credentialsAad,
  saveBusinessProfile,
  setWebsiteAutomation,
  tenant,
  type ProfileInputT,
  type Runtime
} from "../src/index";

/** SQL as a workspace (app_user, RLS on). */
export const q = <T = any>(orgId: string, text: string, params: unknown[] = []) => tenant(db, orgId, (tx) => tx.q<T>(text, params));
export const one = <T = any>(orgId: string, text: string, params: unknown[] = []) => tenant(db, orgId, (tx) => tx.one<T>(text, params));
import { startTestDestination, type TestDestination } from "./fixtures/test-destination";

export const db: Db = createDb(process.env.TEST_DATABASE_URL!);
export const workerDb: Db = createDb(process.env.TEST_WORKER_DATABASE_URL!);
export const owner = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL_OWNER, max: 3 });
/** worker_user: the queue tables only (as in production). */
export const worker = new pg.Pool({ connectionString: process.env.TEST_WORKER_DATABASE_URL, max: 2 });

/** Real third-party sites are crawled only with BACKLINKS_LIVE_TESTS=1 (read-only, robots-respecting). */
export const LIVE = process.env.BACKLINKS_LIVE_TESTS === "1";

export async function closeAll() {
  await owner.end();
  await worker.end();
  await getPool(process.env.TEST_DATABASE_URL!).end();
  await getPool(process.env.TEST_WORKER_DATABASE_URL!).end();
}

let n = 0;
export async function makeUser(opts: { verified?: boolean } = {}): Promise<Actor & { email: string }> {
  n++;
  const id = randomUUID();
  const email = `bl-user${n}-${id.slice(0, 6)}@example.test`;
  await owner.query(`INSERT INTO auth.users (id, name, email, email_verified) VALUES ($1, $2, $3, $4)`, [
    id,
    `User ${n}`,
    email,
    opts.verified ?? true
  ]);
  return { userId: id, email };
}

/** Run SQL as the schema owner inside one tenant (FORCE RLS applies to the owner too). For test seeding only. */
export async function ownerInTenant<T = any>(orgId: string, text: string, params: unknown[] = []): Promise<T[]> {
  const c = await owner.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.org_id', $1, true), set_config('app.client_scope', '*', true)", [orgId]);
    const r = await c.query(text, params as unknown[]);
    await c.query("COMMIT");
    return r.rows as T[];
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

export async function accessFor(userId: string, slug: string): Promise<WorkspaceAccess> {
  const a = await resolveWorkspace(db, userId, slug);
  if (!a) throw new Error("no access");
  return a;
}

export interface Agency {
  owner: Actor & { email: string };
  access: WorkspaceAccess;
  orgId: string;
  addMember(role: Exclude<Role, "owner">, clientIds?: string[]): Promise<{ actor: Actor; access: WorkspaceAccess }>;
}

/** An agency workspace on the roomy "agency" plan. */
export async function makeAgency(name = "Acme Agency"): Promise<Agency> {
  const o = await makeUser();
  const ws = await createAgencyWorkspace(db, o, name);
  await ownerInTenant(ws.id, "UPDATE subscriptions SET plan_id = 'agency' WHERE organization_id = $1", [ws.id]);
  const access = await accessFor(o.userId, ws.slug);
  return {
    owner: o,
    access,
    orgId: ws.id,
    async addMember(role, clientIds = []) {
      const u = await makeUser();
      const { token } = await inviteMember(db, o, access, { email: u.email, role, clientIds });
      await acceptInvitation(db, u, token);
      return { actor: u, access: await accessFor(u.userId, ws.slug) };
    }
  };
}

export const FIXTURE_PROFILE = (url: string, name: string): ProfileInputT => ({
  business_name: name,
  website_url: url,
  industry: "technology",
  description: `${name} is a software company that builds analytics dashboards for small online businesses. It helps teams understand website performance without writing code.`,
  products_services: ["Website analytics dashboards", "Conversion reporting", "Data integration services"],
  target_countries: ["IN", "GB"],
  contact_email: `hello@${new URL(url).hostname}`,
  contact_phone: null,
  address: null,
  social_profiles: {},
  brand_descriptions: [`${name} turns website data into clear weekly reports.`],
  target_landing_pages: [{ url: `${url.replace(/\/$/, "")}/analytics`, label: "Analytics dashboards" }],
  target_keywords: ["website analytics", "saas analytics", "conversion reporting"],
  approved_anchor_texts: [name],
  founder: null,
  founded_year: 2019,
  verified_facts: []
});

/** A website with an approved profile, optionally on autopilot for the given sources. */
export async function newWebsite(
  a: Agency,
  name: string,
  url: string,
  mode: "supervised" | "autopilot" | "manual" = "supervised",
  autopilotSourceIds: string[] = [],
  clientId?: string
) {
  const w = await addWebsite(db, a.owner, a.access, { url, displayName: name, clientId });
  await saveBusinessProfile(db, a.owner, a.access, w.id, FIXTURE_PROFILE(url, name));
  await approveBusinessProfile(db, a.owner, a.access, w.id);
  if (mode !== "supervised")
    await setWebsiteAutomation(db, a.owner, a.access, w.id, {
      mode,
      autopilotSourceIds: mode === "autopilot" ? autopilotSourceIds : undefined,
      note: "Test destination operated by this project"
    });
  return w.id;
}

/**
 * Registers the approved test destination as a workspace source with recorded permission. `test_destination`
 * is platform-only in the service layer, so tests seed it directly (like the e2e suite seeds Google data).
 */
export async function registerTestDestination(
  orgId: string,
  userId: string,
  dest: TestDestination,
  adapterKey: string,
  opts: { submissionPath?: string; token?: string; credentials?: Record<string, string> } = {}
): Promise<string> {
  const domain = `127.0.0.1:${dest.port}`;
  const [row] = await ownerInTenant<{ id: string }>(
    orgId,
    `insert into backlink_sources (organization_id, domain, name, source_type, industries, countries, homepage_url, submission_url, adapter_key,
        automation_permission, permission_evidence, form_mapping, api_config, requires_account, link_type_expected, curation_status, notes)
     values ($1,$2,'SGE Test Directory','industry_directory','{}','{}',$3,$4,$5,'test_destination',$6,$7,$8,false,'dofollow','verified',
             'Approved end-to-end test destination owned by the project')
     on conflict (organization_id, domain) where organization_id is not null do update set adapter_key = excluded.adapter_key,
        submission_url = excluded.submission_url, api_config = excluded.api_config
     returning id`,
    [
      orgId,
      domain,
      `${dest.url}/`,
      `${dest.url}${opts.submissionPath ?? "/submit"}`,
      adapterKey,
      JSON.stringify({
        granted_by: "project owner",
        basis: "test destination operated by this project",
        terms_accepted_by: userId,
        terms_accepted_at: new Date().toISOString(),
        terms_url: `${dest.url}/about`
      }),
      JSON.stringify({ verify_after_seconds: 0 }),
      JSON.stringify({ endpoint: `${dest.url}/api/v1/listings`, base_url: dest.url, username: "sge-partner" })
    ]
  );
  const credentials = opts.credentials ?? { token: opts.token ?? "test-api-token", app_password: "abcd efgh ijkl mnop" };
  await ownerInTenant(orgId, `update backlink_sources set credentials_enc = $2, credentials_hint = '…test' where id = $1`, [
    row!.id,
    encryptSecret(JSON.stringify(credentials), credentialsAad(orgId, row!.id))
  ]);
  await ownerInTenant(
    orgId,
    `insert into backlink_domain_limits (organization_id, scope, key, max_per_day, max_per_week, min_interval_seconds)
     values ($1, 'domain', $2, 50, 200, 0) on conflict (organization_id, scope, key) where organization_id is not null do nothing`,
    [orgId, domain]
  );
  return row!.id;
}

export type Outcome = { jobId: string; jobType: string; outcome: "succeeded" | "deferred" | "retry" | "failed" };

/** The shared queue runner with the backlink handlers, recording each job's outcome. */
export class TestRunner {
  readonly outcomes: Outcome[] = [];
  readonly handlers: Record<string, JobHandler>;
  constructor(
    readonly rt: Runtime,
    readonly workerId = "test-worker"
  ) {
    const raw = backlinkJobHandlers({ runtime: rt, workerId });
    this.handlers = Object.fromEntries(Object.entries(raw).map(([type, h]) => [type, this.record(type, h)]));
  }

  private record(type: string, h: JobHandler): JobHandler {
    return async (ctx) => {
      try {
        const out = await h(ctx);
        this.outcomes.push({ jobId: ctx.job.id, jobType: type, outcome: "continue" in out ? "deferred" : "succeeded" });
        return out;
      } catch (e) {
        const final = e instanceof PermanentJobError || ctx.job.attempts >= ctx.job.maxAttempts;
        this.outcomes.push({ jobId: ctx.job.id, jobType: type, outcome: final ? "failed" : "retry" });
        throw e;
      }
    };
  }

  /** Runs due jobs (and the jobs they enqueue) until none are due. Returns the outcomes of this call. */
  async drain(opts: { types?: string[]; budgetMs?: number } = {}): Promise<Outcome[]> {
    const start = this.outcomes.length;
    for (let i = 0; i < 40; i++) {
      const r = await runTick({
        workerDb,
        appDb: db,
        handlers: this.handlers,
        workerId: this.workerId,
        budgetMs: opts.budgetMs ?? 240_000,
        maxJobMs: 60_000,
        concurrency: 6,
        perOrgConcurrency: 6,
        runSchedules: false,
        types: opts.types ?? Object.keys(this.handlers)
      });
      if (r.claimed === 0) break;
    }
    return this.outcomes.slice(start);
  }
}

export function testRuntime(dest: TestDestination, opts: { browser?: boolean; mail?: Runtime["mail"] } = {}): Runtime {
  return createRuntime({
    browser: opts.browser ?? true,
    mail: opts.mail ?? null,
    fetcher: {
      hostIntervalMs: 250,
      concurrency: 6,
      test: {
        allowHostPorts: [`127.0.0.1:${dest.port}`],
        // Offline by default: every real hostname fails to resolve, so only the local test destination is reachable.
        ...(LIVE
          ? {}
          : {
              resolver: async () => {
                throw new Error("offline test run (set BACKLINKS_LIVE_TESTS=1 to crawl real sites)");
              }
            })
      }
    }
  });
}

/** Make scheduled (future) jobs due now: simulates the passage of time. */
export async function makeDue(filter: { jobType?: string; submissionId?: string } = {}): Promise<number> {
  const r = await worker.query(
    `update jobs set run_at = now() where status = 'queued' and ($1::text is null or type = $1)
       and ($2::text is null or payload ->> 'submission_id' = $2)`,
    [filter.jobType ?? null, filter.submissionId ?? null]
  );
  return r.rowCount ?? 0;
}

/** POST to the test destination's moderator API. */
export async function admin(dest: TestDestination, path: string, body: unknown = {}) {
  const r = await fetch(`${dest.url}${path}`, {
    method: "POST",
    headers: { "x-admin-token": "test-admin-token", "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return r.json();
}

export { startTestDestination, type TestDestination };
