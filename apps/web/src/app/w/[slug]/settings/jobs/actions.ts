"use server";

import { revalidatePath } from "next/cache";
import { retryBacklinkJob } from "@sge/backlinks";
import type { ActionResult } from "@/components/form";
import { runAction } from "@/lib/actions";
import { db } from "@/lib/db";
import { currentActor, requireWorkspace } from "@/lib/session";

/** Re-queue a failed backlink job. The handler re-checks the submission, so nothing is resubmitted blindly. */
export async function retryJobAction(slug: string, jobId: string, _: ActionResult): Promise<ActionResult> {
  return runAction(async () => {
    const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
    await retryBacklinkJob(db(), actor, access, jobId);
    revalidatePath(`/w/${slug}/settings/jobs`);
    return { ok: "Queued" };
  });
}
