"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { addWebsite, AppError, deleteWebsite, updateWebsite, verifyWebsite, type VerificationMethod } from "@sge/core";
import type { ActionResult } from "@/components/form";
import { field, runAction } from "@/lib/actions";
import { db } from "@/lib/db";
import { currentActor, requireWorkspace } from "@/lib/session";

export async function addWebsiteAction(slug: string, _: ActionResult, data: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
    const w = await addWebsite(db(), actor, access, {
      url: field(data, "url"),
      displayName: field(data, "displayName"),
      clientId: field(data, "clientId") || null
    });
    redirect(`/w/${slug}/websites/${w.id}`);
  });
}

export async function updateWebsiteAction(slug: string, websiteId: string, _: ActionResult, data: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
    await updateWebsite(db(), actor, access, websiteId, {
      displayName: field(data, "displayName"),
      ...(data.has("clientId") ? { clientId: field(data, "clientId") || null } : {})
    });
    revalidatePath(`/w/${slug}/websites/${websiteId}`, "layout");
    return { ok: "Saved." };
  });
}

export async function verifyWebsiteAction(slug: string, websiteId: string, _: ActionResult, data: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
    const method = field(data, "method");
    if (!["dns_txt", "meta_tag", "html_file"].includes(method)) throw new AppError("invalid_input", "Choose a verification method");
    const r = await verifyWebsite(db(), actor, access, websiteId, method as VerificationMethod);
    revalidatePath(`/w/${slug}/websites/${websiteId}`, "layout");
    revalidatePath(`/w/${slug}/websites`);
    return r.verified ? { ok: "Verified. You own this website." } : { error: r.reason ?? "Verification failed" };
  });
}

export async function deleteWebsiteAction(slug: string, websiteId: string, _: ActionResult): Promise<ActionResult> {
  return runAction(async () => {
    const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
    await deleteWebsite(db(), actor, access, websiteId);
    redirect(`/w/${slug}/websites`);
  });
}
