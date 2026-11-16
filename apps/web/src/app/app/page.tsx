import { redirect } from "next/navigation";
import { ensurePersonalWorkspace, listMyWorkspaces } from "@sge/core";
import { db } from "@/lib/db";
import { currentActor } from "@/lib/session";

/** Entry point after sign-in: guarantees a personal workspace, then opens one. */
export default async function AppEntry() {
  const actor = await currentActor();
  const personal = await ensurePersonalWorkspace(db(), actor, actor.name);
  const workspaces = await listMyWorkspaces(db(), actor.userId);
  redirect(`/w/${(workspaces[0] ?? personal).slug}`);
}
