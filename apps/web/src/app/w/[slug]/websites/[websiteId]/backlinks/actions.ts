"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  approveBusinessProfile,
  createBacklinkCampaign,
  decideBacklinkApproval,
  importOpportunities,
  markOutreachMessageSent,
  optOutContact,
  pauseBacklinkCampaign,
  recordOutreachPublication,
  recordOutreachReply,
  resolveBacklinkTask,
  resumeBacklinkCampaign,
  saveBusinessProfile,
  saveSource,
  setWebsiteAutomation,
  type AutomationMode,
  type TaskResolution
} from "@sge/backlinks";
import { AppError } from "@sge/core";
import type { ActionResult } from "@/components/form";
import { field, runAction } from "@/lib/actions";
import { db } from "@/lib/db";
import { processAfterResponse } from "@/lib/jobs";
import { currentActor, requireWorkspace } from "@/lib/session";

const base = (slug: string, websiteId: string) => `/w/${slug}/websites/${websiteId}/backlinks`;
const lines = (v: string) =>
  v
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
const csvList = (v: string) =>
  v
    .split(/[,\n]/)
    .map((l) => l.trim())
    .filter(Boolean);
const int = (v: string, fallback: number) => (v.trim() === "" || Number.isNaN(Number(v)) ? fallback : Math.round(Number(v)));

async function ctx(slug: string) {
  const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
  return { actor, access };
}

function done(slug: string, websiteId: string, organizationId: string) {
  revalidatePath(base(slug, websiteId), "layout");
  // On serverless hosting there may be no worker: make progress on this workspace's jobs after responding.
  processAfterResponse(organizationId);
}

/* ─────────────────────────────── Profile ────────────────────────────────── */

export async function saveProfileAction(slug: string, websiteId: string, _: ActionResult, data: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const { actor, access } = await ctx(slug);
    const pages = lines(field(data, "target_landing_pages")).map((l) => {
      const [url, ...label] = l.split(/\s+/);
      return { url: url ?? "", label: label.join(" ") || undefined };
    });
    const founderName = field(data, "founder_name").trim();
    const year = field(data, "founded_year").trim();
    const r = await saveBusinessProfile(db(), actor, access, websiteId, {
      business_name: field(data, "business_name"),
      website_url: field(data, "website_url"),
      industry: field(data, "industry"),
      description: field(data, "description"),
      products_services: lines(field(data, "products_services")),
      target_countries: csvList(field(data, "target_countries")).map((c) => c.toUpperCase()),
      contact_email: field(data, "contact_email").trim() || null,
      contact_phone: field(data, "contact_phone").trim() || null,
      logo_url: field(data, "logo_url").trim() || null,
      brand_descriptions: lines(field(data, "brand_descriptions")),
      target_landing_pages: pages,
      target_keywords: lines(field(data, "target_keywords")),
      approved_anchor_texts: lines(field(data, "approved_anchor_texts")),
      founder: founderName ? { name: founderName, title: field(data, "founder_title").trim() || undefined, bio: field(data, "founder_bio").trim() || undefined } : null,
      founded_year: year ? Number(year) : null,
      verified_facts: lines(field(data, "verified_facts"))
    });
    revalidatePath(base(slug, websiteId), "layout");
    return { ok: `Saved as draft (version ${r.version}). Approve it before new content is generated.` };
  });
}

export async function approveProfileAction(slug: string, websiteId: string, _: ActionResult): Promise<ActionResult> {
  return runAction(async () => {
    const { actor, access } = await ctx(slug);
    await approveBusinessProfile(db(), actor, access, websiteId);
    revalidatePath(base(slug, websiteId), "layout");
    return { ok: "Profile approved." };
  });
}

/* ─────────────────────────────── Campaigns ──────────────────────────────── */

export async function createCampaignAction(slug: string, websiteId: string, _: ActionResult, data: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const { actor, access } = await ctx(slug);
    const c = await createBacklinkCampaign(db(), actor, access, {
      websiteId,
      name: field(data, "name"),
      targetPages: lines(field(data, "target_pages")),
      targetKeywords: lines(field(data, "target_keywords")),
      minQualityScore: int(field(data, "min_quality_score"), 50),
      maxDailySubmissions: int(field(data, "max_daily"), 5),
      maxWeeklySubmissions: int(field(data, "max_weekly"), 20),
      approvalRequired: data.get("approval_required") === "on",
      seedUrls: lines(field(data, "seed_urls")),
      excludedDomains: lines(field(data, "excluded_domains"))
    });
    done(slug, websiteId, access.workspace.id);
    redirect(`${base(slug, websiteId)}/campaigns/${c.id}`);
  });
}

export async function pauseCampaignAction(slug: string, websiteId: string, campaignId: string, _: ActionResult): Promise<ActionResult> {
  return runAction(async () => {
    const { actor, access } = await ctx(slug);
    const r = await pauseBacklinkCampaign(db(), actor, access, campaignId);
    revalidatePath(base(slug, websiteId), "layout");
    return { ok: `Paused. ${r.cancelledJobs} queued task(s) cancelled.` };
  });
}

export async function resumeCampaignAction(slug: string, websiteId: string, campaignId: string, _: ActionResult): Promise<ActionResult> {
  return runAction(async () => {
    const { actor, access } = await ctx(slug);
    const r = await resumeBacklinkCampaign(db(), actor, access, campaignId);
    done(slug, websiteId, access.workspace.id);
    return { ok: `Resumed. ${r.requeued} submission(s) re-queued.` };
  });
}

export async function importAction(slug: string, websiteId: string, campaignId: string, _: ActionResult, data: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const { actor, access } = await ctx(slug);
    const file = data.get("file");
    const urls = lines(field(data, "urls"));
    let csv: string | undefined;
    if (file instanceof File && file.size > 0) {
      if (file.size > 2 * 1024 * 1024) throw new AppError("invalid_input", "The file is larger than 2 MB");
      csv = await file.text();
    }
    if (!csv && !urls.length) throw new AppError("invalid_input", "Choose a CSV file or paste URLs");
    const kind = field(data, "kind") === "competitor" ? "competitor" : "generic";
    const r = await importOpportunities(db(), actor, access, campaignId, {
      csv,
      urls,
      kind,
      competitor: field(data, "competitor") || undefined,
      fileName: file instanceof File ? file.name : undefined
    });
    done(slug, websiteId, access.workspace.id);
    return { ok: `Added ${r.created}, ${r.duplicates} already known, ${r.excluded} excluded, ${r.invalid + r.errors.length} invalid. New prospects are checked in the background.` };
  });
}

/* ─────────────────────────── Approvals & tasks ──────────────────────────── */

export async function decideApprovalAction(slug: string, websiteId: string, approvalId: string, decision: "approved" | "rejected", _: ActionResult, data: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const { actor, access } = await ctx(slug);
    await decideBacklinkApproval(db(), actor, access, approvalId, decision, field(data, "note") || undefined);
    done(slug, websiteId, access.workspace.id);
    return { ok: decision === "approved" ? "Approved and queued." : "Rejected." };
  });
}

export async function resolveTaskAction(slug: string, websiteId: string, taskId: string, _: ActionResult, data: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const { actor, access } = await ctx(slug);
    const action = field(data, "action");
    const note = field(data, "note") || undefined;
    let r: TaskResolution;
    if (action === "submitted_manually") r = { action, live_url: field(data, "live_url").trim() || null, note };
    else if (action === "resume" || action === "mark_sent" || action === "dismiss") r = { action, note };
    else throw new AppError("invalid_input", "Choose what happened");
    await resolveBacklinkTask(db(), actor, access, taskId, r);
    done(slug, websiteId, access.workspace.id);
    return { ok: "Done." };
  });
}

/* ─────────────────────────────── Outreach ───────────────────────────────── */

export async function outreachAction(slug: string, websiteId: string, outreachId: string, _: ActionResult, data: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const { actor, access } = await ctx(slug);
    const op = field(data, "op");
    if (op === "sent") await markOutreachMessageSent(db(), actor, access, outreachId);
    else if (op === "opt_out") await optOutContact(db(), actor, access, outreachId);
    else if (op === "published") await recordOutreachPublication(db(), actor, access, outreachId, field(data, "url").trim());
    else if (op === "reply") {
      const decision = field(data, "decision");
      await recordOutreachReply(db(), actor, access, outreachId, {
        text: field(data, "text"),
        decision: decision === "accepted" || decision === "rejected" || decision === "revisions_requested" ? decision : undefined
      });
    } else throw new AppError("invalid_input", "Unknown action");
    done(slug, websiteId, access.workspace.id);
    return { ok: "Saved." };
  });
}

/* ─────────────────────────────── Settings ───────────────────────────────── */

export async function automationAction(slug: string, websiteId: string, _: ActionResult, data: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const { actor, access } = await ctx(slug);
    const mode = field(data, "mode") as AutomationMode;
    await setWebsiteAutomation(db(), actor, access, websiteId, {
      mode,
      autopilotSourceIds: data.getAll("source").filter((v): v is string => typeof v === "string"),
      note: field(data, "note") || null
    });
    revalidatePath(base(slug, websiteId), "layout");
    return { ok: "Automation settings saved." };
  });
}

export async function saveSourceAction(slug: string, websiteId: string, _: ActionResult, data: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const { actor, access } = await ctx(slug);
    await saveSource(db(), actor, access, {
      name: field(data, "name"),
      homepageUrl: field(data, "homepage_url"),
      submissionUrl: field(data, "submission_url").trim() || null,
      sourceType: field(data, "source_type") as never,
      adapterKey: field(data, "adapter_key"),
      automationPermission: (field(data, "permission") || "manual_only") as never,
      permissionNote: field(data, "permission_note").trim() || null,
      termsAccepted: data.get("terms_accepted") === "on",
      apiEndpoint: field(data, "api_endpoint").trim() || null,
      apiUsername: field(data, "api_username").trim() || null,
      secret: field(data, "secret") || null
    });
    revalidatePath(base(slug, websiteId), "layout");
    return { ok: "Destination saved." };
  });
}
