/**
 * Opportunity Discovery Engine.
 *
 * Sources: curated database (backlink_sources), user-provided URLs, CSV imports, competitor backlink CSV
 * exports, site expansion (finding submission/resource/write-for-us pages on a prospect's own site, robots
 * respected) and search-query templates for MANUAL research. Search-engine result pages are never fetched.
 *
 * Every opportunity stores discovery method, source, date and evidence. Domains and URLs are de-duplicated.
 */
import { parseCsv } from "@sge/core";
import type { SqlTx as Tx } from "../sql";
import { domainOf, normalizeUrl, tryParseUrl } from "../net/url";
import { COUNTRIES, countryName, industryDef } from "./taxonomy";

export type OpportunityType =
  | "business_listing"
  | "industry_directory"
  | "agency_directory"
  | "startup_directory"
  | "resource_page"
  | "guest_post"
  | "association"
  | "partner"
  | "review_platform"
  | "other";

export type DiscoveryMethod =
  | "curated_database"
  | "user_url"
  | "csv_import"
  | "competitor_csv"
  | "site_expansion"
  | "search_template_manual"
  | "permitted_api"
  | "recovery";

export interface Candidate {
  url: string;
  type?: OpportunityType;
  method: DiscoveryMethod;
  source: string;
  evidence?: Record<string, unknown>;
  sourceId?: string | null;
  adapterKey?: string | null;
}

export interface CampaignCtx {
  id: string;
  organization_id: string;
  website_id: string;
  industry: string;
  target_countries: string[];
  target_keywords: string[];
  preferred_categories: string[];
  website_domain: string;
  excluded_domains: string[];
}

export async function loadCampaignCtx(tx: Tx, campaignId: string): Promise<CampaignCtx> {
  return tx.one<CampaignCtx>(
    `select c.id, c.organization_id, c.website_id, c.industry, c.target_countries, c.target_keywords, c.preferred_categories,
            w.domain as website_domain, coalesce(s.excluded_domains, '{}') as excluded_domains
       from backlink_campaigns c
       join websites w on w.id = c.website_id
       left join backlink_campaign_settings s on s.campaign_id = c.id
      where c.id = $1`,
    [campaignId]
  );
}

const TYPE_PATTERNS: [OpportunityType, RegExp][] = [
  ["guest_post", /(write-for-us|write_for_us|guest-?post|contribute|contributor|submit-(an-)?article|guest-?author)/i],
  ["resource_page", /(resources?|useful-?links|links|recommended|tools)(\/|$|\.)/i],
  ["partner", /(partners?|partnership|affiliates?)(\/|$|\.)/i],
  ["association", /(members?|membership|associat|chamber)/i],
  ["industry_directory", /(submit|add-?(your-?)?(listing|business|site|company)|list-?your|suggest-?(a-)?site|get-?listed|directory)/i],
  ["review_platform", /(reviews?|ratings?)(\/|$|\.)/i]
];

export function inferType(url: string, hint = ""): OpportunityType {
  // Test the URL and the hint separately so end-anchored patterns (e.g. "/resources$") work.
  for (const [t, re] of TYPE_PATTERNS) if (re.test(url.trim()) || (hint.trim() && re.test(hint.trim()))) return t;
  return "other";
}

export function defaultAdapterFor(type: OpportunityType): string {
  return ["guest_post", "resource_page", "partner"].includes(type) ? "outreach-email" : "manual-editorial";
}

async function isExcluded(tx: Tx, ctx: CampaignCtx, domain: string, url: string): Promise<string | null> {
  if (domain === ctx.website_domain) return "own website";
  if (ctx.excluded_domains.map((d) => d.toLowerCase()).includes(domain)) return "campaign excluded domain";
  const row = await tx.maybe<{ reason: string | null; kind: string }>(
    `select kind, reason from backlink_exclusions
      where (website_id is null or website_id = $1) and (campaign_id is null or campaign_id = $2)
        and ((kind = 'domain' and lower(value) = $3) or (kind = 'url' and lower(value) = lower($4)))
      limit 1`,
    [ctx.website_id, ctx.id, domain, url]
  );
  return row ? `excluded ${row.kind}${row.reason ? `: ${row.reason}` : ""}` : null;
}

export interface IngestResult {
  created: number;
  duplicates: number;
  excluded: number;
  invalid: number;
  prospectIds: string[];
  opportunityIds: string[];
}

/** De-duplicating ingest of discovery candidates into prospects + opportunities. */
export async function ingestCandidates(tx: Tx, ctx: CampaignCtx, candidates: Candidate[]): Promise<IngestResult> {
  const res: IngestResult = { created: 0, duplicates: 0, excluded: 0, invalid: 0, prospectIds: [], opportunityIds: [] };
  const prospects = new Set<string>();
  for (const c of candidates) {
    let url: string, norm: string, domain: string;
    try {
      const parsed = tryParseUrl(c.url);
      if (!parsed || !/^https?:$/.test(parsed.protocol)) throw new Error("invalid");
      url = parsed.toString();
      norm = normalizeUrl(url);
      domain = domainOf(url);
    } catch {
      res.invalid++;
      continue;
    }
    // A registered source (org-specific first, then curated) is authoritative for its domain: it decides how a
    // link is obtained there (type + adapter), whatever page on that domain was discovered.
    const known = c.sourceId
      ? await tx.maybe<{ id: string; adapter_key: string; source_type: OpportunityType }>(
          `select id, adapter_key, source_type from backlink_sources where id = $1`,
          [c.sourceId]
        )
      : await tx.maybe<{ id: string; adapter_key: string; source_type: OpportunityType }>(
          `select id, adapter_key, source_type from backlink_sources where domain = $1 order by organization_id nulls last limit 1`,
          [domain]
        );
    const type = known?.source_type ?? c.type ?? inferType(url);
    const adapterKey = c.adapterKey ?? known?.adapter_key ?? defaultAdapterFor(type);
    const excludedReason = await isExcluded(tx, ctx, domain, url);
    const homepage = `${new URL(url).origin}/`;
    const prospect = await tx.one<{ id: string }>(
      `insert into backlink_prospects (organization_id, website_id, domain, homepage_url, status)
       values ($1, $2, $3, $4, $5)
       on conflict (organization_id, website_id, domain) do update set homepage_url = backlink_prospects.homepage_url
       returning id`,
      [ctx.organization_id, ctx.website_id, domain, homepage, excludedReason ? "excluded" : "new"]
    );
    const opp = await tx.maybe<{ id: string }>(
      `insert into backlink_opportunities
         (organization_id, website_id, campaign_id, prospect_id, source_id, url, url_normalized, opportunity_type, adapter_key,
          discovery_method, discovery_source, discovery_evidence, status, reject_reasons)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       on conflict (campaign_id, url_normalized) do nothing
       returning id`,
      [
        ctx.organization_id,
        ctx.website_id,
        ctx.id,
        prospect.id,
        known?.id ?? null,
        url,
        norm,
        type,
        adapterKey,
        c.method,
        c.source,
        JSON.stringify({ ...(c.evidence ?? {}), discovered_at: new Date().toISOString() }),
        excludedReason ? "EXCLUDED" : "DISCOVERED",
        excludedReason ? [excludedReason] : []
      ]
    );
    if (!opp) {
      res.duplicates++;
      continue;
    }
    if (excludedReason) res.excluded++;
    else {
      res.created++;
      prospects.add(prospect.id);
    }
    res.opportunityIds.push(opp.id);
  }
  res.prospectIds = [...prospects];
  return res;
}

/** Curated database: sources matching industry, target countries and preferred categories. */
export async function curatedCandidates(tx: Tx, ctx: CampaignCtx, limit = 100): Promise<Candidate[]> {
  const ind = industryDef(ctx.industry);
  const categories = ctx.preferred_categories.length ? ctx.preferred_categories : ind.categories;
  const rows = await tx.q<{
    id: string;
    domain: string;
    name: string;
    source_type: OpportunityType;
    homepage_url: string;
    submission_url: string | null;
    adapter_key: string;
    industries: string[];
    countries: string[];
    organization_id: string | null;
  }>(
    `select id, domain, name, source_type, homepage_url, submission_url, adapter_key, industries, countries, organization_id
       from backlink_sources
      where curation_status <> 'retired'
        and (cardinality(industries) = 0 or $1 = any(industries))
        and (cardinality(countries) = 0 or countries && $2::text[] or cardinality($2::text[]) = 0)
        and source_type = any($3::text[])
      order by organization_id nulls last, cardinality(industries) desc, cardinality(countries) desc, name
      limit $4`,
    [ctx.industry, ctx.target_countries, categories, limit]
  );
  return rows.map((r) => ({
    url: r.submission_url ?? r.homepage_url,
    type: r.source_type,
    method: "curated_database" as const,
    source: r.organization_id ? `organisation source: ${r.name}` : `curated database: ${r.name}`,
    sourceId: r.id,
    adapterKey: r.adapter_key,
    evidence: {
      source_id: r.id,
      matched_industry: r.industries.length ? ctx.industry : "all industries",
      matched_countries: r.countries.length ? r.countries.filter((c) => ctx.target_countries.includes(c)) : "global",
      category: r.source_type
    }
  }));
}

export function userUrlCandidates(urls: string[], note = "user provided"): Candidate[] {
  return urls.map((u) => ({ url: u, method: "user_url" as const, source: note, evidence: { provided_url: u } }));
}

const URL_COLUMNS = ["url", "urls", "link", "website", "page", "page url", "domain"];
const COMPETITOR_SOURCE_COLUMNS = [
  "referring page url", // Ahrefs
  "source url", // Semrush / generic
  "source page",
  "linking page",
  "url from",
  "from url",
  "referring page",
  "backlink url",
  "source"
];

function pickColumn(headers: string[], candidates: string[]): string | null {
  const lower = headers.map((h) => h.trim().toLowerCase().replace(/^﻿/, ""));
  for (const c of candidates) {
    const i = lower.indexOf(c);
    if (i >= 0) return headers[i]!;
  }
  return null;
}

/** Rows as header -> value records (RFC 4180, `,` `;` or tab, BOM-tolerant: the keywords importer's parser). */
function readCsv(text: string): Record<string, string>[] {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const headers = rows[0]!.map((h) => h.trim());
  return rows.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? "").trim()])));
}

/** Generic CSV import: a url column plus optional type / notes. */
export function csvCandidates(csvText: string, fileName = "upload.csv"): { candidates: Candidate[]; errors: string[] } {
  const rows = readCsv(csvText);
  if (!rows.length) return { candidates: [], errors: ["CSV has no rows"] };
  const headers = Object.keys(rows[0]!);
  const col = pickColumn(headers, URL_COLUMNS);
  if (!col) return { candidates: [], errors: [`No URL column found (expected one of: ${URL_COLUMNS.join(", ")})`] };
  const typeCol = pickColumn(headers, ["type", "category", "opportunity type"]);
  const notesCol = pickColumn(headers, ["notes", "note", "comment"]);
  const errors: string[] = [];
  const candidates: Candidate[] = [];
  rows.forEach((r, i) => {
    const v = r[col];
    if (!v || !tryParseUrl(v)) {
      errors.push(`Row ${i + 2}: invalid URL "${v ?? ""}"`);
      return;
    }
    const t = typeCol ? (r[typeCol] ?? "").toLowerCase().replace(/\s+/g, "_") : "";
    candidates.push({
      url: v,
      type:
        TYPE_PATTERNS.some(([k]) => k === t) || t === "business_listing" || t === "startup_directory" || t === "agency_directory"
          ? (t as OpportunityType)
          : undefined,
      method: "csv_import",
      source: `CSV import: ${fileName}`,
      evidence: { file: fileName, row: i + 2, notes: notesCol ? r[notesCol] : undefined }
    });
  });
  return { candidates, errors };
}

/**
 * Competitor backlink CSV (Ahrefs, Semrush, Moz, Search Console "latest links" and similar exports).
 * Pages that already link to a competitor in the same niche are often directories/resource pages that
 * would consider listing us too. Third-party DA/DR columns are ignored deliberately.
 */
export function competitorCsvCandidates(
  csvText: string,
  competitor: string,
  fileName = "competitor.csv"
): { candidates: Candidate[]; errors: string[]; format: string } {
  const rows = readCsv(csvText);
  if (!rows.length) return { candidates: [], errors: ["CSV has no rows"], format: "unknown" };
  const headers = Object.keys(rows[0]!);
  const col = pickColumn(headers, COMPETITOR_SOURCE_COLUMNS);
  if (!col) return { candidates: [], errors: ["Could not find a referring/source page URL column"], format: "unknown" };
  const anchorCol = pickColumn(headers, ["anchor", "anchor text", "link anchor"]);
  const targetCol = pickColumn(headers, ["target url", "target", "url to", "destination url"]);
  const format = col.toLowerCase().startsWith("referring page url") ? "ahrefs" : col.toLowerCase() === "source url" ? "semrush" : "generic";
  const perDomain = new Map<string, number>();
  const candidates: Candidate[] = [];
  const errors: string[] = [];
  rows.forEach((r, i) => {
    const v = r[col];
    const p = v ? tryParseUrl(v) : null;
    if (!p) {
      errors.push(`Row ${i + 2}: invalid URL`);
      return;
    }
    const d = domainOf(p.toString());
    const n = perDomain.get(d) ?? 0;
    if (n >= 2) return; // keep at most two pages per referring domain
    perDomain.set(d, n + 1);
    candidates.push({
      url: p.toString(),
      type: inferType(p.toString(), anchorCol ? r[anchorCol] : ""),
      method: "competitor_csv",
      source: `Competitor backlinks (${competitor}) — ${fileName}`,
      evidence: {
        competitor,
        export_format: format,
        row: i + 2,
        anchor: anchorCol ? r[anchorCol] : undefined,
        competitor_target: targetCol ? r[targetCol] : undefined
      }
    });
  });
  return { candidates, errors, format };
}

const EXPANSION_PATTERNS: [OpportunityType, RegExp][] = [
  [
    "industry_directory",
    /(submit|add|list)[\s-]*(your|a|my)?[\s-]*(site|business|company|listing|link|url|tool|startup|product)|get listed|suggest a (site|link)/i
  ],
  ["guest_post", /write for us|guest post|contribute|become a contributor|submission guidelines|pitch us/i],
  ["resource_page", /^(resources|useful links|links|recommended (sites|tools))$/i],
  ["partner", /become a partner|partner program|partnerships?$/i],
  ["association", /become a member|join (us|the association)|membership/i]
];

/** Site expansion: find submission/resource/contribution pages linked from a prospect's own page. */
export function expansionCandidates(page: { url: string; links: { href: string; text: string; internal: boolean }[] }, max = 3): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const l of page.links) {
    if (!l.internal) continue;
    for (const [type, re] of EXPANSION_PATTERNS) {
      if (re.test(l.text) || re.test(new URL(l.href).pathname.replace(/[-_/]/g, " "))) {
        const n = normalizeUrl(l.href);
        if (seen.has(n)) break;
        seen.add(n);
        out.push({ url: l.href, type, method: "site_expansion", source: `link on ${page.url}`, evidence: { found_on: page.url, link_text: l.text } });
        break;
      }
    }
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Search query templates for MANUAL research (or a permitted search API the user connects).
 * The platform never fetches search-engine result pages.
 */
export function searchQueryTemplates(
  ctx: Pick<CampaignCtx, "industry" | "target_countries" | "target_keywords">
): { purpose: string; query: string }[] {
  const ind = industryDef(ctx.industry);
  const kws = (ctx.target_keywords.length ? ctx.target_keywords : ind.terms.slice(0, 3)).slice(0, 4);
  const countries = ctx.target_countries.length ? ctx.target_countries.map(countryName) : [""];
  const out: { purpose: string; query: string }[] = [];
  for (const kw of kws) {
    out.push({ purpose: "Resource pages", query: `"${kw}" intitle:resources OR intitle:"useful links"` });
    out.push({ purpose: "Guest posts", query: `"${kw}" "write for us" OR "guest post guidelines"` });
    for (const c of countries) {
      out.push({ purpose: "Industry directories", query: `${ind.label} directory ${c} "add your business" OR "submit listing"`.trim() });
      out.push({ purpose: "Associations", query: `${ind.label} association ${c} members directory`.trim() });
    }
  }
  out.push({ purpose: "Partners", query: `"${kws[0]}" "our partners" OR "partner program"` });
  return [...new Map(out.map((o) => [o.query, o])).values()].slice(0, 25);
}

export { COUNTRIES };
