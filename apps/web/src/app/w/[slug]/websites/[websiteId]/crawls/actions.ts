"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { cancelCrawl, startCrawl } from "@sge/core";
import type { ActionResult } from "@/components/form";
import { runAction } from "@/lib/actions";
import { db } from "@/lib/db";
import { processAfterResponse } from "@/lib/jobs";
import { currentActor, requireWorkspace } from "@/lib/session";

export async function startCrawlAction(slug: string, websiteId: string, _: ActionResult): Promise<ActionResult> {
  return runAction(async () => {
    const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
    const crawl = await startCrawl(db(), actor, access, websiteId);
    processAfterResponse(access.workspace.id);
    redirect(`/w/${slug}/websites/${websiteId}/crawls/${crawl.id}`);
  });
}

export async function cancelCrawlAction(slug: string, websiteId: string, crawlId: string, _: ActionResult): Promise<ActionResult> {
  return runAction(async () => {
    const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
    await cancelCrawl(db(), actor, access, crawlId);
    revalidatePath(`/w/${slug}/websites/${websiteId}/crawls/${crawlId}`);
    return { ok: "Crawl cancelled." };
  });
}
