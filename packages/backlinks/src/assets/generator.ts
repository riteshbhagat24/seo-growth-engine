/**
 * Backlink Asset Generator.
 *
 * Builds submission copy ONLY from the approved business profile. No paid LLM is required: generation is
 * template-based with deterministic variation per destination (so copy is unique per site). Every asset is
 * fact-checked: any award, certification, statistic, testimonial, address, phone number, year or superlative
 * that cannot be traced to the approved profile is flagged and blocks unattended use.
 * Guest article drafts are drafts — they are never auto-published on third-party sites.
 */
import crypto from "node:crypto";
import type { SqlTx as Tx } from "../sql";
import { countryName, industryDef } from "../discovery/taxonomy";
import { PermanentError } from "../errors";

export type AssetType =
  | "short_description"
  | "long_description"
  | "company_profile"
  | "founder_bio"
  | "directory_listing"
  | "guest_post_pitch"
  | "article_draft"
  | "resource_request"
  | "partnership_pitch"
  | "outreach_email"
  | "recovery_email";

export interface BusinessProfile {
  id: string;
  website_id: string;
  business_name: string;
  website_url: string;
  industry: string;
  description: string;
  products_services: string[];
  target_countries: string[];
  contact_email: string | null;
  contact_phone: string | null;
  address: Record<string, string> | null;
  social_profiles: Record<string, string>;
  logo_url: string | null;
  brand_descriptions: string[];
  target_landing_pages: { url: string; label?: string }[];
  target_keywords: string[];
  approved_anchor_texts: string[];
  founder: { name: string; title?: string; bio?: string } | null;
  founded_year: number | null;
  verified_facts: string[];
  status: "draft" | "approved";
  version: number;
}

export interface Destination {
  name: string;
  domain: string;
  type: string;
  pageTitle?: string;
  pageUrl?: string;
}

export interface GeneratedAsset {
  type: AssetType;
  title: string | null;
  body: string;
  factCheck: FactCheckResult;
}

export interface FactCheckResult {
  passed: boolean;
  claims: { text: string; kind: string; supported: boolean }[];
  missing: string[];
}

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------
function seedFrom(s: string): number {
  return crypto.createHash("sha256").update(s).digest().readUInt32BE(0);
}

function pick<T>(arr: T[], seed: number, offset = 0): T {
  return arr[(seed + offset) % arr.length]!;
}

function rotate<T>(arr: T[], seed: number): T[] {
  if (!arr.length) return arr;
  const k = seed % arr.length;
  return [...arr.slice(k), ...arr.slice(0, k)];
}

function listJoin(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean);
}

function truncateWords(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  return `${cut.slice(0, cut.lastIndexOf(" ")).replace(/[,;:\-–—]+$/, "")}…`;
}

function countriesPhrase(p: BusinessProfile): string {
  if (!p.target_countries.length) return "";
  return listJoin(p.target_countries.map(countryName));
}

function landing(p: BusinessProfile): string {
  return p.target_landing_pages[0]?.url ?? p.website_url;
}

function signature(p: BusinessProfile): string {
  const who = p.founder?.name
    ? `${p.founder.name}${p.founder.title ? `, ${p.founder.title}` : ""}\n${p.business_name}`
    : `The ${p.business_name} team`;
  return [who, p.website_url, p.contact_email].filter(Boolean).join("\n");
}

const VERBS = ["provides", "offers", "delivers", "specialises in"];

// ---------------------------------------------------------------------------------------------
// templates
// ---------------------------------------------------------------------------------------------
function shortDescription(p: BusinessProfile, seed: number): string {
  const services = rotate(p.products_services, seed).slice(0, 2);
  const variants = [
    () => `${p.business_name} — ${sentences(p.description)[0] ?? ""}`,
    () =>
      services.length
        ? `${p.business_name} ${pick(VERBS, seed)} ${listJoin(services.map((s) => s.toLowerCase()))}${countriesPhrase(p) ? ` in ${countriesPhrase(p)}` : ""}.`
        : `${p.business_name}: ${sentences(p.description)[0] ?? ""}`,
    () => `${sentences(p.description)[0] ?? p.business_name}`
  ];
  return truncateWords(pick(variants, seed)().trim(), 160);
}

function longDescription(p: BusinessProfile, seed: number): string {
  const parts: string[] = [];
  const desc = sentences(p.description);
  const brand = p.brand_descriptions.length ? pick(p.brand_descriptions, seed) : null;
  const services = rotate(p.products_services, seed);
  const blocks: string[] = [];
  blocks.push(desc.join(" "));
  if (services.length) blocks.push(`${pick(["Its services include", "Core services include", "What it offers:"], seed)} ${listJoin(services)}.`);
  if (p.target_countries.length)
    blocks.push(`${p.business_name} ${pick(["works with clients in", "serves customers in", "operates in"], seed)} ${countriesPhrase(p)}.`);
  if (p.founded_year) blocks.push(`The business was founded in ${p.founded_year}.`);
  if (brand && !blocks[0]!.includes(brand)) blocks.splice(1, 0, brand);
  // reorder middle blocks deterministically for uniqueness while keeping the lead sentence first
  const [lead, ...rest] = blocks;
  parts.push(lead!, ...rotate(rest, seed));
  parts.push(`More information: ${landing(p)}`);
  return parts.join(" ");
}

function companyProfile(p: BusinessProfile): string {
  const lines = [`Company: ${p.business_name}`, `Website: ${p.website_url}`, `Industry: ${industryDef(p.industry).label}`, `About: ${p.description}`];
  if (p.products_services.length) lines.push(`Products and services:\n${p.products_services.map((s) => `- ${s}`).join("\n")}`);
  if (p.target_countries.length) lines.push(`Markets served: ${countriesPhrase(p)}`);
  if (p.founded_year) lines.push(`Founded: ${p.founded_year}`);
  if (p.contact_email) lines.push(`Email: ${p.contact_email}`);
  if (p.contact_phone) lines.push(`Phone: ${p.contact_phone}`);
  if (p.address) lines.push(`Address: ${Object.values(p.address).filter(Boolean).join(", ")}`);
  const socials = Object.entries(p.social_profiles ?? {});
  if (socials.length) lines.push(`Social: ${socials.map(([k, v]) => `${k}: ${v}`).join(" | ")}`);
  return lines.join("\n");
}

function founderBio(p: BusinessProfile): string | null {
  if (!p.founder?.name) return null;
  const f = p.founder;
  return [
    `${f.name}${f.title ? ` is ${f.title} of ${p.business_name}` : ` leads ${p.business_name}`}.`,
    f.bio ?? "",
    `${p.business_name}: ${sentences(p.description)[0] ?? ""}`
  ]
    .filter(Boolean)
    .join(" ");
}

function topicIdeas(p: BusinessProfile, seed: number): string[] {
  const kws = rotate(p.target_keywords.length ? p.target_keywords : p.products_services, seed).slice(0, 3);
  const frames = [
    "A practical guide to {k}",
    "Common mistakes to avoid with {k}",
    "How to choose the right partner for {k}",
    "What to ask before investing in {k}",
    "{k}: a checklist for getting started"
  ];
  return kws.map((k, i) => pick(frames, seed, i).replace("{k}", k.toLowerCase()));
}

function guestPostPitch(p: BusinessProfile, d: Destination, seed: number): { title: string; body: string } {
  const topics = topicIdeas(p, seed);
  const title = `Article idea for ${d.name}${topics[0] ? `: ${topics[0]}` : ""}`;
  const body = [
    `Hello ${d.name} team,`,
    ``,
    `I'm writing from ${p.business_name} (${p.website_url}). ${sentences(p.description)[0] ?? ""}`,
    d.pageTitle
      ? `I came across "${d.pageTitle}" and think your readers may find the following useful.`
      : `I think your readers may find the following useful.`,
    ``,
    `Possible topics, written exclusively for ${d.name}:`,
    ...topics.map((t, i) => `${i + 1}. ${t}`),
    ``,
    `The article would follow your editorial guidelines, contain no promotional content, and include at most one relevant reference to our site, which you are free to remove. We will not use generated statistics, testimonials or claims we cannot support.`,
    ``,
    `If this isn't a fit, no reply is needed and we won't follow up more than once.`,
    ``,
    signature(p)
  ].join("\n");
  return { title, body };
}

function articleDraft(p: BusinessProfile, d: Destination, seed: number): { title: string; body: string } {
  const topic = topicIdeas(p, seed)[0] ?? `Getting started with ${p.products_services[0] ?? industryDef(p.industry).label.toLowerCase()}`;
  const title = topic.charAt(0).toUpperCase() + topic.slice(1);
  const body = [
    `DRAFT FOR EDITORIAL REVIEW — not for publication without human editing and the publisher's approval.`,
    `Target publication: ${d.name} (${d.domain})`,
    ``,
    `# ${title}`,
    ``,
    `## Introduction`,
    `[EDITOR: open with a first-hand observation from ${p.business_name}'s own experience. Do not add statistics unless you can cite a source.]`,
    ``,
    ...rotate(p.products_services.length ? p.products_services : p.target_keywords, seed)
      .slice(0, 3)
      .flatMap((s, i) => [
        `## ${i + 1}. ${s}`,
        `[EDITOR: explain what readers should consider about ${s.toLowerCase()}. Add a concrete example.]`,
        ``
      ]),
    `## Conclusion`,
    `[EDITOR: summarise practical takeaways.]`,
    ``,
    `Author bio: ${founderBio(p) ?? `${p.business_name} — ${sentences(p.description)[0] ?? ""}`}`
  ].join("\n");
  return { title, body };
}

function resourceRequest(p: BusinessProfile, d: Destination): { title: string; body: string } {
  const page = p.target_landing_pages[0];
  return {
    title: `Suggestion for ${d.pageTitle ?? d.name}`,
    body: [
      `Hello ${d.name} team,`,
      ``,
      d.pageTitle
        ? `Your page "${d.pageTitle}"${d.pageUrl ? ` (${d.pageUrl})` : ""} lists helpful resources.`
        : `Your resources page lists helpful links.`,
      `About ${p.business_name}: ${sentences(p.description)[0] ?? ""}`,
      page
        ? `Our page "${page.label ?? page.url}" (${page.url}) may be a useful addition for your readers.`
        : `Our site (${p.website_url}) may be a useful addition for your readers.`,
      ``,
      `If it isn't a fit, no reply is needed.`,
      ``,
      signature(p)
    ].join("\n")
  };
}

function partnershipPitch(p: BusinessProfile, d: Destination): { title: string; body: string } {
  return {
    title: `Partnership enquiry from ${p.business_name}`,
    body: [
      `Hello ${d.name} team,`,
      ``,
      `I'm reaching out from ${p.business_name} (${p.website_url}). ${sentences(p.description)[0] ?? ""}`,
      `We'd like to explore whether a partnership or membership listing would be valuable for both organisations${p.products_services.length ? ` — for example around ${listJoin(p.products_services.slice(0, 2).map((s) => s.toLowerCase()))}` : ""}.`,
      ``,
      `Happy to share more information or follow your application process.`,
      ``,
      signature(p)
    ].join("\n")
  };
}

function outreachEmail(p: BusinessProfile, d: Destination): { title: string; body: string } {
  return {
    title: `${p.business_name} — introduction`,
    body: [`Hello ${d.name} team,`, ``, `${sentences(p.description).slice(0, 2).join(" ")}`, ``, `Website: ${p.website_url}`, ``, signature(p)].join(
      "\n"
    )
  };
}

/** "GitHub · Change is constant. GitHub keeps you ahead." -> "GitHub"; falls back to the domain. */
export function cleanSiteName(title: string | null | undefined, domain: string): string {
  const first = (title ?? "").split(/\s[|\-–—·:]\s|\s[|·]|[|·]\s/)[0]?.trim() ?? "";
  return first && first.length <= 40 ? first : domain;
}

export function recoveryEmail(
  p: BusinessProfile,
  d: Destination & { sourceUrl: string; targetUrl: string; diagnosis: string }
): { title: string; body: string } {
  const what =
    d.diagnosis === "page_gone"
      ? "the page that listed us no longer seems to be available"
      : d.diagnosis === "page_noindexed"
        ? "the page that lists us is now set to noindex"
        : "the link to our site no longer appears on the page";
  return {
    title: `Question about our listing on ${d.name}`,
    body: [
      `Hello ${d.name} team,`,
      ``,
      `We noticed that ${what}: ${d.sourceUrl}`,
      `It previously linked to ${d.targetUrl}. If the change was intentional, no problem at all. If not, would you consider restoring it? Happy to update any details.`,
      ``,
      signature(p)
    ].join("\n")
  };
}

// ---------------------------------------------------------------------------------------------
// fact check
// ---------------------------------------------------------------------------------------------
const CLAIM_PATTERNS: [string, RegExp][] = [
  ["award", /\b(award[- ]?winning|awards?|awarded|winner)\b/gi],
  ["certification", /\b(certified|certification|accredited|ISO\s?\d{3,5}|licensed)\b/gi],
  ["superlative", /(#1\b|\bnumber one\b|\bbest\b|\bleading\b|\btop[- ]rated\b|\blargest\b|\bworld[- ]class\b|\bguarantee[ds]?\b)/gi],
  ["statistic", /(\b\d+(?:\.\d+)?\s?%|\b\d{2,}[,\d]*\+?\s+(?:clients|customers|projects|years|employees|countries|users|brands))/gi],
  ["testimonial", /["“][^"”]{20,}["”]\s*(?:—|-|said|says)/gi],
  ["phone", /\+?\d[\d\s().-]{8,}\d/g],
  ["email", /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,24}/gi],
  ["address", /\b\d+[A-Za-z]?\s+[A-Z][a-z]+(?:\s[A-Z][a-z]+)*\s+(?:Street|St|Road|Rd|Avenue|Ave|Lane|Ln|Boulevard|Blvd|Marg)\b/g],
  ["year", /\b(?:19|20)\d{2}\b/g]
];

export function profileCorpus(p: BusinessProfile): string {
  return [
    p.business_name,
    p.website_url,
    p.description,
    ...p.products_services,
    ...p.brand_descriptions,
    ...p.verified_facts,
    p.contact_email ?? "",
    p.contact_phone ?? "",
    p.address ? Object.values(p.address).join(" ") : "",
    p.founded_year ? String(p.founded_year) : "",
    p.founder ? `${p.founder.name} ${p.founder.title ?? ""} ${p.founder.bio ?? ""}` : "",
    ...p.target_landing_pages.map((l) => `${l.url} ${l.label ?? ""}`),
    ...Object.values(p.social_profiles ?? {})
  ]
    .join("\n")
    .toLowerCase();
}

/** Every factual claim in the text must be traceable to the approved profile. */
export function factCheck(text: string, p: BusinessProfile, allowedExtra: string[] = []): FactCheckResult {
  const corpus = `${profileCorpus(p)}\n${allowedExtra.join("\n").toLowerCase()}`;
  const claims: FactCheckResult["claims"] = [];
  for (const [kind, re] of CLAIM_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const t = m[0].trim();
      const norm = t.toLowerCase().replace(/\s+/g, " ");
      const supported = corpus.includes(norm) || (kind === "phone" && corpus.replace(/[^\d+]/g, "").includes(t.replace(/[^\d+]/g, "")));
      claims.push({ text: t, kind, supported });
    }
  }
  const unsupported = claims.filter((c) => !c.supported);
  return { passed: unsupported.length === 0, claims, missing: [] };
}

// ---------------------------------------------------------------------------------------------
// uniqueness
// ---------------------------------------------------------------------------------------------
function shingles(text: string, k = 4): Set<string> {
  const w = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + k <= w.length; i++) out.add(w.slice(i, i + k).join(" "));
  return out;
}

export function similarity(a: string, b: string): number {
  const A = shingles(a);
  const B = shingles(b);
  if (!A.size || !B.size) return a.trim() === b.trim() ? 1 : 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

// ---------------------------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------------------------
export function renderAsset(type: AssetType, p: BusinessProfile, d: Destination, seed: number): { title: string | null; body: string } | null {
  switch (type) {
    case "short_description":
      return { title: null, body: shortDescription(p, seed) };
    case "long_description":
      return { title: null, body: longDescription(p, seed) };
    case "company_profile":
      return { title: `${p.business_name} — company profile`, body: companyProfile(p) };
    case "founder_bio": {
      const b = founderBio(p);
      return b ? { title: p.founder!.name, body: b } : null;
    }
    case "directory_listing":
      return { title: p.business_name, body: `${shortDescription(p, seed)}\n\n${longDescription(p, seed + 1)}` };
    case "guest_post_pitch":
      return guestPostPitch(p, d, seed);
    case "article_draft":
      return articleDraft(p, d, seed);
    case "resource_request":
      return resourceRequest(p, d);
    case "partnership_pitch":
      return partnershipPitch(p, d);
    case "outreach_email":
      return outreachEmail(p, d);
    case "recovery_email":
      return null; // generated by the recovery engine with link context
  }
}

export const ASSETS_BY_OPPORTUNITY: Record<string, AssetType[]> = {
  business_listing: ["short_description", "long_description", "directory_listing"],
  industry_directory: ["short_description", "long_description", "directory_listing"],
  agency_directory: ["short_description", "long_description", "directory_listing", "company_profile"],
  startup_directory: ["short_description", "long_description", "directory_listing", "company_profile"],
  review_platform: ["short_description", "company_profile"],
  association: ["company_profile", "partnership_pitch"],
  partner: ["partnership_pitch", "company_profile"],
  resource_page: ["resource_request"],
  guest_post: ["guest_post_pitch", "article_draft"],
  other: ["short_description", "outreach_email"]
};

export async function loadApprovedProfile(tx: Tx, websiteId: string): Promise<BusinessProfile> {
  const p = await tx.maybe<BusinessProfile>(`select * from business_profiles where website_id = $1`, [websiteId]);
  if (!p) throw new PermanentError("No business profile exists for this website");
  if (p.status !== "approved")
    throw new PermanentError("The business profile has not been approved yet; assets can only be generated from an approved profile");
  return p;
}

/**
 * Generate (and persist) the assets an opportunity needs. Re-uses existing assets for the opportunity.
 * Returns asset rows with fact-check results.
 */
export async function generateAssetsForOpportunity(
  tx: Tx,
  args: { organizationId: string; websiteId: string; campaignId: string; opportunityId: string; types?: AssetType[] }
): Promise<{ id: string; asset_type: AssetType; title: string | null; body: string; fact_check: FactCheckResult; max_similarity: number }[]> {
  const profile = await loadApprovedProfile(tx, args.websiteId);
  const opp = await tx.one<{ url: string; opportunity_type: string; prospect_domain: string; source_name: string | null; page_title: string | null }>(
    `select o.url, o.opportunity_type, p.domain as prospect_domain, s.name as source_name,
            nullif(p.signals ->> 'title', '') as page_title
       from backlink_opportunities o join backlink_prospects p on p.id = o.prospect_id
       left join backlink_sources s on s.id = o.source_id
      where o.id = $1`,
    [args.opportunityId]
  );
  const dest: Destination = {
    name: opp.source_name ?? cleanSiteName(opp.page_title, opp.prospect_domain),
    domain: opp.prospect_domain,
    type: opp.opportunity_type,
    pageTitle: opp.page_title ?? undefined,
    pageUrl: opp.url
  };
  const types: AssetType[] = args.types ?? ASSETS_BY_OPPORTUNITY[opp.opportunity_type] ?? ASSETS_BY_OPPORTUNITY.other!;
  const out = [];
  for (const type of types) {
    const existing = await tx.maybe<any>(
      `select id, asset_type, title, body, fact_check, max_similarity from backlink_assets
        where opportunity_id = $1 and asset_type = $2 and status in ('draft', 'approved') order by created_at desc limit 1`,
      [args.opportunityId, type]
    );
    if (existing) {
      out.push(existing);
      continue;
    }
    const previous = await tx.q<{ body: string }>(
      `select body from backlink_assets where website_id = $1 and asset_type = $2 order by created_at desc limit 50`,
      [args.websiteId, type]
    );
    let chosen: { title: string | null; body: string; sim: number } | null = null;
    const baseSeed = seedFrom(`${dest.domain}:${type}`);
    for (let attempt = 0; attempt < 6; attempt++) {
      const r = renderAsset(type, profile, dest, baseSeed + attempt);
      if (!r) break;
      const sim = previous.reduce((m, prev) => Math.max(m, similarity(prev.body, r.body)), 0);
      if (!chosen || sim < chosen.sim) chosen = { ...r, sim };
      if (sim < 0.85) break;
    }
    if (!chosen) continue; // e.g. founder bio without founder facts — never invented
    const fc = factCheck(`${chosen.title ?? ""}\n${chosen.body}`, profile, [dest.name, dest.domain, dest.pageTitle ?? "", dest.pageUrl ?? ""]);
    const hash = crypto.createHash("sha256").update(`${type}\n${chosen.body}`).digest("hex");
    const row = await tx.maybe<any>(
      `insert into backlink_assets (organization_id, website_id, campaign_id, opportunity_id, asset_type, title, body, content_hash,
                                    max_similarity, fact_check, generator, profile_version)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'template-v1',$11)
       on conflict (organization_id, website_id, content_hash) do nothing
       returning id, asset_type, title, body, fact_check, max_similarity`,
      [
        args.organizationId,
        args.websiteId,
        args.campaignId,
        args.opportunityId,
        type,
        chosen.title,
        chosen.body,
        hash,
        chosen.sim.toFixed(4),
        JSON.stringify(fc),
        profile.version
      ]
    );
    if (row) out.push(row);
    else {
      // Identical copy already exists for another destination: reuse is not allowed, flag for a human.
      const dup = await tx.one<any>(
        `insert into backlink_assets (organization_id, website_id, campaign_id, opportunity_id, asset_type, title, body, content_hash,
                                      max_similarity, fact_check, generator, profile_version)
         values ($1,$2,$3,$4,$5,$6,$7,$8,1,$9,'template-v1',$10)
         returning id, asset_type, title, body, fact_check, max_similarity`,
        [
          args.organizationId,
          args.websiteId,
          args.campaignId,
          args.opportunityId,
          type,
          chosen.title,
          `${chosen.body}\n\n[Duplicate of copy used elsewhere — edit before use]`,
          crypto.createHash("sha256").update(`${type}\n${chosen.body}\n${args.opportunityId}`).digest("hex"),
          JSON.stringify({ ...fc, passed: false, missing: ["unique copy"] }),
          profile.version
        ]
      );
      out.push(dup);
    }
  }
  return out;
}
