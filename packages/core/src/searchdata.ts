import { and, eq, schema, sql, withContext, type Db, type Tx } from "@sge/db";
import type { WebsiteGoogle } from "@sge/db/schema";
import { enqueue, type JobHandler } from "@sge/jobs";
import { audit } from "./audit";
import { assertId, inWorkspace, requireAction, type Actor, type WorkspaceAccess } from "./context";
import { AppError } from "./errors";
import {
  defaultGoogleDeps,
  ga4RunReport,
  GoogleApiError,
  GoogleAuthError,
  gscPropertyMatches,
  gscQuery,
  listGa4Properties,
  listGscSites,
  workspaceGoogleToken,
  type Ga4Property,
  type GoogleDeps,
  type GscSite
} from "./google";
import { scheduleReverification } from "./websites";

const { websiteGoogle, gscSiteDaily, gscDimDaily, gscDaily, ga4Daily, websites, schedules } = schema;

export const GSC_SYNC_JOB = "gsc.sync";
export const GA4_SYNC_JOB = "ga4.sync";
/** Search Console keeps 16 months; GA4 is backfilled for 90 days (quota-friendly). */
export const GSC_BACKFILL_DAYS = 486;
export const GA4_BACKFILL_DAYS = 90;
/** Query × page rows kept per day of a sync window (top rows by clicks). */
export const GSC_DETAIL_ROWS_PER_DAY = 500;
export const GA4_ROWS_PER_DAY = 1000;
const DAY = 86_400_000;

export const isoDate = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (iso: string, n: number) => isoDate(new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY));
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY) + 1;

/* ───────────────────────── Property selection ──────────────────────────── */

export interface PropertyChoices {
  gsc: (GscSite & { matches: boolean })[];
  ga4: Ga4Property[];
  gscError: string | null;
  ga4Error: string | null;
}

/** Lists the connected Google account's Search Console sites and GA4 properties. */
export async function listGoogleProperties(
  db: Db,
  actor: Actor,
  access: WorkspaceAccess,
  websiteId: string,
  deps: GoogleDeps = defaultGoogleDeps
): Promise<PropertyChoices> {
  assertId(websiteId, "Website");
  const w = await inWorkspace(db, actor, access, async (tx, { role }) => {
    requireAction(role, "websites.manage");
    const [row] = await tx.select().from(websites).where(eq(websites.id, websiteId));
    if (!row) throw new AppError("not_found", "Website not found");
    return row;
  });
  const run = <T>(fn: (tx: Tx) => Promise<T>) => inWorkspace(db, actor, access, (tx) => fn(tx));
  const token = await workspaceGoogleToken(run, access.workspace.id, deps);
  const [gsc, ga4] = await Promise.allSettled([listGscSites(token, deps), listGa4Properties(token, deps)]);
  const msg = (r: PromiseSettledResult<unknown>) =>
    r.status === "rejected" ? (r.reason instanceof GoogleApiError && r.reason.status === 403 ? "Access wasn't granted for this product." : "Couldn't load the list from Google.") : null;
  return {
    gsc: gsc.status === "fulfilled" ? gsc.value.map((s) => ({ ...s, matches: gscPropertyMatches(s.siteUrl, w.domain) })).sort((a, b) => Number(b.matches) - Number(a.matches)) : [],
    ga4: ga4.status === "fulfilled" ? ga4.value : [],
    gscError: msg(gsc),
    ga4Error: msg(ga4)
  };
}

export async function getWebsiteGoogle(db: Db, actor: Actor, access: WorkspaceAccess, websiteId: string): Promise<WebsiteGoogle | null> {
  assertId(websiteId, "Website");
  return inWorkspace(db, actor, access, async (tx) => (await tx.select().from(websiteGoogle).where(eq(websiteGoogle.websiteId, websiteId)))[0] ?? null);
}

const OWNER_LEVELS = ["siteOwner", "siteFullUser"];

/**
 * Links a website to a Search Console property and/or a GA4 property (null to
 * unlink). Choices are re-checked against the Google account; a GSC property
 * the account owns also verifies the website. Starts the backfill.
 */
export async function setWebsiteProperties(
  db: Db,
  actor: Actor,
  access: WorkspaceAccess,
  websiteId: string,
  input: { gsc: string | null; ga4: string | null },
  deps: GoogleDeps = defaultGoogleDeps
): Promise<{ verified: boolean }> {
  assertId(websiteId, "Website");
  const choices = await listGoogleProperties(db, actor, access, websiteId, deps);
  const gscSite = input.gsc ? choices.gsc.find((s) => s.siteUrl === input.gsc) : null;
  if (input.gsc && !gscSite) throw new AppError("invalid_input", "That Search Console property isn't available to the connected Google account");
  if (gscSite && !gscSite.matches) throw new AppError("invalid_input", "That Search Console property is for a different domain");
  const ga4 = input.ga4 ? choices.ga4.find((p) => p.property === input.ga4) : null;
  if (input.ga4 && !ga4) throw new AppError("invalid_input", "That Analytics property isn't available to the connected Google account");

  return inWorkspace(db, actor, access, async (tx, { role }) => {
    requireAction(role, "websites.manage");
    const [w] = await tx.select().from(websites).where(eq(websites.id, websiteId));
    if (!w) throw new AppError("not_found", "Website not found");
    const org = access.workspace.id;
    const [prev] = await tx.select().from(websiteGoogle).where(eq(websiteGoogle.websiteId, websiteId));
    const gscChanged = (prev?.gscProperty ?? null) !== (input.gsc ?? null);
    const ga4Changed = (prev?.ga4Property ?? null) !== (input.ga4 ?? null);

    const values = {
      gscProperty: input.gsc,
      ga4Property: input.ga4,
      ga4PropertyName: ga4?.displayName ?? null,
      ...(gscChanged ? { gscSyncedFrom: null, gscSyncedThrough: null, gscLastSyncAt: null, gscError: null } : {}),
      ...(ga4Changed ? { ga4SyncedFrom: null, ga4SyncedThrough: null, ga4LastSyncAt: null, ga4Error: null } : {}),
      updatedAt: new Date()
    };
    await tx
      .insert(websiteGoogle)
      .values({ websiteId, organizationId: org, ...values })
      .onConflictDoUpdate({ target: websiteGoogle.websiteId, set: values });
    // A different property means different data: drop the old rows.
    if (gscChanged) for (const t of [gscSiteDaily, gscDimDaily, gscDaily]) await tx.delete(t).where(eq(t.websiteId, websiteId));
    if (ga4Changed) await tx.delete(ga4Daily).where(eq(ga4Daily.websiteId, websiteId));

    for (const [jobType, property] of [
      [GSC_SYNC_JOB, input.gsc],
      [GA4_SYNC_JOB, input.ga4]
    ] as const) {
      if (property) {
        await tx
          .insert(schedules)
          .values({ organizationId: org, websiteId, jobType, payload: { websiteId }, intervalMinutes: 24 * 60, nextRunAt: new Date(Date.now() + 24 * 3600_000) })
          .onConflictDoUpdate({ target: [schedules.websiteId, schedules.jobType], set: { enabled: true, updatedAt: new Date() } });
        await enqueue(tx, { type: jobType, organizationId: org, websiteId, payload: { websiteId }, maxAttempts: 4, createdByUserId: actor.userId });
      } else {
        await tx.update(schedules).set({ enabled: false, updatedAt: new Date() }).where(and(eq(schedules.websiteId, websiteId), eq(schedules.jobType, jobType)));
      }
    }

    // Owning the Search Console property proves ownership of the website.
    let verified = false;
    if (gscSite && OWNER_LEVELS.includes(gscSite.permissionLevel) && w.verificationStatus !== "verified") {
      await tx
        .update(websites)
        .set({ verificationStatus: "verified", verificationMethod: "gsc", verifiedAt: new Date(), lastVerificationError: null })
        .where(eq(websites.id, websiteId));
      await scheduleReverification(tx, org, websiteId);
      verified = true;
    }
    await audit(tx, {
      organizationId: org,
      actorUserId: actor.userId,
      action: "website.google_properties_set",
      entityType: "website",
      entityId: websiteId,
      metadata: { gsc: input.gsc, ga4: input.ga4, verified },
      ip: actor.ip,
      userAgent: actor.userAgent
    });
    return { verified };
  });
}

/** Queues an immediate sync of whatever is linked. */
export async function syncWebsiteNow(db: Db, actor: Actor, access: WorkspaceAccess, websiteId: string): Promise<number> {
  assertId(websiteId, "Website");
  return inWorkspace(db, actor, access, async (tx, { role }) => {
    requireAction(role, "work.run");
    const [g] = await tx.select().from(websiteGoogle).where(eq(websiteGoogle.websiteId, websiteId));
    if (!g?.gscProperty && !g?.ga4Property) throw new AppError("invalid_input", "Link a Search Console or Analytics property first");
    let n = 0;
    for (const [type, on] of [
      [GSC_SYNC_JOB, g.gscProperty],
      [GA4_SYNC_JOB, g.ga4Property]
    ] as const)
      if (on) {
        const r = await enqueue(tx, {
          type,
          organizationId: access.workspace.id,
          websiteId,
          payload: { websiteId },
          // At most one manual sync per website and product per 10 minutes.
          idempotencyKey: `${type}:${websiteId}:${Math.floor(Date.now() / 600_000)}`,
          maxAttempts: 4,
          createdByUserId: actor.userId
        });
        if (r.created) n++;
      }
    return n;
  });
}

/* ─────────────────────────────── Sync jobs ─────────────────────────────── */

type Window = { start: string; end: string; direction: "forward" | "backward" };

/** Recent data first (28 days), then forward catch-up, then backfill in 14-day steps. */
export function nextWindow(
  cursor: { from: string | null; through: string | null },
  latest: string,
  earliest: string,
  opts: { refetchDays: number }
): Window | null {
  if (!cursor.through || !cursor.from) return { start: addDays(latest, -27) < earliest ? earliest : addDays(latest, -27), end: latest, direction: "forward" };
  if (cursor.through < latest) {
    const start = addDays(cursor.through, 1 - opts.refetchDays);
    const end = addDays(start, 27) < latest ? addDays(start, 27) : latest;
    return { start, end, direction: "forward" };
  }
  if (cursor.from > earliest) {
    const end = addDays(cursor.from, -1);
    const start = addDays(end, -13) < earliest ? earliest : addDays(end, -13);
    return { start, end, direction: "backward" };
  }
  return null;
}

async function insertChunks<T extends Record<string, unknown>>(tx: Tx, table: Parameters<Tx["insert"]>[0], rows: T[]) {
  for (let i = 0; i < rows.length; i += 1000) await tx.insert(table).values(rows.slice(i, i + 1000) as never);
}

const weightedPosition = (rows: { position: number; impressions: number }[]) => {
  const imp = rows.reduce((n, r) => n + r.impressions, 0);
  return imp ? rows.reduce((n, r) => n + r.position * r.impressions, 0) / imp : 0;
};

export function createGscSyncHandler(deps: GoogleDeps = defaultGoogleDeps, now: () => Date = () => new Date()): JobHandler {
  return async ({ job, appDb, deadline, heartbeat }) => {
    const org = job.organizationId!;
    const websiteId = String(job.websiteId ?? job.payload.websiteId ?? "");
    assertId(websiteId, "Website");
    const t = <T>(fn: (tx: Tx) => Promise<T>) => withContext(appDb, { organizationId: org }, fn);
    const setError = (msg: string | null) => t((tx) => tx.update(websiteGoogle).set({ gscError: msg, updatedAt: new Date() }).where(eq(websiteGoogle.websiteId, websiteId)));

    let [g] = await t((tx) => tx.select().from(websiteGoogle).where(eq(websiteGoogle.websiteId, websiteId)));
    if (!g?.gscProperty) return { done: true };
    const property = g.gscProperty;
    let token: string;
    try {
      token = await workspaceGoogleToken(t, org, deps);
    } catch (e) {
      if (e instanceof GoogleAuthError) {
        await setError(e.message);
        return { done: true };
      }
      throw e;
    }
    const today = isoDate(now());
    // Search Console data is final after ~2-3 days.
    const latest = addDays(today, -3);
    const earliest = addDays(today, -GSC_BACKFILL_DAYS);

    while (true) {
      if (Date.now() + 25_000 > deadline) return { continue: true, progress: { from: g!.gscSyncedFrom, through: g!.gscSyncedThrough } };
      if (!(await heartbeat())) return { cancelled: true };
      const w = nextWindow({ from: g!.gscSyncedFrom, through: g!.gscSyncedThrough }, latest, earliest, { refetchDays: 0 });
      if (!w) break;
      const days = daysBetween(w.start, w.end);
      let totals, devices, countries;
      const detail: { keys: string[]; clicks: number; impressions: number; position: number }[] = [];
      try {
        const base = { startDate: w.start, endDate: w.end };
        [totals, devices, countries] = await Promise.all([
          gscQuery(token, property, { ...base, dimensions: ["date"], rowLimit: 25_000 }, deps),
          gscQuery(token, property, { ...base, dimensions: ["date", "device"], rowLimit: 25_000 }, deps),
          gscQuery(token, property, { ...base, dimensions: ["date", "country"], rowLimit: 25_000 }, deps)
        ]);
        const cap = GSC_DETAIL_ROWS_PER_DAY * days;
        for (let startRow = 0; detail.length < cap; startRow += 25_000) {
          const rows = await gscQuery(token, property, { ...base, dimensions: ["date", "query", "page"], rowLimit: 25_000, startRow }, deps);
          detail.push(...rows.slice(0, cap - detail.length));
          if (rows.length < 25_000) break;
        }
      } catch (e) {
        if (e instanceof GoogleApiError && !e.transient) {
          await setError(e.status === 403 ? "The connected Google account no longer has access to this Search Console property." : `Search Console error: ${e.message}`);
          return { done: true };
        }
        throw e;
      }

      await t(async (tx) => {
        for (const table of [gscSiteDaily, gscDimDaily, gscDaily])
          await tx.delete(table).where(and(eq(table.websiteId, websiteId), sql`${table.date} between ${w.start} and ${w.end}`));
        const common = { organizationId: org, websiteId };
        await insertChunks(tx, gscSiteDaily, totals!.map((r) => ({ ...common, date: r.keys[0]!, clicks: r.clicks, impressions: r.impressions, position: r.position })));
        await insertChunks(tx, gscDimDaily, [
          ...devices!.map((r) => ({ ...common, date: r.keys[0]!, dimension: "device", value: r.keys[1]!.toLowerCase(), clicks: r.clicks, impressions: r.impressions, position: r.position })),
          ...countries!.map((r) => ({ ...common, date: r.keys[0]!, dimension: "country", value: r.keys[1]!.toLowerCase(), clicks: r.clicks, impressions: r.impressions, position: r.position }))
        ]);
        await insertChunks(
          tx,
          gscDaily,
          detail.map((r) => ({ ...common, date: r.keys[0]!, query: r.keys[1]!.slice(0, 500), page: r.keys[2]!.slice(0, 2000), clicks: r.clicks, impressions: r.impressions, position: r.position }))
        );
        const cursor =
          w.direction === "forward"
            ? { gscSyncedThrough: w.end, gscSyncedFrom: g!.gscSyncedFrom && g!.gscSyncedFrom < w.start ? g!.gscSyncedFrom : w.start }
            : { gscSyncedFrom: w.start };
        [g] = await tx
          .update(websiteGoogle)
          .set({ ...cursor, gscLastSyncAt: new Date(), gscError: null, updatedAt: new Date() })
          .where(eq(websiteGoogle.websiteId, websiteId))
          .returning();
      });
      if (!g) return { done: true };
    }
    return { done: true };
  };
}

const GA4_DIMENSIONS = ["date", "sessionSource", "sessionMedium", "landingPage", "sessionCampaignName"];
const GA4_METRICS = ["sessions", "engagedSessions", "keyEvents"];

export function createGa4SyncHandler(deps: GoogleDeps = defaultGoogleDeps, now: () => Date = () => new Date()): JobHandler {
  return async ({ job, appDb, deadline, heartbeat }) => {
    const org = job.organizationId!;
    const websiteId = String(job.websiteId ?? job.payload.websiteId ?? "");
    assertId(websiteId, "Website");
    const t = <T>(fn: (tx: Tx) => Promise<T>) => withContext(appDb, { organizationId: org }, fn);
    const setError = (msg: string | null) => t((tx) => tx.update(websiteGoogle).set({ ga4Error: msg, updatedAt: new Date() }).where(eq(websiteGoogle.websiteId, websiteId)));

    let [g] = await t((tx) => tx.select().from(websiteGoogle).where(eq(websiteGoogle.websiteId, websiteId)));
    if (!g?.ga4Property) return { done: true };
    const property = g.ga4Property;
    let token: string;
    try {
      token = await workspaceGoogleToken(t, org, deps);
    } catch (e) {
      if (e instanceof GoogleAuthError) {
        await setError(e.message);
        return { done: true };
      }
      throw e;
    }
    const today = isoDate(now());
    const latest = addDays(today, -1);
    const earliest = addDays(today, -GA4_BACKFILL_DAYS);

    while (true) {
      if (Date.now() + 25_000 > deadline) return { continue: true, progress: { from: g!.ga4SyncedFrom, through: g!.ga4SyncedThrough } };
      if (!(await heartbeat())) return { cancelled: true };
      // GA4 keeps processing for ~2 days: re-fetch the last 3.
      const w = nextWindow({ from: g!.ga4SyncedFrom, through: g!.ga4SyncedThrough }, latest, earliest, { refetchDays: 3 });
      if (!w) break;
      const cap = GA4_ROWS_PER_DAY * daysBetween(w.start, w.end);
      const rows: { d: string[]; m: number[] }[] = [];
      try {
        for (let offset = 0; rows.length < cap; offset += 10_000) {
          const r = await ga4RunReport(
            token,
            property,
            { startDate: w.start, endDate: w.end, dimensions: GA4_DIMENSIONS, metrics: GA4_METRICS, limit: Math.min(10_000, cap - rows.length), offset },
            deps
          );
          rows.push(...r.rows.map((x) => ({ d: x.dimensionValues.map((v) => v.value), m: x.metricValues.map((v) => Number(v.value) || 0) })));
          if (r.rows.length === 0 || offset + r.rows.length >= r.rowCount) break;
        }
      } catch (e) {
        if (e instanceof GoogleApiError && !e.transient) {
          await setError(e.status === 403 ? "The connected Google account no longer has access to this Analytics property." : `Analytics error: ${e.message}`);
          return { done: true };
        }
        throw e;
      }
      // Aggregate (GA4 may split identical keys after truncation) and convert YYYYMMDD.
      const agg = new Map<string, { date: string; source: string; medium: string; landingPage: string; campaign: string; sessions: number; engagedSessions: number; keyEvents: number }>();
      for (const r of rows) {
        const [d = "", source = "", medium = "", landing = "", campaign = ""] = r.d;
        const date = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
        const key = [date, source, medium, landing, campaign].join("\u0000");
        const cur = agg.get(key) ?? { date, source: source.slice(0, 300), medium: medium.slice(0, 100), landingPage: landing.slice(0, 2000), campaign: campaign.slice(0, 300), sessions: 0, engagedSessions: 0, keyEvents: 0 };
        cur.sessions += r.m[0] ?? 0;
        cur.engagedSessions += r.m[1] ?? 0;
        cur.keyEvents += r.m[2] ?? 0;
        agg.set(key, cur);
      }
      await t(async (tx) => {
        await tx.delete(ga4Daily).where(and(eq(ga4Daily.websiteId, websiteId), sql`${ga4Daily.date} between ${w.start} and ${w.end}`));
        await insertChunks(tx, ga4Daily, [...agg.values()].map((r) => ({ organizationId: org, websiteId, ...r })));
        const cursor =
          w.direction === "forward"
            ? { ga4SyncedThrough: w.end, ga4SyncedFrom: g!.ga4SyncedFrom && g!.ga4SyncedFrom < w.start ? g!.ga4SyncedFrom : w.start }
            : { ga4SyncedFrom: w.start };
        [g] = await tx
          .update(websiteGoogle)
          .set({ ...cursor, ga4LastSyncAt: new Date(), ga4Error: null, updatedAt: new Date() })
          .where(eq(websiteGoogle.websiteId, websiteId))
          .returning();
      });
      if (!g) return { done: true };
    }
    return { done: true };
  };
}

/* ─────────────────────────────── Dashboards ────────────────────────────── */

export const RANGES = { "7d": 7, "28d": 28, "3m": 91, "6m": 182, "12m": 365, "16m": GSC_BACKFILL_DAYS } as const;
export type RangeKey = keyof typeof RANGES;
export const parseRange = (v: unknown): RangeKey => (typeof v === "string" && v in RANGES ? (v as RangeKey) : "28d");

export interface Totals {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface SearchPerformance {
  hasData: boolean;
  range: { start: string; end: string; days: number };
  totals: Totals;
  previous: Totals | null;
  series: ({ date: string } & Totals)[];
  queries: ({ key: string } & Totals)[];
  pages: ({ key: string } & Totals)[];
  devices: ({ key: string } & Totals)[];
  countries: ({ key: string } & Totals)[];
}

const totalsSql = sql`coalesce(sum(clicks), 0)::int as clicks, coalesce(sum(impressions), 0)::int as impressions,
  coalesce(sum(position * impressions) / nullif(sum(impressions), 0), 0)::float8 as position`;
type TotalsRow = { clicks: number; impressions: number; position: number };
const withCtr = <T extends TotalsRow>(r: T): T & { ctr: number } => ({ ...r, ctr: r.impressions ? r.clicks / r.impressions : 0 });

export async function searchPerformance(db: Db, actor: Actor, access: WorkspaceAccess, websiteId: string, range: RangeKey = "28d"): Promise<SearchPerformance> {
  assertId(websiteId, "Website");
  return inWorkspace(db, actor, access, async (tx) => {
    const [last] = (await tx.execute<{ d: string | null }>(sql`select max(date)::text as d from gsc_site_daily where website_id = ${websiteId}`)).rows;
    const days = RANGES[range];
    const end = last?.d ?? isoDate(new Date(Date.now() - 3 * DAY));
    const start = addDays(end, 1 - days);
    const prevEnd = addDays(start, -1);
    const prevStart = addDays(prevEnd, 1 - days);
    const empty = { clicks: 0, impressions: 0, ctr: 0, position: 0 };
    if (!last?.d)
      return { hasData: false, range: { start, end, days }, totals: empty, previous: null, series: [], queries: [], pages: [], devices: [], countries: [] };

    const q = <T>(s: ReturnType<typeof sql>) => tx.execute<T & Record<string, unknown>>(s).then((r) => r.rows as T[]);
    const [cur] = await q<TotalsRow>(sql`select ${totalsSql} from gsc_site_daily where website_id = ${websiteId} and date between ${start} and ${end}`);
    const [prev] = await q<TotalsRow & { n: number }>(
      sql`select ${totalsSql}, count(*)::int as n from gsc_site_daily where website_id = ${websiteId} and date between ${prevStart} and ${prevEnd}`
    );
    const series = await q<{ date: string } & TotalsRow>(
      sql`select date::text as date, clicks, impressions, position::float8 as position from gsc_site_daily where website_id = ${websiteId} and date between ${start} and ${end} order by date`
    );
    const top = (col: "query" | "page") =>
      q<{ key: string } & TotalsRow>(sql`select ${sql.raw(col)} as key, ${totalsSql} from gsc_daily
        where website_id = ${websiteId} and date between ${start} and ${end}
        group by ${sql.raw(col)} order by sum(clicks) desc, sum(impressions) desc limit 100`);
    const dims = (d: "device" | "country", limit: number) =>
      q<{ key: string } & TotalsRow>(sql`select value as key, ${totalsSql} from gsc_dim_daily
        where website_id = ${websiteId} and dimension = ${d} and date between ${start} and ${end}
        group by value order by sum(clicks) desc, sum(impressions) desc limit ${limit}::int`);
    const [queries, pages, devices, countries] = await Promise.all([top("query"), top("page"), dims("device", 5), dims("country", 10)]);
    return {
      hasData: true,
      range: { start, end, days },
      totals: withCtr(cur!),
      previous: prev && prev.n > 0 ? withCtr(prev) : null,
      series: series.map(withCtr),
      queries: queries.map(withCtr),
      pages: pages.map(withCtr),
      devices: devices.map(withCtr),
      countries: countries.map(withCtr)
    };
  });
}

export interface TrafficTotals {
  sessions: number;
  engagedSessions: number;
  keyEvents: number;
}

export interface TrafficOverview {
  hasData: boolean;
  range: { start: string; end: string; days: number };
  totals: TrafficTotals;
  previous: TrafficTotals | null;
  series: ({ date: string } & TrafficTotals)[];
  channels: ({ key: string } & TrafficTotals)[];
  landingPages: ({ key: string } & TrafficTotals)[];
  referrers: ({ key: string } & TrafficTotals)[];
}

const trafficSql = sql`coalesce(sum(sessions), 0)::int as "sessions", coalesce(sum(engaged_sessions), 0)::int as "engagedSessions",
  coalesce(sum(key_events), 0)::float8 as "keyEvents"`;

export async function trafficOverview(db: Db, actor: Actor, access: WorkspaceAccess, websiteId: string, range: RangeKey = "28d"): Promise<TrafficOverview> {
  assertId(websiteId, "Website");
  return inWorkspace(db, actor, access, async (tx) => {
    const [last] = (await tx.execute<{ d: string | null }>(sql`select max(date)::text as d from ga4_daily where website_id = ${websiteId}`)).rows;
    const days = Math.min(RANGES[range], GA4_BACKFILL_DAYS * 6);
    const end = last?.d ?? isoDate(new Date(Date.now() - DAY));
    const start = addDays(end, 1 - days);
    const prevEnd = addDays(start, -1);
    const prevStart = addDays(prevEnd, 1 - days);
    const zero = { sessions: 0, engagedSessions: 0, keyEvents: 0 };
    if (!last?.d) return { hasData: false, range: { start, end, days }, totals: zero, previous: null, series: [], channels: [], landingPages: [], referrers: [] };
    const q = <T>(s: ReturnType<typeof sql>) => tx.execute<T & Record<string, unknown>>(s).then((r) => r.rows as T[]);
    const where = (a: string, b: string) => sql`website_id = ${websiteId} and date between ${a} and ${b}`;
    const [cur] = await q<TrafficTotals>(sql`select ${trafficSql} from ga4_daily where ${where(start, end)}`);
    const [prev] = await q<TrafficTotals & { n: number }>(sql`select ${trafficSql}, count(*)::int as n from ga4_daily where ${where(prevStart, prevEnd)}`);
    const series = await q<{ date: string } & TrafficTotals>(sql`select date::text as date, ${trafficSql} from ga4_daily where ${where(start, end)} group by date order by date`);
    const channels = await q<{ key: string } & TrafficTotals>(
      sql`select source || ' / ' || medium as key, ${trafficSql} from ga4_daily where ${where(start, end)} group by source, medium order by sum(sessions) desc limit 15`
    );
    const landingPages = await q<{ key: string } & TrafficTotals>(
      sql`select landing_page as key, ${trafficSql} from ga4_daily where ${where(start, end)} group by landing_page order by sum(sessions) desc limit 25`
    );
    const referrers = await q<{ key: string } & TrafficTotals>(
      sql`select source as key, ${trafficSql} from ga4_daily where ${where(start, end)} and medium = 'referral' group by source order by sum(sessions) desc limit 25`
    );
    return { hasData: true, range: { start, end, days }, totals: cur!, previous: prev && prev.n > 0 ? prev : null, series, channels, landingPages, referrers };
  });
}

/** Clicks over the last 28 days of data vs the 28 before, per visible website. */
export async function workspaceSearchSummary(db: Db, actor: Actor, access: WorkspaceAccess) {
  return inWorkspace(db, actor, access, async (tx) => {
    const r = await tx.execute<{ website_id: string; clicks: number; prev: number; impressions: number }>(sql`
      with last as (select website_id, max(date) as d from gsc_site_daily group by website_id)
      select g.website_id,
        coalesce(sum(g.clicks) filter (where g.date > l.d - 28), 0)::int as clicks,
        coalesce(sum(g.impressions) filter (where g.date > l.d - 28), 0)::int as impressions,
        coalesce(sum(g.clicks) filter (where g.date <= l.d - 28 and g.date > l.d - 56), 0)::int as prev
      from gsc_site_daily g join last l on l.website_id = g.website_id
      where g.date > l.d - 56
      group by g.website_id`);
    return new Map(r.rows.map((x) => [x.website_id, { clicks: x.clicks, prevClicks: x.prev, impressions: x.impressions }]));
  });
}

/** Re-checks Search Console ownership for websites verified through GSC (used by the weekly re-check). */
export async function gscStillOwned(appDb: Db, organizationId: string, websiteId: string, deps: GoogleDeps = defaultGoogleDeps): Promise<string | null> {
  const t = <T>(fn: (tx: Tx) => Promise<T>) => withContext(appDb, { organizationId }, fn);
  const [g] = await t((tx) => tx.select().from(websiteGoogle).where(eq(websiteGoogle.websiteId, websiteId)));
  if (!g?.gscProperty) return "The website is no longer linked to a Search Console property.";
  try {
    const token = await workspaceGoogleToken(t, organizationId, deps);
    const sites = await listGscSites(token, deps);
    const s = sites.find((x) => x.siteUrl === g.gscProperty);
    return s && OWNER_LEVELS.includes(s.permissionLevel) ? null : "The connected Google account is no longer an owner of the Search Console property.";
  } catch (e) {
    if (e instanceof GoogleAuthError) return e.message;
    if (e instanceof GoogleApiError && !e.transient) return `Search Console error: ${e.message}`;
    throw e; // transient: the job retries
  }
}
