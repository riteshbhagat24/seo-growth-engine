"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient, setClientArchived, updateClient, type ClientInput } from "@sge/core";
import type { ActionResult } from "@/components/form";
import { field, runAction } from "@/lib/actions";
import { db } from "@/lib/db";
import { currentActor, requireWorkspace } from "@/lib/session";

const clientFields = (data: FormData): ClientInput => ({
  name: field(data, "name"),
  website: field(data, "website"),
  contactName: field(data, "contactName"),
  contactEmail: field(data, "contactEmail"),
  notes: field(data, "notes")
});

export async function createClientAction(slug: string, _: ActionResult, data: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
    const c = await createClient(db(), actor, access, clientFields(data));
    redirect(`/w/${slug}/clients/${c.id}`);
  });
}

export async function updateClientAction(slug: string, clientId: string, _: ActionResult, data: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
    await updateClient(db(), actor, access, clientId, clientFields(data));
    revalidatePath(`/w/${slug}/clients/${clientId}`);
    return { ok: "Client saved." };
  });
}

export async function archiveClientAction(slug: string, clientId: string, archived: boolean, _: ActionResult): Promise<ActionResult> {
  return runAction(async () => {
    const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
    await setClientArchived(db(), actor, access, clientId, archived);
    revalidatePath(`/w/${slug}/clients`);
    revalidatePath(`/w/${slug}/clients/${clientId}`);
    return { ok: archived ? "Client archived." : "Client restored." };
  });
}
