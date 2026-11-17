import { redirect } from "next/navigation";
import { ensurePersonalWorkspace, listMyWorkspaces } from "@sge/core";
import { db } from "@/lib/db";
import { currentActor } from "@/lib/session";

const GOOGLE_STATUS = /^[a-z_]{1,20}$/;

/** Entry point after sign-in: guarantees a personal workspace, then opens one. */
export default async function AppEntry({ searchParams }: PageProps<"/app">) {
  const sp = await searchParams;
  const actor = await currentActor();
  const personal = await ensurePersonalWorkspace(db(), actor, actor.name);
  const workspaces = await listMyWorkspaces(db(), actor.userId);
  const slug = (workspaces[0] ?? personal).slug;
  // A Google connection attempt that lost its context still gets its message shown.
  if (typeof sp.google === "string" && GOOGLE_STATUS.test(sp.google)) redirect(`/w/${slug}/settings/integrations?google=${sp.google}`);
  redirect(`/w/${slug}`);
}
