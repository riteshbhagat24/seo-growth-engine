"use server";

import { redirect } from "next/navigation";
import { acceptInvitation } from "@sge/core";
import type { ActionResult } from "@/components/form";
import { runAction } from "@/lib/actions";
import { db } from "@/lib/db";
import { currentActor } from "@/lib/session";

export async function acceptInvitationAction(token: string, _: ActionResult): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await currentActor();
    const slug = await acceptInvitation(db(), actor, token);
    redirect(`/w/${slug}`);
  });
}
