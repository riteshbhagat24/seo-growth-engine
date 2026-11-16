import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { can, resolveWorkspace, type Action, type Actor, type WorkspaceAccess } from "@sge/core";
import { getAuth } from "./auth";
import { clientIp } from "./client-ip";
import { db } from "./db";

/** Session for this request (memoised per render). */
export const getSession = cache(async () => {
  const h = await headers(); // read request data first: marks the route dynamic before any setup runs
  return getAuth().api.getSession({ headers: h });
});

/** Only allow same-site relative paths as post-login destinations. */
export function safeNext(next: string | null | undefined, fallback = "/app"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  return next;
}

export async function requireUser(next?: string) {
  const session = await getSession();
  if (!session) redirect(`/sign-in?next=${encodeURIComponent(safeNext(next))}`);
  return session.user;
}

export async function currentActor(): Promise<Actor & { email: string; name: string; emailVerified: boolean }> {
  const user = await requireUser();
  const h = await headers();
  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    emailVerified: user.emailVerified,
    ip: clientIp(h),
    userAgent: h.get("user-agent")
  };
}

/** Membership gate for /w/[slug]. Non-members get a 404, never a hint that it exists. */
export const requireWorkspace = cache(async (slug: string): Promise<WorkspaceAccess> => {
  const user = await requireUser(`/w/${slug}`);
  const access = await resolveWorkspace(db(), user.id, slug);
  if (!access) notFound();
  return access;
});

export async function requirePermission(slug: string, action: Action): Promise<WorkspaceAccess> {
  const access = await requireWorkspace(slug);
  if (!can(access.role, action)) notFound();
  return access;
}
