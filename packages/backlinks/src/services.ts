/**
 * Workspace-facing API for the web app (server components and actions). Every call:
 *  1. re-reads the member's role inside its own transaction (`inWorkspace`), narrows RLS to their client scope,
 *  2. checks the permission matrix (`work.run`, `work.approve`, `automation.enable`),
 *  3. runs the engine with that transaction, so RLS applies to every statement,
 *  4. turns engine errors into user-safe AppErrors.
 */
import { ZodError, z } from "zod";
import {
  AppError,
  assertId,
  encryptSecret,
  inWorkspace,
  isUniqueViolation,
  keyHint,
  requireAction,
  type Action,
  type Actor,
  type Member,
  type WorkspaceAccess
} from "@sge/core";
import type { Db } from "@sge/db";
import { requeueJob } from "@sge/jobs";
import { acquisitionMetrics } from "./analytics/metrics";
import { ADAPTERS, adapterManifests, getAdapter } from "./adapters/registry";
import { searchQueryTemplates } from "./discovery/discovery";
import { INDUSTRIES } from "./discovery/taxonomy";
import { PermanentError } from "./errors";
import { markOutreachSent, optOut, recordPublication, recordReply } from "./outreach/crm";
import { decideApproval, resolveTask, type TaskResolution } from "./pipeline/approvals";
import {
  addUrls,
  approveProfile,
  automationSettings,
  AUTOPILOT_PERMISSIONS,
  createCampaign,
  importCsv,
  pauseCampaign,
  resumeCampaign,
  setAutomationMode,
  upsertProfile,
  type AutomationMode,
  type CampaignInputT,
  type ProfileInputT
} from "./pipeline/campaigns";
import { credentialsAad } from "./pipeline/executor";
import { audit, NotFoundError, SqlTx } from "./sql";
import { InvalidTransitionError } from "./submissions/state";

/* ─────────────────────────────── Row types ──────────────────────────────── */

export interface ScoreFactorRow {
  factor: string;
  points: number;
  max: number;
  reason: string;
}
export interface CampaignDetailRow {
  id: string;
  website_id: string;
  name: string;
  industry: string;
  status: string;
  target_countries: string[];
  target_keywords: string[];
  target_pages: string[];
  preferred_categories: string[];
  min_quality_score: number;
  automation_mode: string | null;
  created_at: Date;
  max_daily_submissions: number;
  max_weekly_submissions: number;
  allowed_adapters: string[];
  excluded_domains: string[];
  approval_required: boolean;
}
export interface OpportunityRow {
  id: string;
  url: string;
  opportunity_type: string;
  adapter_key: string;
  discovery_method: string;
  discovery_source: string;
  status: string;
  score: number | null;
  score_breakdown: ScoreFactorRow[];
  reject_reasons: string[];
  domain: string;
}
export interface SubmissionListRow {
  id: string;
  destination_domain: string;
  adapter_key: string;
  status: string;
  submitted_at: Date | null;
  live_url: string | null;
  verified_at: Date | null;
  lost_at: Date | null;
  link_attributes: Record<string, unknown> | null;
  created_at: Date;
}
export interface SubmissionRow extends SubmissionListRow {
  campaign_id: string;
  website_id: string;
  target_url: string;
  anchor_text: string | null;
  confirmation_text: string | null;
  error_message: string | null;
  first_detected_at: Date | null;
  last_verified_at: Date | null;
  attempt_count: number;
}
export interface EventRow {
  from_status: string | null;
  to_status: string;
  actor_type: string;
  message: string | null;
  data: Record<string, unknown>;
  created_at: Date;
}
export interface EvidenceRow {
  id: string;
  kind: string;
  sha256: string | null;
  bytes: number | null;
  content_type: string | null;
  meta: Record<string, unknown>;
  captured_at: Date;
  has_file: boolean;
  content: string | null;
}
export interface VerificationRow {
  id: string;
  checked_at: Date;
  result: string;
  http_status: number | null;
  anchor_text: string | null;
  rel: string[];
}
export interface OutreachRow {
  id: string;
  outreach_type: string;
  status: string;
  contact_email: string | null;
  contact_source_url: string | null;
  subject: string | null;
  body: string | null;
  sent_at: Date | null;
  followup_count: number;
  editorial_decision: string | null;
  article_url: string | null;
  submission_id: string | null;
  created_at: Date;
}

function toAppError(e: unknown): unknown {
  if (e instanceof AppError) return e;
  if (e instanceof NotFoundError) return new AppError("not_found", e.message.startsWith("Expected exactly") ? "Not found" : e.message);
  if (e instanceof PermanentError) return new AppError("invalid_input", e.message);
  if (e instanceof InvalidTransitionError) return new AppError("conflict", "That item has already moved on. Refresh and try again.");
  if (e instanceof ZodError) {
    const i = e.issues[0];
    return new AppError("invalid_input", i ? `${i.path.join(".") || "Input"}: ${i.message}` : "Invalid input");
  }
  if (isUniqueViolation(e)) return new AppError("conflict", "That already exists");
  return e;
}

async function run<T>(db: Db, actor: Actor, access: WorkspaceAccess, action: Action, fn: (tx: SqlTx, member: Member) => Promise<T>): Promise<T> {
  try {
    return await inWorkspace(db, actor, access, async (tx, member) => {
      requireAction(member.role, action);
      return fn(new SqlTx(tx, access.workspace.id), member);
    });
  } catch (e) {
    throw toAppError(e);
  }
}

/** The website must be visible to this member (RLS client scope); otherwise "not found". */
async function visibleWebsite(tx: SqlTx, websiteId: string): Promise<{ id: string; domain: string; url: string; verification_status: string }> {
  assertId(websiteId, "Website");
  const w = await tx.maybe<{ id: string; domain: string; url: string; verification_status: string }>(
    `select id, domain, url, verification_status from websites where id = $1`,
    [websiteId]
  );
  if (!w) throw new AppError("not_found", "Website not found");
  return w;
}

/* ─────────────────────────────── Overview ───────────────────────────────── */

export async function backlinksOverview(db: Db, actor: Actor, access: WorkspaceAccess, websiteId: string) {
  return run(db, actor, access, "workspace.view", async (tx) => {
    await visibleWebsite(tx, websiteId);
    const [metrics, campaigns, counts, profile, automation] = [
      await acquisitionMetrics(tx, { websiteId }),
      await tx.q<{ id: string; name: string; status: string; created_at: Date; opportunities: number; submissions: number; verified: number }>(
        `select c.id, c.name, c.status, c.created_at,
                (select count(*) from backlink_opportunities o where o.campaign_id = c.id) as opportunities,
                (select count(*) from backlink_submissions s where s.campaign_id = c.id) as submissions,
                (select count(*) from backlink_submissions s where s.campaign_id = c.id and s.status = 'VERIFIED') as verified
           from backlink_campaigns c where c.website_id = $1 order by c.created_at desc`,
        [websiteId]
      ),
      await tx.one<{ approvals: number; tasks: number; outreach: number }>(
        `select (select count(*) from backlink_approvals where website_id = $1 and status = 'pending') as approvals,
                (select count(*) from backlink_tasks where website_id = $1 and status in ('open', 'in_progress')) as tasks,
                (select count(*) from backlink_outreach where website_id = $1 and status in ('awaiting_approval', 'follow_up_due')) as outreach`,
        [websiteId]
      ),
      await tx.maybe<{ status: string; version: number; business_name: string }>(
        `select status, version, business_name from business_profiles where website_id = $1`,
        [websiteId]
      ),
      await automationSettings(tx, websiteId)
    ];
    return { metrics, campaigns, counts, profile, automation };
  });
}

/* ─────────────────────────────── Profile ────────────────────────────────── */

export type BusinessProfileView = ProfileInputT & { status: string; version: number; approved_at: Date | null };

export async function getBusinessProfile(db: Db, actor: Actor, access: WorkspaceAccess, websiteId: string): Promise<BusinessProfileView | null> {
  return run(db, actor, access, "workspace.view", async (tx) => {
    await visibleWebsite(tx, websiteId);
    return tx.maybe<BusinessProfileView>(`select * from business_profiles where website_id = $1`, [websiteId]);
  });
}

export async function saveBusinessProfile(db: Db, actor: Actor, access: WorkspaceAccess, websiteId: string, input: ProfileInputT) {
  return run(db, actor, access, "work.run", async (tx) => {
    await visibleWebsite(tx, websiteId);
    const r = await upsertProfile(tx, access.workspace.id, websiteId, input);
    await audit(tx, access.workspace.id, "user", actor.userId, "backlinks.profile_saved", "website", websiteId, { version: r.version });
    return r;
  });
}

export async function approveBusinessProfile(db: Db, actor: Actor, access: WorkspaceAccess, websiteId: string) {
  return run(db, actor, access, "work.approve", async (tx) => {
    await visibleWebsite(tx, websiteId);
    return approveProfile(tx, access.workspace.id, websiteId, actor.userId);
  });
}

/* ───────────────────────────── Automation ───────────────────────────────── */

export async function getAutomation(db: Db, actor: Actor, access: WorkspaceAccess, websiteId: string) {
  return run(db, actor, access, "workspace.view", async (tx) => {
    await visibleWebsite(tx, websiteId);
    const settings = await automationSettings(tx, websiteId);
    const eligible = await tx.q<{
      id: string;
      name: string;
      domain: string;
      automation_permission: string;
      adapter_key: string;
      organization_id: string | null;
    }>(
      `select id, name, domain, automation_permission, adapter_key, organization_id from backlink_sources
        where automation_permission = any($1::text[]) and curation_status <> 'retired' order by name`,
      [AUTOPILOT_PERMISSIONS]
    );
    return { ...settings, eligibleSources: eligible };
  });
}

export async function setWebsiteAutomation(
  db: Db,
  actor: Actor,
  access: WorkspaceAccess,
  websiteId: string,
  input: { mode: AutomationMode; autopilotSourceIds?: string[]; note?: string | null }
) {
  return run(db, actor, access, "automation.enable", async (tx) => {
    await visibleWebsite(tx, websiteId);
    for (const id of input.autopilotSourceIds ?? []) assertId(id, "Source");
    await setAutomationMode(tx, access.workspace.id, websiteId, actor.userId, input.mode, input.autopilotSourceIds, input.note);
  });
}

/* ─────────────────────────────── Sources ────────────────────────────────── */

export const SOURCE_TYPES = [
  "business_listing",
  "industry_directory",
  "agency_directory",
  "startup_directory",
  "resource_page",
  "guest_post",
  "association",
  "partner",
  "review_platform",
  "other"
] as const;
/** What a workspace may record about a destination. `test_destination` is platform-only. */
export const WORKSPACE_PERMISSIONS = ["none", "manual_only", "tos_permits_form", "explicit_permission", "own_property"] as const;

const SourceInput = z.object({
  name: z.string().trim().min(1).max(200),
  homepageUrl: z.string().url().max(2048),
  submissionUrl: z.string().url().max(2048).nullable().optional(),
  sourceType: z.enum(SOURCE_TYPES),
  adapterKey: z.string().refine((k) => k in ADAPTERS, "Unknown adapter"),
  automationPermission: z.enum(WORKSPACE_PERMISSIONS).default("manual_only"),
  /** Who granted permission and on what basis (required for anything that allows automation). */
  permissionNote: z.string().trim().max(2000).nullable().optional(),
  /** A person reviewed and accepted the destination's terms (forms with a terms checkbox). */
  termsAccepted: z.boolean().default(false),
  apiEndpoint: z.string().url().max(2048).nullable().optional(),
  apiUsername: z.string().max(200).nullable().optional(),
  /** Token or application password issued by the destination. Stored encrypted; never shown again. */
  secret: z.string().max(500).nullable().optional(),
  industries: z.array(z.string()).max(20).default([]),
  countries: z
    .array(z.string().regex(/^[A-Z]{2}$/))
    .max(30)
    .default([])
});
export type SourceInputT = z.input<typeof SourceInput>;

function domainOfUrl(url: string): string {
  const u = new URL(url);
  const host = u.hostname
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/\.$/, "");
  return u.port && u.port !== "80" && u.port !== "443" ? `${host}:${u.port}` : host;
}

export async function listSources(db: Db, actor: Actor, access: WorkspaceAccess) {
  return run(db, actor, access, "workspace.view", (tx) =>
    tx.q<{
      id: string;
      organization_id: string | null;
      domain: string;
      name: string;
      source_type: string;
      adapter_key: string;
      automation_permission: string;
      curation_status: string;
      requires_account: boolean;
      link_type_expected: string | null;
      notes: string | null;
      credentials_hint: string | null;
      homepage_url: string;
      submission_url: string | null;
    }>(
      `select id, organization_id, domain, name, source_type, adapter_key, automation_permission, curation_status, requires_account,
              link_type_expected, notes, credentials_hint, homepage_url, submission_url
         from backlink_sources order by organization_id nulls last, curation_status = 'retired', name`
    )
  );
}

/**
 * Adds or updates a workspace destination. Recording a permission that allows automation needs
 * `automation.enable` and a note saying who granted it; `own_property` additionally needs a verified website
 * on the same domain in this workspace.
 */
export async function saveSource(db: Db, actor: Actor, access: WorkspaceAccess, input: SourceInputT) {
  let s: z.output<typeof SourceInput>;
  try {
    s = SourceInput.parse(input);
  } catch (e) {
    throw toAppError(e);
  }
  const automates = !["none", "manual_only"].includes(s.automationPermission);
  return run(db, actor, access, automates ? "automation.enable" : "work.run", async (tx) => {
    const org = access.workspace.id;
    const domain = domainOfUrl(s.homepageUrl);
    if (automates && !s.permissionNote) throw new AppError("invalid_input", "Record who granted permission and on what basis");
    if (s.automationPermission === "own_property") {
      const own = await tx.maybe(`select 1 from websites where domain = $1 and verification_status = 'verified'`, [domain.replace(/:\d+$/, "")]);
      if (!own) throw new AppError("invalid_input", "Own property requires a verified website on the same domain in this workspace");
    }
    const evidence: Record<string, unknown> =
      automates || s.termsAccepted ? { granted_by: actor.userId, basis: s.permissionNote, recorded_at: new Date().toISOString() } : {};
    if (s.termsAccepted) Object.assign(evidence, { terms_accepted_by: actor.userId, terms_accepted_at: new Date().toISOString() });
    const apiConfig = {
      ...(s.apiEndpoint ? { endpoint: s.apiEndpoint } : {}),
      ...(s.apiUsername ? { username: s.apiUsername, base_url: s.homepageUrl.replace(/\/$/, "") } : {})
    };
    const row = await tx.one<{ id: string }>(
      `insert into backlink_sources (organization_id, domain, name, source_type, industries, countries, homepage_url, submission_url, adapter_key,
          automation_permission, permission_evidence, api_config, curation_status)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'unverified')
       on conflict (organization_id, domain) where organization_id is not null do update set name = excluded.name, source_type = excluded.source_type,
          industries = excluded.industries, countries = excluded.countries, homepage_url = excluded.homepage_url, submission_url = excluded.submission_url,
          adapter_key = excluded.adapter_key, automation_permission = excluded.automation_permission,
          permission_evidence = excluded.permission_evidence, api_config = excluded.api_config
       returning id`,
      [
        org,
        domain,
        s.name,
        s.sourceType,
        s.industries,
        s.countries,
        s.homepageUrl,
        s.submissionUrl ?? null,
        s.adapterKey,
        s.automationPermission,
        JSON.stringify(evidence),
        JSON.stringify(apiConfig)
      ]
    );
    if (s.secret) {
      const field = getAdapter(s.adapterKey).manifest.authentication.kind === "app_password" ? "app_password" : "token";
      await tx.exec(`update backlink_sources set credentials_enc = $2, credentials_hint = $3 where id = $1`, [
        row.id,
        encryptSecret(JSON.stringify({ [field]: s.secret }), credentialsAad(org, row.id)),
        keyHint(s.secret)
      ]);
    }
    await audit(tx, org, "user", actor.userId, "backlinks.source_saved", "backlink_source", row.id, {
      domain,
      permission: s.automationPermission,
      note: s.permissionNote ?? null,
      credentials: s.secret ? "set" : "unchanged"
    });
    return row;
  });
}

/* ─────────────────────────────── Campaigns ──────────────────────────────── */

export async function createBacklinkCampaign(db: Db, actor: Actor, access: WorkspaceAccess, input: CampaignInputT) {
  return run(db, actor, access, "work.run", async (tx) => {
    await visibleWebsite(tx, String(input.websiteId));
    return createCampaign(tx, access.workspace.id, actor.userId, input);
  });
}

async function visibleCampaign(tx: SqlTx, campaignId: string) {
  assertId(campaignId, "Campaign");
  const c = await tx.maybe<{ id: string; website_id: string; status: string }>(
    `select id, website_id, status from backlink_campaigns where id = $1`,
    [campaignId]
  );
  if (!c) throw new AppError("not_found", "Campaign not found");
  return c;
}

export async function pauseBacklinkCampaign(db: Db, actor: Actor, access: WorkspaceAccess, campaignId: string) {
  return run(db, actor, access, "work.run", async (tx) => {
    await visibleCampaign(tx, campaignId);
    return pauseCampaign(tx, access.workspace.id, campaignId, actor.userId);
  });
}

export async function resumeBacklinkCampaign(db: Db, actor: Actor, access: WorkspaceAccess, campaignId: string) {
  return run(db, actor, access, "work.run", async (tx) => {
    await visibleCampaign(tx, campaignId);
    return resumeCampaign(tx, access.workspace.id, campaignId, actor.userId);
  });
}

export async function importOpportunities(
  db: Db,
  actor: Actor,
  access: WorkspaceAccess,
  campaignId: string,
  input: { csv?: string; urls?: string[]; kind?: "generic" | "competitor"; competitor?: string; fileName?: string }
) {
  return run(db, actor, access, "work.run", async (tx) => {
    await visibleCampaign(tx, campaignId);
    if (input.csv)
      return importCsv(tx, access.workspace.id, campaignId, input.csv, {
        kind: input.kind ?? "generic",
        competitor: input.competitor,
        fileName: input.fileName
      });
    return { ...(await addUrls(tx, access.workspace.id, campaignId, input.urls ?? [])), errors: [] as string[] };
  });
}

export async function campaignDetail(db: Db, actor: Actor, access: WorkspaceAccess, campaignId: string) {
  return run(db, actor, access, "workspace.view", async (tx) => {
    await visibleCampaign(tx, campaignId);
    const campaign = await tx.one<CampaignDetailRow>(
      `select c.*, s.max_daily_submissions, s.max_weekly_submissions, s.allowed_adapters, s.excluded_domains, s.approval_required
         from backlink_campaigns c join backlink_campaign_settings s on s.campaign_id = c.id where c.id = $1`,
      [campaignId]
    );
    const opportunities = await tx.q<OpportunityRow>(
      `select o.id, o.url, o.opportunity_type, o.adapter_key, o.discovery_method, o.discovery_source, o.status, o.score, o.score_breakdown,
              o.reject_reasons, p.domain
         from backlink_opportunities o join backlink_prospects p on p.id = o.prospect_id
        where o.campaign_id = $1 order by o.score desc nulls last, o.discovered_at limit 300`,
      [campaignId]
    );
    const submissions = await tx.q<SubmissionListRow>(
      `select id, destination_domain, adapter_key, status, submitted_at, live_url, verified_at, lost_at, link_attributes, created_at
         from backlink_submissions where campaign_id = $1 order by created_at desc`,
      [campaignId]
    );
    const metrics = await acquisitionMetrics(tx, { campaignId });
    return { campaign, opportunities, submissions, metrics, searchTemplates: searchQueryTemplates(campaign) };
  });
}

/* ─────────────────────────── Approvals & tasks ──────────────────────────── */

export async function listApprovals(db: Db, actor: Actor, access: WorkspaceAccess, websiteId: string) {
  return run(db, actor, access, "workspace.view", async (tx) => {
    await visibleWebsite(tx, websiteId);
    return tx.q<{ id: string; subject_id: string; snapshot: Record<string, any>; requested_at: Date; campaign_id: string | null }>(
      `select id, subject_id, snapshot, requested_at, campaign_id from backlink_approvals where website_id = $1 and status = 'pending' order by requested_at`,
      [websiteId]
    );
  });
}

export async function decideBacklinkApproval(
  db: Db,
  actor: Actor,
  access: WorkspaceAccess,
  approvalId: string,
  decision: "approved" | "rejected",
  note?: string
) {
  if (decision !== "approved" && decision !== "rejected") throw new AppError("invalid_input", "Approve or reject");
  return run(db, actor, access, "work.approve", async (tx) => {
    assertId(approvalId, "Approval");
    return decideApproval(tx, approvalId, actor.userId, decision, note?.slice(0, 1000));
  });
}

export async function listBacklinkTasks(db: Db, actor: Actor, access: WorkspaceAccess, websiteId: string) {
  return run(db, actor, access, "workspace.view", async (tx) => {
    await visibleWebsite(tx, websiteId);
    return tx.q<{
      id: string;
      task_type: string;
      title: string;
      instructions: string;
      payload: Record<string, any>;
      status: string;
      submission_id: string | null;
      due_at: Date | null;
      created_at: Date;
    }>(
      `select id, task_type, title, instructions, payload, status, submission_id, due_at, created_at
         from backlink_tasks where website_id = $1 and status in ('open', 'in_progress') order by created_at`,
      [websiteId]
    );
  });
}

export async function resolveBacklinkTask(db: Db, actor: Actor, access: WorkspaceAccess, taskId: string, resolution: TaskResolution) {
  return run(db, actor, access, "work.run", async (tx) => {
    assertId(taskId, "Task");
    return resolveTask(tx, taskId, actor.userId, resolution);
  });
}

/* ───────────────────────────── Submissions ──────────────────────────────── */

export async function submissionDetail(db: Db, actor: Actor, access: WorkspaceAccess, submissionId: string) {
  return run(db, actor, access, "workspace.view", async (tx) => {
    assertId(submissionId, "Submission");
    const submission = await tx.maybe<SubmissionRow>(`select * from backlink_submissions where id = $1`, [submissionId]);
    if (!submission) throw new AppError("not_found", "Submission not found");
    const [events, evidence, verifications, tasks, outreach] = [
      await tx.q<EventRow>(
        `select from_status, to_status, actor_type, message, data, created_at from backlink_submission_events where submission_id = $1 order by id`,
        [submissionId]
      ),
      await tx.q<EvidenceRow>(
        `select id, kind, sha256, bytes, content_type, meta, captured_at, (data is not null) as has_file,
                case when kind in ('confirmation_text', 'note', 'email') then content else null end as content
           from backlink_submission_evidence where submission_id = $1 order by captured_at`,
        [submissionId]
      ),
      await tx.q<VerificationRow>(`select * from backlink_verifications where submission_id = $1 order by checked_at desc limit 50`, [submissionId]),
      await tx.q(`select id, task_type, title, status, created_at from backlink_tasks where submission_id = $1 order by created_at`, [submissionId]),
      await tx.q(`select id, outreach_type, status, contact_email, subject, sent_at from backlink_outreach where submission_id = $1`, [submissionId])
    ];
    return { submission, events, evidence, verifications, tasks, outreach };
  });
}

/** One evidence item's bytes or text, for the download route (same visibility rules as the submission). */
export async function evidenceFile(db: Db, actor: Actor, access: WorkspaceAccess, evidenceId: string) {
  return run(db, actor, access, "workspace.view", async (tx) => {
    assertId(evidenceId, "Evidence");
    const e = await tx.maybe<{ kind: string; content_type: string | null; content: string | null; data: Buffer | null; sha256: string | null }>(
      `select kind, content_type, content, data, sha256 from backlink_submission_evidence where id = $1`,
      [evidenceId]
    );
    if (!e) throw new AppError("not_found", "Evidence not found");
    return e;
  });
}

/* ─────────────────────────────── Outreach ───────────────────────────────── */

export async function listOutreach(db: Db, actor: Actor, access: WorkspaceAccess, websiteId: string) {
  return run(db, actor, access, "workspace.view", async (tx) => {
    await visibleWebsite(tx, websiteId);
    return tx.q<OutreachRow>(
      `select id, outreach_type, status, contact_email, contact_source_url, subject, body, sent_at, followup_count, editorial_decision, article_url, submission_id, created_at
         from backlink_outreach where website_id = $1 order by created_at desc limit 200`,
      [websiteId]
    );
  });
}

async function visibleOutreach(tx: SqlTx, id: string) {
  assertId(id, "Message");
  const o = await tx.maybe(`select id from backlink_outreach where id = $1`, [id]);
  if (!o) throw new AppError("not_found", "Message not found");
}

/** A person approved the message and sent it from their own mailbox. Approving a send needs `work.approve`. */
export async function markOutreachMessageSent(db: Db, actor: Actor, access: WorkspaceAccess, outreachId: string) {
  return run(db, actor, access, "work.approve", async (tx) => {
    await visibleOutreach(tx, outreachId);
    return markOutreachSent(tx, access.workspace.id, outreachId, actor.userId);
  });
}

export async function recordOutreachReply(
  db: Db,
  actor: Actor,
  access: WorkspaceAccess,
  outreachId: string,
  reply: Parameters<typeof recordReply>[4]
) {
  return run(db, actor, access, "work.run", async (tx) => {
    await visibleOutreach(tx, outreachId);
    return recordReply(tx, access.workspace.id, outreachId, actor.userId, { ...reply, text: String(reply.text ?? "").slice(0, 5000) });
  });
}

export async function optOutContact(db: Db, actor: Actor, access: WorkspaceAccess, outreachId: string) {
  return run(db, actor, access, "work.run", async (tx) => {
    await visibleOutreach(tx, outreachId);
    return optOut(tx, access.workspace.id, outreachId, actor.userId);
  });
}

export async function recordOutreachPublication(db: Db, actor: Actor, access: WorkspaceAccess, outreachId: string, articleUrl: string) {
  return run(db, actor, access, "work.run", async (tx) => {
    await visibleOutreach(tx, outreachId);
    return recordPublication(tx, access.workspace.id, outreachId, actor.userId, articleUrl);
  });
}

/* ────────────────────────────── Failed jobs ─────────────────────────────── */

/** Retry a failed backlink job. Handlers re-check state, so this never resubmits blindly. */
export async function retryBacklinkJob(db: Db, actor: Actor, access: WorkspaceAccess, jobId: string) {
  return run(db, actor, access, "work.run", async (tx) => {
    assertId(jobId, "Job");
    const j = await tx.maybe<{ type: string }>(`select type from jobs where id = $1`, [jobId]);
    if (!j || !j.type.startsWith("backlinks.")) throw new AppError("not_found", "Job not found");
    if (!(await requeueJob(tx.tx, jobId))) throw new AppError("conflict", "Only failed or cancelled jobs can be retried");
    await audit(tx, access.workspace.id, "user", actor.userId, "backlinks.job_retried", "job", jobId);
  });
}

/* ─────────────────────────────── Catalogue ──────────────────────────────── */

export const backlinkCatalogue = () => ({ adapters: adapterManifests(), industries: INDUSTRIES.map((i) => ({ key: i.key, label: i.label })) });
