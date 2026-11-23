/**
 * Business profile, automation settings and acquisition campaigns. Every function takes a tenant transaction
 * (RLS scopes each statement to one workspace); the permission checks live in ../services.ts.
 */
import { z } from "zod";
import { and, eq, schema } from "@sge/db";
import { NotFoundError, tenant, type SqlTx as Tx } from "../sql";
import { BACKLINK_JOBS, cancelCampaignJobs, enqueueJob, type EngineJobContext } from "../jobs";
import {
  competitorCsvCandidates,
  csvCandidates,
  curatedCandidates,
  ingestCandidates,
  loadCampaignCtx,
  userUrlCandidates,
  type Candidate
} from "../discovery/discovery";
import { INDUSTRIES } from "../discovery/taxonomy";
import { audit } from "./common";
import { getAdapter } from "../adapters/registry";
import { queueExecution } from "./planner";
import { PermanentError } from "../errors";

const industryKeys = INDUSTRIES.map((i) => i.key) as [string, ...string[]];
const country = z.string().regex(/^[A-Z]{2}$/);
const httpUrl = z
  .string()
  .url()
  .max(2048)
  .refine((u) => /^https?:\/\//i.test(u), "http(s) only");

export const ProfileInput = z.object({
  business_name: z.string().trim().min(1).max(200),
  website_url: httpUrl,
  industry: z.enum(industryKeys),
  description: z.string().trim().min(20).max(5000),
  products_services: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
  target_countries: z.array(country).max(30).default([]),
  contact_email: z.string().email().nullable().optional(),
  contact_phone: z.string().max(40).nullable().optional(),
  address: z.record(z.string(), z.string().max(300)).nullable().optional(),
  social_profiles: z.record(z.string(), httpUrl).default({}),
  logo_url: httpUrl.nullable().optional(),
  brand_descriptions: z.array(z.string().max(1000)).max(20).default([]),
  target_landing_pages: z
    .array(z.object({ url: httpUrl, label: z.string().max(200).optional() }))
    .max(50)
    .default([]),
  target_keywords: z.array(z.string().max(100)).max(50).default([]),
  approved_anchor_texts: z.array(z.string().max(100)).max(30).default([]),
  founder: z
    .object({ name: z.string().max(200), title: z.string().max(200).optional(), bio: z.string().max(2000).optional() })
    .nullable()
    .optional(),
  founded_year: z.number().int().min(1800).max(2100).nullable().optional(),
  verified_facts: z.array(z.string().max(500)).max(50).default([])
});
export type ProfileInputT = z.input<typeof ProfileInput>;

/** Saving a profile always returns it to draft; it must be re-approved before new assets are generated. */
export async function upsertProfile(tx: Tx, orgId: string, websiteId: string, input: ProfileInputT) {
  const p = ProfileInput.parse(input);
  return tx.one<{ id: string; version: number; status: string }>(
    `insert into business_profiles (organization_id, website_id, business_name, website_url, industry, description, products_services,
        target_countries, contact_email, contact_phone, address, social_profiles, logo_url, brand_descriptions, target_landing_pages,
        target_keywords, approved_anchor_texts, founder, founded_year, verified_facts, status)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'draft')
     on conflict (website_id) do update set business_name = excluded.business_name, website_url = excluded.website_url,
        industry = excluded.industry, description = excluded.description, products_services = excluded.products_services,
        target_countries = excluded.target_countries, contact_email = excluded.contact_email, contact_phone = excluded.contact_phone,
        address = excluded.address, social_profiles = excluded.social_profiles, logo_url = excluded.logo_url,
        brand_descriptions = excluded.brand_descriptions, target_landing_pages = excluded.target_landing_pages,
        target_keywords = excluded.target_keywords, approved_anchor_texts = excluded.approved_anchor_texts, founder = excluded.founder,
        founded_year = excluded.founded_year, verified_facts = excluded.verified_facts, status = 'draft',
        version = business_profiles.version + 1, approved_by = null, approved_at = null
     returning id, version, status`,
    [
      orgId,
      websiteId,
      p.business_name,
      p.website_url,
      p.industry,
      p.description,
      p.products_services,
      p.target_countries,
      p.contact_email ?? null,
      p.contact_phone ?? null,
      p.address ? JSON.stringify(p.address) : null,
      JSON.stringify(p.social_profiles),
      p.logo_url ?? null,
      JSON.stringify(p.brand_descriptions),
      JSON.stringify(p.target_landing_pages),
      p.target_keywords,
      p.approved_anchor_texts,
      p.founder ? JSON.stringify(p.founder) : null,
      p.founded_year ?? null,
      JSON.stringify(p.verified_facts)
    ]
  );
}

export async function approveProfile(tx: Tx, orgId: string, websiteId: string, userId: string) {
  const r = await tx.maybe<{ id: string; version: number }>(
    `update business_profiles set status = 'approved', approved_by = $2, approved_at = now() where website_id = $1 returning id, version`,
    [websiteId, userId]
  );
  if (!r) throw new NotFoundError("Save the business profile before approving it");
  await audit(tx, orgId, "user", userId, "backlinks.profile_approved", "website", websiteId, r);
  return r;
}

export type AutomationMode = "autopilot" | "supervised" | "manual";
export const AUTOPILOT_PERMISSIONS = ["explicit_permission", "own_property", "test_destination"] as const;

export async function automationSettings(
  tx: Tx,
  websiteId: string
): Promise<{ mode: AutomationMode; autopilotSourceIds: string[]; note: string | null }> {
  const r = await tx.maybe<{ automation_mode: AutomationMode; autopilot_source_ids: string[]; automation_note: string | null }>(
    `select automation_mode, autopilot_source_ids, automation_note from backlink_website_settings where website_id = $1`,
    [websiteId]
  );
  return { mode: r?.automation_mode ?? "supervised", autopilotSourceIds: r?.autopilot_source_ids ?? [], note: r?.automation_note ?? null };
}

/**
 * AUTOPILOT only ever applies to sources listed here AND whose own recorded permission allows automation.
 * Enabling it requires a permission note (who allowed it and why), kept with the setting and in the audit log.
 */
export async function setAutomationMode(
  tx: Tx,
  orgId: string,
  websiteId: string,
  userId: string,
  mode: AutomationMode,
  autopilotSourceIds?: string[],
  note?: string | null
) {
  if (!["autopilot", "supervised", "manual"].includes(mode)) throw new PermanentError("Unknown automation mode");
  const ids = autopilotSourceIds ? [...new Set(autopilotSourceIds)] : undefined;
  const current = await automationSettings(tx, websiteId);
  if (mode === "autopilot" && !note?.trim() && !current.note)
    throw new PermanentError("Record why autopilot is allowed for this website (permission note)");
  if (ids?.length) {
    // Only sources visible to this workspace (RLS) AND explicitly permitting automation may be enabled.
    const ok = await tx.q<{ id: string }>(`select id from backlink_sources where id = any($1::uuid[]) and automation_permission = any($2::text[])`, [
      ids,
      AUTOPILOT_PERMISSIONS
    ]);
    const okIds = new Set(ok.map((r) => r.id));
    const bad = ids.filter((id) => !okIds.has(id));
    if (bad.length)
      throw new PermanentError(
        `These sources are unknown or do not explicitly permit automation, so they can't be enabled for autopilot: ${bad.join(", ")}`
      );
  }
  await tx.exec(
    `insert into backlink_website_settings (website_id, organization_id, automation_mode, autopilot_source_ids, automation_note, updated_by)
     values ($1, $2, $3, coalesce($4::uuid[], '{}'), $5, $6)
     on conflict (website_id) do update set automation_mode = excluded.automation_mode,
       autopilot_source_ids = coalesce($4::uuid[], backlink_website_settings.autopilot_source_ids),
       automation_note = coalesce(excluded.automation_note, backlink_website_settings.automation_note), updated_by = excluded.updated_by`,
    [websiteId, orgId, mode, ids ?? null, note?.trim() || null, userId]
  );
  await audit(tx, orgId, "user", userId, "backlinks.automation_mode", "website", websiteId, {
    mode,
    autopilotSourceIds: ids,
    note: note?.trim() || null
  });
}

export const CampaignInput = z.object({
  websiteId: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  industry: z.enum(industryKeys).optional(),
  targetCountries: z.array(country).max(30).optional(),
  targetKeywords: z.array(z.string().max(100)).max(50).default([]),
  targetPages: z.array(httpUrl).max(50).default([]),
  preferredCategories: z.array(z.string()).max(10).default([]),
  minQualityScore: z.number().int().min(0).max(100).default(50),
  maxDailySubmissions: z.number().int().min(0).max(500).default(5),
  maxWeeklySubmissions: z.number().int().min(0).max(2000).default(20),
  allowedAdapters: z.array(z.string()).default([]),
  excludedDomains: z.array(z.string().max(253)).default([]),
  automationMode: z.enum(["autopilot", "supervised", "manual"]).nullable().optional(),
  approvalRequired: z.boolean().default(true),
  startsAt: z.coerce.date().nullable().optional(),
  endsAt: z.coerce.date().nullable().optional(),
  seedUrls: z.array(z.string().max(2048)).max(500).default([]),
  startDiscovery: z.boolean().default(true)
});
export type CampaignInputT = z.input<typeof CampaignInput>;

/** The website's daily backlinks schedule (planning, weekly discovery and re-verification). */
export async function ensureWebsiteSchedule(tx: Tx, orgId: string, websiteId: string): Promise<void> {
  const next = new Date(Date.now() + 24 * 3600 * 1000);
  await tx.tx
    .insert(schema.schedules)
    .values({
      organizationId: orgId,
      websiteId,
      jobType: BACKLINK_JOBS.tick,
      payload: { website_id: websiteId },
      intervalMinutes: 24 * 60,
      nextRunAt: next
    })
    .onConflictDoUpdate({ target: [schema.schedules.websiteId, schema.schedules.jobType], set: { enabled: true, updatedAt: new Date() } });
}

export async function disableWebsiteSchedule(tx: Tx, websiteId: string): Promise<void> {
  await tx.tx
    .update(schema.schedules)
    .set({ enabled: false, updatedAt: new Date() })
    .where(and(eq(schema.schedules.websiteId, websiteId), eq(schema.schedules.jobType, BACKLINK_JOBS.tick)));
}

export async function createCampaign(tx: Tx, orgId: string, userId: string | null, input: CampaignInputT) {
  const c = CampaignInput.parse(input);
  for (const a of c.allowedAdapters) getAdapter(a); // throws for unknown adapters
  const w = await tx.maybe<{ id: string }>(`select id from websites where id = $1`, [c.websiteId]);
  if (!w) throw new NotFoundError("Website not found");
  const profile = await tx.maybe<{ industry: string; target_countries: string[] }>(
    `select industry, target_countries from business_profiles where website_id = $1`,
    [w.id]
  );
  const row = await tx.one<{ id: string }>(
    `insert into backlink_campaigns (organization_id, website_id, name, industry, target_countries, target_keywords, target_pages,
        preferred_categories, min_quality_score, automation_mode, status, starts_at, ends_at, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active',$11,$12,$13) returning id`,
    [
      orgId,
      w.id,
      c.name,
      c.industry ?? profile?.industry ?? "other",
      c.targetCountries ?? profile?.target_countries ?? [],
      c.targetKeywords,
      c.targetPages,
      c.preferredCategories,
      c.minQualityScore,
      c.automationMode ?? null,
      c.startsAt ?? null,
      c.endsAt ?? null,
      userId
    ]
  );
  await tx.exec(
    `insert into backlink_campaign_settings (campaign_id, organization_id, max_daily_submissions, max_weekly_submissions, allowed_adapters, excluded_domains, approval_required)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [
      row.id,
      orgId,
      c.maxDailySubmissions,
      c.maxWeeklySubmissions,
      c.allowedAdapters,
      c.excludedDomains.map((d) => d.toLowerCase()),
      c.approvalRequired
    ]
  );
  if (c.startDiscovery) {
    await enqueueJob(tx, {
      organizationId: orgId,
      websiteId: w.id,
      campaignId: row.id,
      jobType: BACKLINK_JOBS.discover,
      payload: { campaign_id: row.id, urls: c.seedUrls },
      idempotencyKey: `discover:${row.id}:initial`,
      priority: 60
    });
  }
  await ensureWebsiteSchedule(tx, orgId, w.id);
  await audit(tx, orgId, userId ? "user" : "system", userId, "backlinks.campaign_created", "campaign", row.id, { name: c.name });
  return row;
}

export async function pauseCampaign(tx: Tx, orgId: string, campaignId: string, userId: string | null) {
  const r = await tx.maybe<{ id: string }>(
    `update backlink_campaigns set status = 'paused', paused_at = now() where id = $1 and status = 'active' returning id`,
    [campaignId]
  );
  if (!r) throw new PermanentError("Only active campaigns can be paused");
  const cancelled = await cancelCampaignJobs(tx, campaignId);
  await audit(tx, orgId, userId ? "user" : "system", userId, "campaign.paused", "campaign", campaignId, { cancelled_jobs: cancelled });
  return { cancelledJobs: cancelled };
}

export async function resumeCampaign(tx: Tx, orgId: string, campaignId: string, userId: string | null) {
  const c = await tx.maybe<{ id: string; website_id: string }>(
    `update backlink_campaigns set status = 'active', paused_at = null where id = $1 and status = 'paused' returning id, website_id`,
    [campaignId]
  );
  if (!c) throw new PermanentError("Only paused campaigns can be resumed");
  // Re-queue submissions whose execution jobs were cancelled by the pause.
  const queued = await tx.q<{
    id: string;
    organization_id: string;
    website_id: string;
    campaign_id: string;
    adapter_key: string;
    attempt_count: number;
  }>(
    `select id, organization_id, website_id, campaign_id, adapter_key, attempt_count from backlink_submissions where campaign_id = $1 and status = 'SUBMISSION_QUEUED'`,
    [campaignId]
  );
  const stamp = Date.now();
  for (const s of queued) await queueExecution(tx, s, `:resume:${stamp}`, { alreadyQueued: true });
  await enqueueJob(tx, {
    organizationId: orgId,
    websiteId: c.website_id,
    campaignId,
    jobType: BACKLINK_JOBS.plan,
    payload: { campaign_id: campaignId },
    idempotencyKey: `plan:${campaignId}:resume:${stamp}`
  });
  await ensureWebsiteSchedule(tx, orgId, c.website_id);
  await audit(tx, orgId, userId ? "user" : "system", userId, "campaign.resumed", "campaign", campaignId, { requeued: queued.length });
  return { requeued: queued.length };
}

async function queueQualification(tx: Tx, orgId: string, campaignId: string, websiteId: string, prospectIds: string[]) {
  const day = new Date().toISOString().slice(0, 10);
  for (const pid of prospectIds) {
    await enqueueJob(tx, {
      organizationId: orgId,
      websiteId,
      campaignId,
      jobType: BACKLINK_JOBS.qualify,
      payload: { prospect_id: pid, campaign_id: campaignId },
      idempotencyKey: `qualify:${campaignId}:${pid}:${day}`,
      maxAttempts: 3,
      priority: 70
    });
  }
}

export async function addCandidates(tx: Tx, orgId: string, campaignId: string, candidates: Candidate[]) {
  const ctx = await loadCampaignCtx(tx, campaignId);
  const res = await ingestCandidates(tx, ctx, candidates);
  await queueQualification(tx, orgId, campaignId, ctx.website_id, res.prospectIds);
  return res;
}

export async function addUrls(tx: Tx, orgId: string, campaignId: string, urls: string[]) {
  return addCandidates(tx, orgId, campaignId, userUrlCandidates(urls.slice(0, 500)));
}

export async function importCsv(
  tx: Tx,
  orgId: string,
  campaignId: string,
  csvText: string,
  opts: { kind: "generic" | "competitor"; fileName?: string; competitor?: string }
) {
  if (csvText.length > 2 * 1024 * 1024) throw new PermanentError("CSV files are limited to 2 MB");
  const parsed =
    opts.kind === "competitor"
      ? competitorCsvCandidates(csvText, opts.competitor ?? "competitor", opts.fileName)
      : csvCandidates(csvText, opts.fileName);
  const res = await addCandidates(tx, orgId, campaignId, parsed.candidates.slice(0, 5000));
  return { ...res, errors: parsed.errors };
}

/** 'backlinks.discover' job: curated catalogue + seed URLs, then qualification jobs for new prospects. */
export async function discoverCampaignJob(ctx: EngineJobContext) {
  const { campaign_id: campaignId, urls = [] } = ctx.job.payload as { campaign_id: string; urls?: string[] };
  const orgId = ctx.job.organization_id;
  return tenant(ctx.db, orgId, async (tx) => {
    const status = await tx.maybe<{ status: string }>(`select status from backlink_campaigns where id = $1`, [campaignId]);
    if (!status) return { skipped: "campaign not found" };
    if (status.status !== "active") return { skipped: status.status };
    const cctx = await loadCampaignCtx(tx, campaignId);
    const candidates = [...(await curatedCandidates(tx, cctx)), ...userUrlCandidates(urls)];
    const res = await ingestCandidates(tx, cctx, candidates);
    await queueQualification(tx, orgId, campaignId, cctx.website_id, res.prospectIds);
    await ctx.log("info", `Discovery: ${res.created} new, ${res.duplicates} duplicates, ${res.excluded} excluded`, res);
    return res;
  });
}
