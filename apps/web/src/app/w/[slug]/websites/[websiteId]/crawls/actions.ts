"use server";

import { revalidatePath } from "next/cache";
import { cancelCrawl } from "@sge/core";
import type { ActionResult } from "@/components/form";
import { runAction } from "@/lib/actions";
import { db } from "@/lib/db";
import { currentActor, requireWorkspace } from "@/lib/session";

export async function cancelCrawlAction(slug: string, websiteId: string, crawlId: string, _: ActionResult): Promise<ActionResult> {
  return runAction(async () => {
    const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
    await cancelCrawl(db(), actor, access, crawlId);
    revalidatePath(`/w/${slug}/websites/${websiteId}/crawls/${crawlId}`);
    return { ok: "Crawl cancelled." };
  });
}
