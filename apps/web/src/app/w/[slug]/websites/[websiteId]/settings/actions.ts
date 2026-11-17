"use server";

import { revalidatePath } from "next/cache";
import { setWebsiteProperties, syncWebsiteNow } from "@sge/core";
import type { ActionResult } from "@/components/form";
import { field, runAction } from "@/lib/actions";
import { db } from "@/lib/db";
import { processAfterResponse } from "@/lib/jobs";
import { currentActor, requireWorkspace } from "@/lib/session";

export async function setPropertiesAction(slug: string, websiteId: string, _: ActionResult, data: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
    const r = await setWebsiteProperties(db(), actor, access, websiteId, { gsc: field(data, "gsc") || null, ga4: field(data, "ga4") || null });
    processAfterResponse(access.workspace.id);
    revalidatePath(`/w/${slug}/websites/${websiteId}`, "layout");
    return {
      ok: `Saved. Importing data now: the last 28 days first, then up to 16 months of history.${r.verified ? " Ownership verified through Search Console." : ""}`
    };
  });
}

export async function syncNowAction(slug: string, websiteId: string, _: ActionResult): Promise<ActionResult> {
  return runAction(async () => {
    const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
    const n = await syncWebsiteNow(db(), actor, access, websiteId);
    processAfterResponse(access.workspace.id);
    revalidatePath(`/w/${slug}/websites/${websiteId}`, "layout");
    return { ok: n ? "Sync started." : "A sync was started a few minutes ago; try again shortly." };
  });
}
