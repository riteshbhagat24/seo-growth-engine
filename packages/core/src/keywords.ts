import { and, eq, inArray, schema, sql, type Db, type Tx } from "@sge/db";
import type { Keyword } from "@sge/db/schema";
import { audit } from "./audit";
import { assertId, assertIds, inWorkspace, requireAction, type Actor, type WorkspaceAccess } from "./context";
import { AppError } from "./errors";
import { assertWithinLimit } from "./plans";
import { addDays } from "./searchdata";

const { keywords, websites } = schema;

export const INTENTS = ["informational", "navigational", "commercial", "transactional"] as const;
export type Intent = (typeof INTENTS)[number];
export const KEYWORD_IMPORT_MAX = 5000;

const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const normKeyword = (s: string) => clean(s).slice(0, 200);
const normTags = (v: string | string[] | undefined) =>
  [...new Set((Array.isArray(v) ? v : (v ?? "").split(/[,;|]/)).map((t) => clean(t).toLowerCase().slice(0, 40)).filter(Boolean))].slice(0, 20);
const normIntent = (v: string | undefined | null): Intent | null => {
  const x = (v ?? "").trim().toLowerCase();
  if (!x) return null;
  const hit = INTENTS.find((i) => i === x || i.startsWith(x.slice(0, 4)));
  return hit ?? null;
};
const normInt = (v: string | number | undefined | null, max: number): number | null => {
  if (v === undefined || v === null || v === "") return null;
  const n = Math.round(Number(String(v).replace(/[, ]/g, "")));
  return Number.isFinite(n) && n >= 0 && n <= max ? n : null;
};

export interface KeywordInput {
  keyword: string;
  groupName?: string | null;
  tags?: string[] | string;
  targetUrl?: string | null;
  intent?: string | null;
  volume?: number | string | null;
  difficulty?: number | string | null;
}

function normTarget(url: string | null | undefined, domain: string): string | null {
  const v = (url ?? "").trim();
  if (!v) return null;
  try {
    const u = new URL(v.startsWith("/") ? `https://${domain}${v}` : v);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const h = u.hostname.replace(/^www\./, "");
    return h === domain.replace(/^www\./, "") || h.endsWith(`.${domain}`) ? u.toString().slice(0, 2000) : null;
  } catch {
    return null;
  }
}

async function visibleWebsite(tx: Tx, websiteId: string) {
  const [w] = await tx.select().from(websites).where(eq(websites.id, websiteId));
  if (!w) throw new AppError("not_found", "Website not found");
  return w;
}

/**
 * Adds keywords (skipping ones already tracked). Volume/difficulty are stored
 * only with a source label, never invented.
 */
export async function addKeywords(
  db: Db,
  actor: Actor,
  access: WorkspaceAccess,
  websiteId: string,
  inputs: KeywordInput[],
  opts: { source?: string | null } = {}
): Promise<{ added: number; updated: number; skipped: number }> {
  assertId(websiteId, "Website");
  if (inputs.length === 0) throw new AppError("invalid_input", "Enter at least one keyword");
  if (inputs.length > KEYWORD_IMPORT_MAX) throw new AppError("invalid_input", `Import at most ${KEYWORD_IMPORT_MAX} keywords at a time`);
  const source = opts.source ? clean(opts.source).slice(0, 60) : null;
  const hasMetrics = inputs.some((i) => normInt(i.volume, 1e9) !== null || normInt(i.difficulty, 100) !== null);
  if (hasMetrics && !source) throw new AppError("invalid_input", "Say where the volume / difficulty numbers come from (e.g. \"Ahrefs export, Nov 2026\")");

  return inWorkspace(db, actor, access, async (tx, { role }) => {
    requireAction(role, "work.run");
    const w = await visibleWebsite(tx, websiteId);
    // De-duplicate the input itself (case-insensitive), keeping the first.
    const seen = new Map<string, KeywordInput & { keyword: string }>();
    for (const i of inputs) {
      const k = normKeyword(i.keyword ?? "");
      if (k.length < 1 || seen.has(k.toLowerCase())) continue;
      seen.set(k.toLowerCase(), { ...i, keyword: k });
    }
    const rows = [...seen.values()];
    const existing = rows.length
      ? await tx
          .select({ id: keywords.id, lower: sql<string>`lower(${keywords.keyword})` })
          .from(keywords)
          .where(and(eq(keywords.websiteId, websiteId), inArray(sql`lower(${keywords.keyword})`, rows.map((r) => r.keyword.toLowerCase()))))
      : [];
    const existingBy = new Map(existing.map((e) => [e.lower, e.id]));
    const fresh = rows.filter((r) => !existingBy.has(r.keyword.toLowerCase()));
    if (fresh.length) await assertWithinLimit(tx, access.workspace.id, "keywords", fresh.length);

    const toValues = (r: (typeof rows)[number]) => {
      const volume = normInt(r.volume, 1e9);
      const difficulty = normInt(r.difficulty, 100);
      return {
        groupName: r.groupName ? clean(r.groupName).slice(0, 80) : null,
        tags: normTags(r.tags),
        targetUrl: normTarget(r.targetUrl, w.domain),
        intent: normIntent(r.intent),
        volume,
        volumeSource: volume !== null ? source : null,
        difficulty,
        difficultySource: difficulty !== null ? source : null
      };
    };
    for (let i = 0; i < fresh.length; i += 500)
      await tx
        .insert(keywords)
        .values(fresh.slice(i, i + 500).map((r) => ({ organizationId: access.workspace.id, websiteId, keyword: r.keyword, createdByUserId: actor.userId, ...toValues(r) })))
        .onConflictDoNothing();
    // Existing keywords: fill in only the fields the import provides.
    let updated = 0;
    for (const r of rows.filter((x) => existingBy.has(x.keyword.toLowerCase()))) {
      const v = toValues(r);
      const patch = Object.fromEntries(
        Object.entries(v).filter(([k, val]) => val !== null && !(Array.isArray(val) && val.length === 0) && !(k.endsWith("Source") && val === null))
      );
      if (Object.keys(patch).length) {
        await tx.update(keywords).set({ ...patch, updatedAt: new Date() }).where(eq(keywords.id, existingBy.get(r.keyword.toLowerCase())!));
        updated++;
      }
    }
    await audit(tx, {
      organizationId: access.workspace.id,
      actorUserId: actor.userId,
      action: "keywords.added",
      entityType: "website",
      entityId: websiteId,
      metadata: { added: fresh.length, updated, source },
      ip: actor.ip,
      userAgent: actor.userAgent
    });
    return { added: fresh.length, updated, skipped: inputs.length - fresh.length - updated };
  });
}

export async function updateKeyword(
  db: Db,
  actor: Actor,
  access: WorkspaceAccess,
  keywordId: string,
  input: { groupName?: string | null; tags?: string[] | string; targetUrl?: string | null; intent?: string | null; notes?: string | null }
): Promise<Keyword> {
  assertId(keywordId, "Keyword");
  return inWorkspace(db, actor, access, async (tx, { role }) => {
    requireAction(role, "work.run");
    const [k] = await tx.select().from(keywords).where(eq(keywords.id, keywordId));
    if (!k) throw new AppError("not_found", "Keyword not found");
    const w = await visibleWebsite(tx, k.websiteId);
    const [saved] = await tx
      .update(keywords)
      .set({
        groupName: input.groupName !== undefined ? (input.groupName ? clean(input.groupName).slice(0, 80) : null) : k.groupName,
        tags: input.tags !== undefined ? normTags(input.tags) : k.tags,
        targetUrl: input.targetUrl !== undefined ? normTarget(input.targetUrl, w.domain) : k.targetUrl,
        intent: input.intent !== undefined ? normIntent(input.intent) : k.intent,
        notes: input.notes !== undefined ? (input.notes ? input.notes.trim().slice(0, 2000) : null) : k.notes,
        updatedAt: new Date()
      })
      .where(eq(keywords.id, keywordId))
      .returning();
    return saved!;
  });
}

export async function deleteKeywords(db: Db, actor: Actor, access: WorkspaceAccess, websiteId: string, ids: string[]): Promise<number> {
  assertId(websiteId, "Website");
  assertIds(ids, "Keyword");
  if (!ids.length) return 0;
  return inWorkspace(db, actor, access, async (tx, { role }) => {
    requireAction(role, "work.run");
    const r = await tx.delete(keywords).where(and(eq(keywords.websiteId, websiteId), inArray(keywords.id, ids))).returning({ id: keywords.id });
    await audit(tx, {
      organizationId: access.workspace.id,
      actorUserId: actor.userId,
      action: "keywords.deleted",
      entityType: "website",
      entityId: websiteId,
      metadata: { count: r.length },
      ip: actor.ip,
      userAgent: actor.userAgent
    });
    return r.length;
  });
}

/* ───────────────────────────── CSV import ──────────────────────────────── */

/** RFC 4180 parser (quotes, escaped quotes, CRLF), with delimiter sniffing for , ; and tab. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const delim = [",", ";", "\t"].map((d) => [d, firstLine.split(d).length] as const).sort((a, b) => b[1] - a[1])[0]![0];
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === delim) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((x) => x.trim() !== "")) rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== "")) rows.push(row);
  return rows;
}

const HEADERS: Record<keyof KeywordInput, RegExp> = {
  keyword: /^(keyword|keywords|query|top queries|search term|term|phrase)$/i,
  groupName: /^(group|keyword group|category|cluster|parent topic)$/i,
  tags: /^(tags?|labels?)$/i,
  targetUrl: /^(target url|url|landing page|current url|page)$/i,
  intent: /^(intent|search intent)$/i,
  volume: /^(volume|search volume|avg\.? monthly searches|monthly volume|sv)$/i,
  difficulty: /^(difficulty|kd|keyword difficulty|kd ?%|competition)$/i
};

/** Maps a CSV export (Ahrefs, Semrush, GSC, Keyword Planner, plain list) to keyword inputs. */
export function keywordsFromCsv(text: string): { inputs: KeywordInput[]; columns: string[] } {
  const rows = parseCsv(text);
  if (!rows.length) throw new AppError("invalid_input", "The file is empty");
  const header = rows[0]!.map((h) => h.trim());
  const col = Object.fromEntries(Object.entries(HEADERS).map(([k, re]) => [k, header.findIndex((h) => re.test(h))])) as Record<keyof KeywordInput, number>;
  // No recognised header: treat the first column as keywords, no header row.
  const body = col.keyword === -1 ? rows : rows.slice(1);
  if (col.keyword === -1) col.keyword = 0;
  if (body.length > KEYWORD_IMPORT_MAX) throw new AppError("invalid_input", `The file has ${body.length} rows; import at most ${KEYWORD_IMPORT_MAX} at a time`);
  const at = (r: string[], k: keyof KeywordInput) => (col[k] >= 0 ? (r[col[k]] ?? "").trim() : undefined);
  const inputs = body
    .map((r) => ({
      keyword: at(r, "keyword") ?? "",
      groupName: at(r, "groupName") || null,
      tags: at(r, "tags"),
      targetUrl: at(r, "targetUrl") || null,
      intent: at(r, "intent") || null,
      volume: at(r, "volume") || null,
      difficulty: at(r, "difficulty") || null
    }))
    .filter((i) => i.keyword);
  return { inputs, columns: (Object.keys(col) as (keyof KeywordInput)[]).filter((k) => col[k] >= 0 && header.length > 1) };
}

/* ───────────────────────────── Reading ─────────────────────────────────── */

export interface KeywordRow extends Keyword {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number | null;
  prevPosition: number | null;
  /** Page that got the most clicks/impressions for this keyword. */
  rankingPage: string | null;
}

export interface KeywordList {
  rows: KeywordRow[];
  groups: string[];
  period: { start: string; end: string } | null;
}

/** Tracked keywords with Search Console metrics for the last 28 days of data vs the 28 before. */
export async function listKeywords(
  db: Db,
  actor: Actor,
  access: WorkspaceAccess,
  websiteId: string,
  opts: { group?: string | null; q?: string | null } = {}
): Promise<KeywordList> {
  assertId(websiteId, "Website");
  return inWorkspace(db, actor, access, async (tx) => {
    const [last] = (await tx.execute<{ d: string | null }>(sql`select max(date)::text as d from gsc_daily where website_id = ${websiteId}`)).rows;
    const end = last?.d ?? null;
    const start = end ? addDays(end, -27) : null;
    const prevStart = end ? addDays(end, -55) : null;
    const q = opts.q ? `%${opts.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null;
    const r = await tx.execute<Keyword & Record<string, unknown>>(sql`
      with m as (
        select lower(query) as kw,
          sum(clicks) filter (where date >= ${start}) as clicks,
          sum(impressions) filter (where date >= ${start}) as impressions,
          sum(position * impressions) filter (where date >= ${start}) / nullif(sum(impressions) filter (where date >= ${start}), 0) as position,
          sum(position * impressions) filter (where date < ${start}) / nullif(sum(impressions) filter (where date < ${start}), 0) as prev_position
        from gsc_daily
        where website_id = ${websiteId} and date >= ${prevStart}
          and lower(query) in (select lower(keyword) from keywords where website_id = ${websiteId})
        group by lower(query)
      ), p as (
        select distinct on (lower(query)) lower(query) as kw, page
        from gsc_daily where website_id = ${websiteId} and date >= ${start}
          and lower(query) in (select lower(keyword) from keywords where website_id = ${websiteId})
        group by lower(query), page order by lower(query), sum(clicks) desc, sum(impressions) desc
      )
      select k.id, k.organization_id as "organizationId", k.website_id as "websiteId", k.keyword, k.group_name as "groupName", k.tags,
        k.target_url as "targetUrl", k.intent, k.volume, k.volume_source as "volumeSource", k.difficulty, k.difficulty_source as "difficultySource",
        k.notes, k.created_by_user_id as "createdByUserId", k.created_at as "createdAt", k.updated_at as "updatedAt",
        coalesce(m.clicks, 0)::int as clicks, coalesce(m.impressions, 0)::int as impressions,
        m.position::float8 as position, m.prev_position::float8 as "prevPosition", p.page as "rankingPage"
      from keywords k
      left join m on m.kw = lower(k.keyword)
      left join p on p.kw = lower(k.keyword)
      where k.website_id = ${websiteId}
        ${opts.group ? sql`and k.group_name = ${opts.group}` : sql``}
        ${q ? sql`and k.keyword ilike ${q}` : sql``}
      order by coalesce(m.impressions, 0) desc, k.keyword
      limit 5000`);
    const groups = await tx.execute<{ g: string }>(
      sql`select distinct group_name as g from keywords where website_id = ${websiteId} and group_name is not null order by 1`
    );
    const rows = r.rows.map((x) => {
      const row = x as unknown as KeywordRow;
      return { ...row, createdAt: new Date(row.createdAt), updatedAt: new Date(row.updatedAt), ctr: row.impressions ? row.clicks / row.impressions : 0 };
    });
    return { rows, groups: groups.rows.map((g) => g.g), period: end && start ? { start, end } : null };
  });
}

/** Search Console queries with impressions in the last 28 days of data that aren't tracked yet. */
export async function keywordSuggestions(db: Db, actor: Actor, access: WorkspaceAccess, websiteId: string, limit = 50) {
  assertId(websiteId, "Website");
  return inWorkspace(db, actor, access, async (tx) => {
    const r = await tx.execute<{ query: string; clicks: number; impressions: number; position: number }>(sql`
      with last as (select max(date) as d from gsc_daily where website_id = ${websiteId})
      select min(query) as query, sum(clicks)::int as clicks, sum(impressions)::int as impressions,
        (sum(position * impressions) / nullif(sum(impressions), 0))::float8 as position
      from gsc_daily, last
      where website_id = ${websiteId} and date > last.d - 28
        and lower(query) not in (select lower(keyword) from keywords where website_id = ${websiteId})
      group by lower(query)
      order by sum(impressions) desc
      limit ${Math.min(limit, 200)}::int`);
    return r.rows;
  });
}

/** Weekly average position and clicks for one keyword over all synced data. */
export async function keywordHistory(db: Db, actor: Actor, access: WorkspaceAccess, keywordId: string) {
  assertId(keywordId, "Keyword");
  return inWorkspace(db, actor, access, async (tx) => {
    const [k] = await tx.select().from(keywords).where(eq(keywords.id, keywordId));
    if (!k) throw new AppError("not_found", "Keyword not found");
    const r = await tx.execute<{ week: string; clicks: number; impressions: number; position: number | null }>(sql`
      select date_trunc('week', date)::date::text as week, sum(clicks)::int as clicks, sum(impressions)::int as impressions,
        (sum(position * impressions) / nullif(sum(impressions), 0))::float8 as position
      from gsc_daily where website_id = ${k.websiteId} and lower(query) = lower(${k.keyword})
      group by 1 order by 1`);
    const pages = await tx.execute<{ page: string; clicks: number; impressions: number }>(sql`
      select page, sum(clicks)::int as clicks, sum(impressions)::int as impressions from gsc_daily
      where website_id = ${k.websiteId} and lower(query) = lower(${k.keyword}) and date > (select max(date) from gsc_daily where website_id = ${k.websiteId}) - 90
      group by page order by sum(clicks) desc, sum(impressions) desc limit 10`);
    return { keyword: k, weeks: r.rows, pages: pages.rows };
  });
}


/** Tracked keyword count per visible website. */
export async function keywordCounts(db: Db, actor: Actor, access: WorkspaceAccess): Promise<Map<string, number>> {
  return inWorkspace(db, actor, access, async (tx) => {
    const r = await tx.execute<{ website_id: string; n: number }>(sql`select website_id, count(*)::int as n from keywords group by website_id`);
    return new Map(r.rows.map((x) => [x.website_id, x.n]));
  });
}
