"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { analyzePage, cancelAudit, requestCwv, setAuditSchedule, startAudit, type ScheduleFrequency } from "@sge/core";
import type { ActionResult } from "@/components/form";
import { field, runAction } from "@/lib/actions";
import { db } from "@/lib/db";
import { processAfterResponse } from "@/lib/jobs";
import { currentActor, requireWorkspace } from "@/lib/session";

const sitePath = (slug: string, websiteId: string) => `/w/${slug}/websites/${websiteId}`;

export async function startAuditAction(slug: string, websiteId: string, _: ActionResult): Promise<ActionResult> {
  return runAction(async () => {
    const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
    const a = await startAudit(db(), actor, access, websiteId);
    processAfterResponse(access.workspace.id);
    redirect(`${sitePath(slug, websiteId)}/audits/${a.id}`);
  });
}

export async function cancelAuditAction(slug: string, websiteId: string, auditId: string, _: ActionResult): Promise<ActionResult> {
  return runAction(async () => {
    const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
    await cancelAudit(db(), actor, access, auditId);
    revalidatePath(`${sitePath(slug, websiteId)}/audits/${auditId}`);
    return { ok: "Audit stopped." };
  });
}

export async function setScheduleAction(slug: string, websiteId: string, _: ActionResult, data: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
    const frequency = field(data, "frequency") as ScheduleFrequency;
    await setAuditSchedule(db(), actor, access, websiteId, frequency);
    revalidatePath(sitePath(slug, websiteId), "layout");
    return { ok: frequency === "off" ? "Scheduled audits turned off." : `Audits will run ${frequency}.` };
  });
}

export async function requestCwvAction(slug: string, websiteId: string, _: ActionResult, data: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
    await requestCwv(db(), actor, access, websiteId, field(data, "page"));
    processAfterResponse(access.workspace.id);
    revalidatePath(sitePath(slug, websiteId), "layout");
    return { ok: "Measuring… results usually take under a minute." };
  });
}

export async function analyzePageAction(slug: string, websiteId: string, _: ActionResult, data: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
    const r = await analyzePage(db(), actor, access, { websiteId, url: field(data, "page"), keyword: field(data, "keyword") });
    redirect(`${sitePath(slug, websiteId)}/onpage/${r.id}`);
  });
}
