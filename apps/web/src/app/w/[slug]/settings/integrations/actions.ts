"use server";

import { redirect } from "next/navigation";
import { removeApiKey, setApiKey } from "@sge/core";
import type { ActionResult } from "@/components/form";
import { field, runAction } from "@/lib/actions";
import { db } from "@/lib/db";
import { currentActor, requireWorkspace } from "@/lib/session";

export async function savePsiKeyAction(slug: string, _: ActionResult, data: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
    await setApiKey(db(), actor, access, "psi", field(data, "key"));
    redirect(`/w/${slug}/settings/integrations?saved=psi`);
  });
}

export async function removePsiKeyAction(slug: string, _: ActionResult): Promise<ActionResult> {
  return runAction(async () => {
    const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
    await removeApiKey(db(), actor, access, "psi");
    redirect(`/w/${slug}/settings/integrations?removed=psi`);
  });
}
