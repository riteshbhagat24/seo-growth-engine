"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  AppError,
  changeMemberRole,
  inviteMember,
  leaveWorkspace,
  removeMember,
  setMemberClientAccess,
  revokeInvitation,
  ROLES,
  transferOwnership,
  updateWorkspace,
  type Role
} from "@sge/core";
import { serverEnv } from "@sge/config";
import type { ActionResult } from "@/components/form";
import { field, runAction } from "@/lib/actions";
import { db } from "@/lib/db";
import { sendActionEmail } from "@/lib/mail";
import { currentActor, requireWorkspace } from "@/lib/session";

function parseRole(v: string): Role {
  if (!(ROLES as readonly string[]).includes(v)) throw new AppError("invalid_input", "Choose a valid role");
  return v as Role;
}

export async function updateGeneralAction(slug: string, _: ActionResult, data: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
    await updateWorkspace(db(), actor, access, { name: field(data, "name") });
    revalidatePath(`/w/${slug}`, "layout");
    return { ok: "Workspace name saved." };
  });
}

export async function updateBrandingAction(slug: string, _: ActionResult, data: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
    const branding: Record<string, string> = {};
    for (const k of ["primary", "accent", "logoUrl"]) {
      const v = field(data, k).trim();
      if (v) branding[k] = v;
    }
    await updateWorkspace(db(), actor, access, { branding });
    revalidatePath(`/w/${slug}`, "layout");
    return { ok: "Branding saved." };
  });
}

export async function inviteAction(slug: string, _: ActionResult, data: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
    const clientIds = data.getAll("clientIds").filter((v): v is string => typeof v === "string" && v !== "");
    const invite = await inviteMember(db(), actor, access, { email: field(data, "email"), role: parseRole(field(data, "role")), clientIds });
    const url = `${serverEnv().APP_URL}/invite/${invite.token}`;
    revalidatePath(`/w/${slug}/settings/members`);
    try {
      const { delivered } = await sendActionEmail({
        to: invite.email,
        subject: `${actor.name} invited you to ${access.workspace.name}`,
        intro: `${actor.name} (${actor.email}) invited you to join the ${access.workspace.name} workspace.`,
        actionLabel: "Accept invitation",
        actionUrl: url,
        outro: `This invitation expires on ${invite.expiresAt.toUTCString()}.`
      });
      if (!delivered) return { ok: `Invitation created. Email is off on this demo, so share this link with ${invite.email}: ${url}` };
      return { ok: `Invitation sent to ${invite.email}.` };
    } catch (err) {
      console.error("[invite] email failed:", (err as Error).message);
      return { error: `Invitation created, but the email couldn't be sent. Share this link with them directly: ${url}` };
    }
  });
}

export async function revokeInvitationAction(slug: string, _: ActionResult, data: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
    await revokeInvitation(db(), actor, access, field(data, "invitationId"));
    revalidatePath(`/w/${slug}/settings/members`);
    return { ok: "Invitation revoked." };
  });
}

export async function changeRoleAction(slug: string, _: ActionResult, data: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
    await changeMemberRole(db(), actor, access, field(data, "membershipId"), parseRole(field(data, "role")));
    revalidatePath(`/w/${slug}/settings/members`);
    return { ok: "Role updated." };
  });
}

export async function removeMemberAction(slug: string, _: ActionResult, data: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
    await removeMember(db(), actor, access, field(data, "membershipId"));
    revalidatePath(`/w/${slug}/settings/members`);
    return { ok: "Member removed." };
  });
}

export async function transferOwnershipAction(slug: string, _: ActionResult, data: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
    await transferOwnership(db(), actor, access, field(data, "membershipId"));
    revalidatePath(`/w/${slug}`, "layout");
    return { ok: "Ownership transferred. You are now an admin." };
  });
}

export async function leaveWorkspaceAction(slug: string, _: ActionResult): Promise<ActionResult> {
  return runAction(async () => {
    const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
    await leaveWorkspace(db(), actor, access);
    redirect("/app");
  });
}

export async function setClientAccessAction(slug: string, _: ActionResult, data: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
    const clientIds = data.getAll("clientIds").filter((v): v is string => typeof v === "string" && v !== "");
    await setMemberClientAccess(db(), actor, access, field(data, "membershipId"), {
      allClients: field(data, "scope") === "all",
      clientIds
    });
    revalidatePath(`/w/${slug}/settings/members`);
    return { ok: "Client access updated." };
  });
}
