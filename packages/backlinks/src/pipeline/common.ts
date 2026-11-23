/** Shared pipeline helpers: submission values, automation-mode policy, limits, tasks, audit. */
import { audit, type SqlTx as Tx } from "../sql";
import { countryName, industryDef } from "../discovery/taxonomy";
import type { AssetType, BusinessProfile } from "../assets/generator";
import { AUTOPILOT_PERMISSIONS, type Adapter, type SourceInfo, type SubmissionValues } from "../adapters/types";

export type Mode = "autopilot" | "supervised" | "manual";

export function buildSubmissionValues(
  p: BusinessProfile,
  assets: Partial<Record<AssetType, { title: string | null; body: string }>>,
  targetUrl: string,
  anchor: string
): SubmissionValues {
  const addr = p.address ?? null;
  return {
    business_name: p.business_name,
    website_url: p.website_url,
    target_url: targetUrl,
    anchor_text: anchor,
    email: p.contact_email,
    phone: p.contact_phone,
    contact_name: p.founder?.name ?? null,
    short_description: assets.short_description?.body ?? p.description.slice(0, 160),
    long_description: assets.long_description?.body ?? assets.directory_listing?.body ?? p.description,
    category: industryDef(p.industry).label,
    country: p.target_countries[0] ? countryName(p.target_countries[0]) : null,
    city: addr?.city ?? null,
    address: addr ? Object.values(addr).filter(Boolean).join(", ") : null,
    keywords: p.target_keywords.slice(0, 5).join(", "),
    logo_url: p.logo_url,
    title: assets.article_draft?.title ?? null,
    body: assets.article_draft?.body ?? null
  };
}

/** Anchor text: only approved anchors (or the brand name). Never keyword-stuffed unless approved. */
export function chooseAnchor(p: BusinessProfile, seed: number): string {
  const options = p.approved_anchor_texts.length ? p.approved_anchor_texts : [p.business_name];
  return options[seed % options.length]!;
}

export function chooseTarget(p: BusinessProfile, campaignTargets: string[], seed: number): string {
  const pages = campaignTargets.length ? campaignTargets : p.target_landing_pages.map((l) => l.url);
  return pages.length ? pages[seed % pages.length]! : p.website_url;
}

export interface AutopilotDecision {
  eligible: boolean;
  reasons: string[];
}

/** AUTOPILOT requires every condition below; otherwise the submission falls back to SUPERVISED approval. */
export function autopilotDecision(args: {
  mode: Mode;
  approvalRequired: boolean;
  adapter: Adapter;
  source: SourceInfo | null;
  websiteAutopilotSources: string[];
  factCheckPassed: boolean;
}): AutopilotDecision {
  const reasons: string[] = [];
  if (args.mode !== "autopilot") reasons.push(`automation mode is ${args.mode}`);
  if (args.approvalRequired) reasons.push("campaign requires approval");
  if (!args.adapter.manifest.supportsAutopilot) reasons.push(`adapter ${args.adapter.manifest.key} does not support autopilot`);
  if (args.adapter.manifest.testStatus === "untested") reasons.push("adapter is untested");
  if (!args.source) reasons.push("destination is not a registered source");
  else {
    if (!AUTOPILOT_PERMISSIONS.includes(args.source.automation_permission)) {
      reasons.push(`source permission "${args.source.automation_permission}" does not explicitly allow automation`);
    }
    if (!args.websiteAutopilotSources.includes(args.source.id)) reasons.push("source is not enabled for autopilot on this website");
  }
  if (!args.factCheckPassed) reasons.push("generated content has unverified claims");
  return { eligible: reasons.length === 0, reasons };
}

export { audit };

/** Source columns as JSON for adapters and approval snapshots — never the encrypted credentials. */
export const SOURCE_JSON = `case when src.id is null then null else (to_jsonb(src.*) - 'credentials_enc' - 'credentials_hint') || jsonb_build_object('has_credentials', src.credentials_enc is not null) end`;

export type TaskType =
  | "captcha_required"
  | "email_verification"
  | "login_required"
  | "manual_submission"
  | "manual_review"
  | "outreach_send"
  | "outreach_reply"
  | "recovery"
  | "adapter_error"
  | "profile_incomplete";

export async function createTask(
  tx: Tx,
  t: {
    organizationId: string;
    websiteId: string;
    campaignId?: string | null;
    submissionId?: string | null;
    opportunityId?: string | null;
    type: TaskType;
    title: string;
    instructions: string;
    payload?: unknown;
    dueInHours?: number;
  }
): Promise<string | null> {
  const row = await tx.maybe<{ id: string }>(
    `insert into backlink_tasks (organization_id, website_id, campaign_id, submission_id, opportunity_id, task_type, title, instructions, payload, due_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9, case when $10::int is null then null else now() + make_interval(hours => $10::int) end)
     on conflict do nothing returning id`,
    [
      t.organizationId,
      t.websiteId,
      t.campaignId ?? null,
      t.submissionId ?? null,
      t.opportunityId ?? null,
      t.type,
      t.title,
      t.instructions,
      JSON.stringify(t.payload ?? {}),
      t.dueInHours ?? null
    ]
  );
  return row?.id ?? null;
}

export interface LimitCheck {
  ok: boolean;
  reason?: string;
  retryAfterSeconds?: number;
}

function secondsToUtcMidnight(): number {
  const n = new Date();
  return Math.ceil((Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1) - n.getTime()) / 1000) + 5;
}

/** Campaign daily/weekly caps, per-domain caps + minimum interval, per-adapter (platform) caps. */
export async function checkSubmissionLimits(
  tx: Tx,
  s: { id: string; campaign_id: string; destination_domain: string; adapter_key: string },
  adapter: Adapter
): Promise<LimitCheck> {
  const settings = await tx.one<{ max_daily_submissions: number; max_weekly_submissions: number }>(
    `select max_daily_submissions, max_weekly_submissions from backlink_campaign_settings where campaign_id = $1`,
    [s.campaign_id]
  );
  const counts = await tx.one<{ c_day: number; c_week: number; d_day: number; d_week: number; a_day: number; a_week: number; d_last: Date | null }>(
    `select
       count(*) filter (where campaign_id = $1 and submitted_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc') as c_day,
       count(*) filter (where campaign_id = $1 and submitted_at >= now() - interval '7 days') as c_week,
       count(*) filter (where destination_domain = $2 and submitted_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc') as d_day,
       count(*) filter (where destination_domain = $2 and submitted_at >= now() - interval '7 days') as d_week,
       count(*) filter (where adapter_key = $3 and submitted_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc') as a_day,
       count(*) filter (where adapter_key = $3 and submitted_at >= now() - interval '7 days') as a_week,
       max(submitted_at) filter (where destination_domain = $2) as d_last
     from backlink_submissions where id <> $4 and submitted_at is not null`,
    [s.campaign_id, s.destination_domain, s.adapter_key, s.id]
  );
  if (counts.c_day >= settings.max_daily_submissions)
    return { ok: false, reason: `Campaign daily limit (${settings.max_daily_submissions}) reached`, retryAfterSeconds: secondsToUtcMidnight() };
  if (counts.c_week >= settings.max_weekly_submissions)
    return { ok: false, reason: `Campaign weekly limit (${settings.max_weekly_submissions}) reached`, retryAfterSeconds: 86400 };
  const lim = async (scope: "domain" | "adapter", key: string) =>
    tx.maybe<{ max_per_day: number; max_per_week: number; min_interval_seconds: number }>(
      `select max_per_day, max_per_week, min_interval_seconds from backlink_domain_limits
        where scope = $1 and key in ($2, '*') order by organization_id nulls last, (key = '*') limit 1`,
      [scope, key]
    );
  const dl = (await lim("domain", s.destination_domain)) ?? {
    max_per_day: adapter.manifest.rateLimits.perDomainPerDay,
    max_per_week: adapter.manifest.rateLimits.perDomainPerWeek,
    min_interval_seconds: adapter.manifest.rateLimits.minIntervalSeconds
  };
  if (counts.d_day >= dl.max_per_day)
    return {
      ok: false,
      reason: `Per-domain daily limit for ${s.destination_domain} (${dl.max_per_day}) reached`,
      retryAfterSeconds: secondsToUtcMidnight()
    };
  if (counts.d_week >= dl.max_per_week)
    return { ok: false, reason: `Per-domain weekly limit for ${s.destination_domain} (${dl.max_per_week}) reached`, retryAfterSeconds: 86400 };
  if (counts.d_last && dl.min_interval_seconds > 0) {
    const wait = dl.min_interval_seconds - Math.floor((Date.now() - new Date(counts.d_last).getTime()) / 1000);
    if (wait > 0) return { ok: false, reason: `Minimum interval for ${s.destination_domain} not elapsed`, retryAfterSeconds: wait };
  }
  const al = await lim("adapter", s.adapter_key);
  if (al) {
    if (counts.a_day >= al.max_per_day)
      return { ok: false, reason: `Platform daily limit for ${s.adapter_key} reached`, retryAfterSeconds: secondsToUtcMidnight() };
    if (counts.a_week >= al.max_per_week)
      return { ok: false, reason: `Platform weekly limit for ${s.adapter_key} reached`, retryAfterSeconds: 86400 };
  }
  return { ok: true };
}
