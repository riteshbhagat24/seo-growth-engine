"use server";

import { redirect } from "next/navigation";
import { createAgencyWorkspace } from "@sge/core";
import type { ActionResult } from "@/components/form";
import { field, runAction } from "@/lib/actions";
import { db } from "@/lib/db";
import { currentActor } from "@/lib/session";

export async function createAgencyAction(_: ActionResult, data: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await currentActor();
    const ws = await createAgencyWorkspace(db(), actor, field(data, "name"));
    redirect(`/w/${ws.slug}`);
  });
}
