import { and, asc, desc, eq, inArray, isNull, schema, sql, withContext, type Db, type Tx } from "@sge/db";
import type { Audit, AuditIssue, Crawl } from "@sge/db/schema";
import { safeFetch, SafeFetchError, urlHash, type PageSeo, type SafeFetchOptions, type SafeFetchResult } from "@sge/crawler";
import { cancelJob, type JobHandler } from "@sge/jobs";
import { compareIssues, RULES, runAudit, SEVERITY_RANK, type AuditPage, type ExternalCheck, type RuleDiff, type Severity } from "@sge/seo-rules";
import { audit as auditLog } from "./audit";
import { assertId, inWorkspace, requireAction, type Actor, type WorkspaceAccess } from "./context";
import { cancelCrawl, createCrawl } from "./crawls";
import { AppError } from "./errors";

const { audits, auditIssues, auditExternalLinks, crawls, crawlPages, websites, schedules, jobs } = schema;

export const AUDIT_SCHEDULED_JOB = "audit.scheduled";
/** Older audits (and their crawls) beyond this are pruned per website. */
export const AUDITS_KEPT_PER_WEBSITE = 10;
/** External links checked per audit. */
export const EXTERNAL_LINK_CAP = { verified: 300, unverified: 25 } as const;
export const SCHEDULE_FREQUENCIES = { weekly: 7 * 24 * 60, monthly: 30 * 24 * 60 } as const;
export type ScheduleFrequency = "off" | keyof typeof SCHEDULE_FREQUENCIES;

/* ─────────────────────────────── Service API ────────────────────────────── */

/** Creates the crawl and audit rows (caller checks permissions). */
export async function createAuditRun(tx: Tx, organizationId: string, websiteId: string, userId: string | null, trigger: "manual" | "schedule"): Promise<Audit> {
  const crawl = await createCrawl(tx, organizationId, websiteId, userId);
  const [a] = await tx.insert(audits).values({ organizationId, websiteId, crawlId: crawl.id, trigger, createdByUserId: userId }).returning();
  return a!;
}

export async function startAudit(db: Db, actor: Actor, access: WorkspaceAccess, websiteId: string): Promise<Audit> {
  assertId(websiteId, "Website");
  return inWorkspace(db, actor, access, async (tx, { role }) => {
    requireAction(role, "work.run");
    const a = await createAuditRun(tx, access.workspace.id, websiteId, actor.userId, "manual");
    await auditLog(tx, {
      organizationId: access.workspace.id,
      actorUserId: actor.userId,
      action: "site_audit.started",
      entityType: "site_audit",
      entityId: a.id,
      metadata: { websiteId },
      ip: actor.ip,
      userAgent: actor.userAgent
    });
    return a;
  });
}

export async function cancelAudit(db: Db, actor: Actor, access: WorkspaceAccess, auditId: string): Promise<void> {
  assertId(auditId, "Audit");
  const a = await inWorkspace(db, actor, access, async (tx, { role }) => {
    requireAction(role, "work.run");
    const [row] = await tx.select().from(audits).where(eq(audits.id, auditId));
    if (!row) throw new AppError("not_found", "Audit not found");
    if (row.status === "checking_links" || row.status === "analyzing") {
      await tx.update(audits).set({ status: "cancelled", finishedAt: new Date() }).where(eq(audits.id, row.id));
      const [job] = await tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.idempotencyKey, `audit:${row.id}`));
      if (job) await cancelJob(tx, job.id);
    } else if (row.status !== "crawling") throw new AppError("conflict", "This audit isn't running");
    return row;
  });
  if (a.status === "crawling") await cancelCrawl(db, actor, access, a.crawlId);
}

export async function listAudits(db: Db, actor: Actor, access: WorkspaceAccess, websiteId: string, limit = 10): Promise<Audit[]> {
  assertId(websiteId, "Website");
  return inWorkspace(db, actor, access, (tx) =>
    tx.select().from(audits).where(eq(audits.websiteId, websiteId)).orderBy(desc(audits.createdAt)).limit(Math.min(limit, 50))
  );
}

export interface RuleCount {
  rule: string;
  severity: Severity;
  count: number;
}

export interface AuditDetail {
  audit: Audit;
  crawl: Crawl;
  rules: RuleCount[];
  previous: Audit | null;
  /** Per-rule change since the previous completed audit. */
  diff: RuleDiff[] | null;
}

export async function getAudit(db: Db, actor: Actor, access: WorkspaceAccess, auditId: string): Promise<AuditDetail> {
  assertId(auditId, "Audit");
  return inWorkspace(db, actor, access, async (tx) => {
    const [a] = await tx.select().from(audits).where(eq(audits.id, auditId));
    if (!a) throw new AppError("not_found", "Audit not found");
    const [crawl] = await tx.select().from(crawls).where(eq(crawls.id, a.crawlId));
    const grouped = await tx
      .select({ rule: auditIssues.rule, severity: auditIssues.severity, count: sql<number>`count(*)::int` })
      .from(auditIssues)
      .where(eq(auditIssues.auditId, a.id))
      .groupBy(auditIssues.rule, auditIssues.severity);
    const rules = grouped.sort((x, y) => SEVERITY_RANK[x.severity] - SEVERITY_RANK[y.severity] || y.count - x.count);

    let previous: Audit | null = null;
    let diff: RuleDiff[] | null = null;
    if (a.status === "completed") {
      [previous = null] = await tx
        .select()
        .from(audits)
        .where(and(eq(audits.websiteId, a.websiteId), eq(audits.status, "completed"), sql`${audits.createdAt} < ${a.createdAt}`))
        .orderBy(desc(audits.createdAt))
        .limit(1);
      if (previous) {
        const rows = await tx
          .select({ auditId: auditIssues.auditId, rule: auditIssues.rule, url: auditIssues.url })
          .from(auditIssues)
          .where(inArray(auditIssues.auditId, [a.id, previous.id]));
        diff = compareIssues(
          rows.filter((r) => r.auditId === previous!.id),
          rows.filter((r) => r.auditId === a.id)
        );
      }
    }
    return { audit: a, crawl: crawl!, rules, previous, diff };
  });
}

export async function getAuditIssues(
  db: Db,
  actor: Actor,
  access: WorkspaceAccess,
  auditId: string,
  rule: string,
  opts: { limit?: number; offset?: number } = {}
): Promise<AuditIssue[]> {
  assertId(auditId, "Audit");
  if (!RULES[rule]) throw new AppError("invalid_input", "Unknown issue type");
  return inWorkspace(db, actor, access, (tx) =>
    tx
      .select()
      .from(auditIssues)
      .where(and(eq(auditIssues.auditId, auditId), eq(auditIssues.rule, rule)))
      .orderBy(asc(auditIssues.url))
      .limit(Math.min(opts.limit ?? 100, 1000))
      .offset(Math.max(0, opts.offset ?? 0))
  );
}

const csvCell = (v: unknown) => {
  let s = v === null || v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v);
  // Neutralise spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** All issues of an audit as CSV (severity, category, issue, URL, details). */
export async function auditIssuesCsv(db: Db, actor: Actor, access: WorkspaceAccess, auditId: string): Promise<string> {
  assertId(auditId, "Audit");
  const rows = await inWorkspace(db, actor, access, async (tx) => {
    const [a] = await tx.select({ id: audits.id }).from(audits).where(eq(audits.id, auditId));
    if (!a) throw new AppError("not_found", "Audit not found");
    return tx.select().from(auditIssues).where(eq(auditIssues.auditId, auditId)).limit(100_000);
  });
  rows.sort((x, y) => SEVERITY_RANK[x.severity] - SEVERITY_RANK[y.severity] || x.rule.localeCompare(y.rule) || (x.url ?? "").localeCompare(y.url ?? ""));
  const lines = [["Severity", "Category", "Issue", "URL", "Details"].join(",")];
  for (const r of rows) {
    const rule = RULES[r.rule];
    lines.push([r.severity, rule?.category ?? "", rule?.title ?? r.rule, r.url ?? "(site-wide)", r.details ?? ""].map(csvCell).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

/* ─────────────────────────────── Schedules ─────────────────────────────── */

export async function getAuditSchedule(db: Db, actor: Actor, access: WorkspaceAccess, websiteId: string) {
  assertId(websiteId, "Website");
  return inWorkspace(db, actor, access, async (tx) => {
    const [s] = await tx
      .select()
      .from(schedules)
      .where(and(eq(schedules.websiteId, websiteId), eq(schedules.jobType, AUDIT_SCHEDULED_JOB)));
    const frequency: ScheduleFrequency = !s?.enabled
      ? "off"
      : s.intervalMinutes === SCHEDULE_FREQUENCIES.weekly
        ? "weekly"
        : "monthly";
    return { frequency, nextRunAt: s?.enabled ? s.nextRunAt : null, lastRunAt: s?.lastRunAt ?? null };
  });
}

export async function setAuditSchedule(db: Db, actor: Actor, access: WorkspaceAccess, websiteId: string, frequency: ScheduleFrequency): Promise<void> {
  assertId(websiteId, "Website");
  if (!["off", "weekly", "monthly"].includes(frequency)) throw new AppError("invalid_input", "Choose weekly, monthly or off");
  await inWorkspace(db, actor, access, async (tx, { role }) => {
    requireAction(role, "websites.manage");
    const [w] = await tx.select({ id: websites.id }).from(websites).where(eq(websites.id, websiteId));
    if (!w) throw new AppError("not_found", "Website not found");
    if (frequency === "off") {
      await tx
        .update(schedules)
        .set({ enabled: false, updatedAt: new Date() })
        .where(and(eq(schedules.websiteId, websiteId), eq(schedules.jobType, AUDIT_SCHEDULED_JOB)));
    } else {
      const minutes = SCHEDULE_FREQUENCIES[frequency];
      const next = new Date(Date.now() + minutes * 60_000);
      await tx
        .insert(schedules)
        .values({ organizationId: access.workspace.id, websiteId, jobType: AUDIT_SCHEDULED_JOB, payload: { websiteId }, intervalMinutes: minutes, nextRunAt: next })
        .onConflictDoUpdate({
          target: [schedules.websiteId, schedules.jobType],
          set: { intervalMinutes: minutes, nextRunAt: next, enabled: true, updatedAt: new Date() }
        });
    }
    await auditLog(tx, {
      organizationId: access.workspace.id,
      actorUserId: actor.userId,
      action: "site_audit.schedule_set",
      entityType: "website",
      entityId: websiteId,
      metadata: { frequency },
      ip: actor.ip,
      userAgent: actor.userAgent
    });
  });
}

/* ─────────────────────────────── Job handlers ───────────────────────────── */

export interface AuditHandlerOptions {
  fetch?: (url: string, opts: SafeFetchOptions) => Promise<SafeFetchResult>;
  fetchTimeoutMs?: number;
  /** Parallel external checks (one per host at a time). */
  concurrency?: number;
}

/** Classifies an external URL check. Only clear failures count as "broken". */
export async function checkExternalLink(
  url: string,
  fetchFn: NonNullable<AuditHandlerOptions["fetch"]>,
  timeoutMs: number
): Promise<{ outcome: ExternalCheck["outcome"]; httpStatus: number | null; error: string | null }> {
  try {
    const r = await fetchFn(url, { timeoutMs, maxBytes: 256 * 1024, contentTypes: [""] });
    const s = r.status;
    const broken = s === 400 || s === 404 || s === 410 || (s >= 500 && s !== 503);
    return { outcome: s < 400 ? "ok" : broken ? "broken" : "unverifiable", httpStatus: s, error: null };
  } catch (e) {
    if (e instanceof SafeFetchError) {
      if (e.code === "too_large") return { outcome: "ok", httpStatus: null, error: null };
      if (e.code === "dns_failed" || e.code === "network") return { outcome: "broken", httpStatus: null, error: e.message };
      return { outcome: "unverifiable", httpStatus: null, error: e.message };
    }
    return { outcome: "unverifiable", httpStatus: null, error: "Check failed" };
  }
}

export function createAuditAnalyzeHandler(o: AuditHandlerOptions = {}): JobHandler {
  const fetchFn = o.fetch ?? safeFetch;
  const timeoutMs = o.fetchTimeoutMs ?? 8_000;
  const concurrency = o.concurrency ?? 4;

  return async ({ job, appDb, deadline, heartbeat }) => {
    const org = job.organizationId!;
    const auditId = String(job.payload.auditId ?? "");
    assertId(auditId, "Audit");
    const t = <T>(fn: (tx: Tx) => Promise<T>) => withContext(appDb, { organizationId: org }, fn);

    const load = () => t(async (tx) => (await tx.select().from(audits).where(eq(audits.id, auditId)))[0]);
    let a = await load();
    if (!a || (a.status !== "checking_links" && a.status !== "analyzing")) return { done: true };

    // ── Phase 1: check external links (resumable) ──────────────────────────
    if (a.status === "checking_links") {
      await t(async (tx) => {
        const [w] = await tx.select({ v: websites.verificationStatus }).from(websites).where(eq(websites.id, a!.websiteId));
        const cap = w?.v === "verified" ? EXTERNAL_LINK_CAP.verified : EXTERNAL_LINK_CAP.unverified;
        const found = await tx.execute<{ u: string }>(sql`
          select distinct x.u from crawl_pages cp,
            lateral jsonb_array_elements_text(coalesce(cp.seo->'externalLinks', '[]'::jsonb)) as x(u)
          where cp.crawl_id = ${a!.crawlId} order by x.u limit ${cap}::int`);
        if (found.rows.length)
          await tx
            .insert(auditExternalLinks)
            .values(found.rows.map((r) => ({ organizationId: org, auditId, url: r.u, urlHash: urlHash(r.u) })))
            .onConflictDoNothing();
      });

      while (true) {
        if (Date.now() + timeoutMs + 2_000 > deadline) return { continue: true, progress: { phase: "checking_links" } };
        if (!(await heartbeat())) return { cancelled: true };
        const pending = await t((tx) =>
          tx
            .select()
            .from(auditExternalLinks)
            .where(and(eq(auditExternalLinks.auditId, auditId), isNull(auditExternalLinks.outcome)))
            .orderBy(asc(auditExternalLinks.createdAt), asc(auditExternalLinks.url))
            .limit(concurrency * 4)
        );
        if (!pending.length) break;
        // One request per host at a time: politeness towards other sites.
        const hosts = new Set<string>();
        const batch = pending.filter((p) => {
          const h = new URL(p.url).hostname;
          if (hosts.has(h) || hosts.size >= concurrency) return false;
          hosts.add(h);
          return true;
        });
        const results = await Promise.all(batch.map(async (p) => ({ p, r: await checkExternalLink(p.url, fetchFn, timeoutMs) })));
        await t(async (tx) => {
          for (const { p, r } of results)
            await tx
              .update(auditExternalLinks)
              .set({ outcome: r.outcome, httpStatus: r.httpStatus, error: r.error?.slice(0, 300) ?? null, checkedAt: new Date() })
              .where(eq(auditExternalLinks.id, p.id));
          await tx
            .update(audits)
            .set({ externalLinksChecked: sql`${audits.externalLinksChecked} + ${results.length}` })
            .where(eq(audits.id, auditId));
        });
      }
      await t((tx) => tx.update(audits).set({ status: "analyzing" }).where(and(eq(audits.id, auditId), eq(audits.status, "checking_links"))));
      a = await load();
      if (!a || a.status !== "analyzing") return { done: true };
    }

    // ── Phase 2: run the rules and store results (one transaction) ─────────
    await t(async (tx) => {
      const [crawl] = await tx.select().from(crawls).where(eq(crawls.id, a!.crawlId));
      if (!crawl) throw new Error("Audit crawl is missing");
      const rows = await tx.select().from(crawlPages).where(eq(crawlPages.crawlId, crawl.id));
      const ext = await tx.select().from(auditExternalLinks).where(eq(auditExternalLinks.auditId, auditId));
      const pages: AuditPage[] = rows.map((r) => ({
        url: r.url,
        source: r.source,
        status: r.status,
        httpStatus: r.httpStatus,
        finalUrl: r.finalUrl,
        redirects: r.redirects?.urls ?? [],
        redirectStatuses: r.redirects?.statuses ?? [],
        error: r.error,
        skipReason: r.skipReason,
        bytes: r.bytes,
        durationMs: r.durationMs,
        seo: (r.seo as PageSeo | null) ?? null
      }));
      const result = runAudit({
        startUrl: crawl.startUrl,
        robotsStatus: crawl.robotsStatus,
        sitemapUrlCount: crawl.sitemapUrls,
        hitPageLimit: crawl.status === "limit_reached" || crawl.pagesFound >= crawl.maxPages,
        pages,
        externalChecks: ext.filter((e) => e.outcome).map((e) => ({ url: e.url, outcome: e.outcome as ExternalCheck["outcome"], httpStatus: e.httpStatus }))
      });

      await tx.delete(auditIssues).where(eq(auditIssues.auditId, auditId));
      for (let i = 0; i < result.issues.length; i += 500)
        await tx.insert(auditIssues).values(
          result.issues.slice(i, i + 500).map((x) => ({ organizationId: org, auditId, rule: x.rule, severity: x.severity, url: x.url, details: x.details ?? null }))
        );
      const graph = Object.entries(result.linkGraph).map(([u, g]) => ({ u, i: g.inlinks, d: g.depth }));
      if (graph.length)
        await tx.execute(sql`
          update crawl_pages cp set inlinks = (x->>'i')::int, click_depth = (x->>'d')::int
          from jsonb_array_elements(${JSON.stringify(graph)}::jsonb) as x
          where cp.crawl_id = ${crawl.id} and cp.url = x->>'u'`);

      const ruleCounts: Record<string, number> = {};
      for (const x of result.issues) ruleCounts[x.rule] = (ruleCounts[x.rule] ?? 0) + 1;
      await tx
        .update(audits)
        .set({
          status: "completed",
          healthScore: result.healthScore,
          pagesAnalyzed: result.stats.pagesAnalyzed,
          critical: result.stats.critical,
          warning: result.stats.warning,
          notice: result.stats.notice,
          summary: { rules: ruleCounts, stats: { ...result.stats } },
          finishedAt: new Date()
        })
        .where(eq(audits.id, auditId));

      await pruneAudits(tx, a!.websiteId);
    });
    return { done: true };
  };
}

/** Keeps the newest AUDITS_KEPT_PER_WEBSITE finished audits; deleting a crawl cascades to its audit and issues. */
async function pruneAudits(tx: Tx, websiteId: string) {
  const old = await tx
    .select({ crawlId: audits.crawlId })
    .from(audits)
    .where(and(eq(audits.websiteId, websiteId), sql`${audits.status} in ('completed', 'failed', 'cancelled')`))
    .orderBy(desc(audits.createdAt))
    .offset(AUDITS_KEPT_PER_WEBSITE);
  if (old.length) await tx.delete(crawls).where(inArray(crawls.id, old.map((o) => o.crawlId)));
}

/** Recurring audits: the scheduler enqueues this; it starts a normal audit. */
export function createScheduledAuditHandler(): JobHandler {
  return async ({ job, appDb }) => {
    const org = job.organizationId!;
    const websiteId = String(job.websiteId ?? job.payload.websiteId ?? "");
    assertId(websiteId, "Website");
    await withContext(appDb, { organizationId: org }, async (tx) => {
      const [w] = await tx.select({ id: websites.id }).from(websites).where(eq(websites.id, websiteId));
      if (!w) return;
      try {
        await createAuditRun(tx, org, websiteId, null, "schedule");
      } catch (e) {
        // Already running: skip this slot.
        if (!(e instanceof AppError && e.code === "conflict")) throw e;
      }
    });
    return { done: true };
  };
}

/** Latest completed audit per visible website (for lists and the overview). */
export async function latestAuditScores(db: Db, actor: Actor, access: WorkspaceAccess) {
  return inWorkspace(db, actor, access, async (tx) => {
    const r = await tx.execute<{ website_id: string; id: string; health_score: number | null; critical: number; finished_at: string | null }>(sql`
      select distinct on (website_id) website_id, id, health_score, critical, finished_at
      from audits where status = 'completed'
      order by website_id, created_at desc`);
    return new Map(r.rows.map((x) => [x.website_id, { auditId: x.id, healthScore: x.health_score, critical: x.critical }]));
  });
}
