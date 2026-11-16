import { randomBytes } from "node:crypto";
import { z } from "zod";
import { uuidv7 } from "uuidv7";
import { and, eq, sql, schema, setTenant, withContext, type Db, type Tx } from "@sge/db";
import type { Organization, OrgBranding } from "@sge/db/schema";
import { audit, listAuditLogs } from "./audit";
import { AppError, isUniqueViolation } from "./errors";
import { can, canAssignRole, canManageMember, type Action, type Role } from "./permissions";
import { hashToken, isWellFormedToken, newToken } from "./tokens";

const { organizations, memberships, invitations } = schema;

export interface Actor {
  userId: string;
  ip?: string | null;
  userAgent?: string | null;
}

export interface WorkspaceRef {
  id: string;
  slug: string;
  name: string;
  type: Organization["type"];
  branding: OrgBranding;
}

export interface WorkspaceAccess {
  workspace: WorkspaceRef;
  membershipId: string;
  role: Role;
}

export const INVITATION_TTL_DAYS = 7;

const nameSchema = z.string().trim().min(2, "Name must be at least 2 characters").max(80);
const emailSchema = z.string().trim().toLowerCase().email("Enter a valid email address").max(254);
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a hex colour like #1f4e79");
const brandingSchema = z
  .object({
    logoUrl: z
      .string()
      .url()
      .max(500)
      .refine((u) => u.startsWith("https://"), "Logo URL must use https")
      .optional()
      .or(z.literal("").transform(() => undefined)),
    primary: hexColor.optional(),
    accent: hexColor.optional()
  })
  .strict();

function parse<T>(s: z.ZodType<T>, v: unknown): T {
  const r = s.safeParse(v);
  if (!r.success) throw new AppError("invalid_input", r.error.issues[0]?.message ?? "Invalid input");
  return r.data;
}

function slugFor(name: string): string {
  const base =
    name
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "workspace";
  return `${base}-${randomBytes(3).toString("hex")}`;
}

async function identity(tx: Tx): Promise<{ email: string; emailVerified: boolean; name: string } | null> {
  const r = await tx.execute<{ email: string; email_verified: boolean; name: string }>(
    sql`select email, email_verified, name from current_user_identity()`
  );
  const row = r.rows[0];
  return row ? { email: row.email, emailVerified: row.email_verified, name: row.name } : null;
}

/** The actor's role as of this transaction (defeats stale-role races). */
async function freshRole(tx: Tx, organizationId: string, userId: string): Promise<{ role: Role; membershipId: string }> {
  const [m] = await tx
    .select({ role: memberships.role, id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.organizationId, organizationId), eq(memberships.userId, userId)));
  if (!m) throw new AppError("not_found", "Workspace not found");
  return { role: m.role, membershipId: m.id };
}

function requireAction(role: Role, action: Action): void {
  if (!can(role, action)) throw new AppError("forbidden", "You don't have permission to do that");
}

/** Runs `fn` as `actor` inside `access.workspace`, with the actor's current role. */
async function inWorkspace<T>(
  db: Db,
  actor: Actor,
  access: WorkspaceAccess,
  fn: (tx: Tx, role: Role, membershipId: string) => Promise<T>
): Promise<T> {
  return withContext(db, { userId: actor.userId, organizationId: access.workspace.id }, async (tx) => {
    const { role, membershipId } = await freshRole(tx, access.workspace.id, actor.userId);
    return fn(tx, role, membershipId);
  });
}

const toRef = (o: Organization): WorkspaceRef => ({
  id: o.id,
  slug: o.slug,
  name: o.name,
  type: o.type,
  branding: o.branding
});

/* ─────────────────────────────── Workspaces ─────────────────────────────── */

async function createWorkspace(
  db: Db,
  actor: Actor,
  input: { name: string; type: "personal" | "agency" }
): Promise<WorkspaceRef> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = uuidv7();
    try {
      return await withContext(db, { userId: actor.userId, organizationId: id }, async (tx) => {
        const [org] = await tx
          .insert(organizations)
          .values({
            id,
            slug: slugFor(input.name),
            name: input.name,
            type: input.type,
            personalOwnerUserId: input.type === "personal" ? actor.userId : null,
            createdByUserId: actor.userId
          })
          .returning();
        await tx.insert(memberships).values({ organizationId: id, userId: actor.userId, role: "owner" });
        await audit(tx, {
          organizationId: id,
          actorUserId: actor.userId,
          action: "workspace.created",
          entityType: "organization",
          entityId: id,
          metadata: { type: input.type, name: input.name },
          ip: actor.ip,
          userAgent: actor.userAgent
        });
        return toRef(org!);
      });
    } catch (e) {
      if (isUniqueViolation(e, "organizations_slug_unique")) continue; // retry with a new suffix
      throw e;
    }
  }
  throw new AppError("conflict", "Could not create a unique workspace address; try again");
}

/** Idempotent: returns the user's personal workspace, creating it once. */
export async function ensurePersonalWorkspace(db: Db, actor: Actor, displayName: string): Promise<WorkspaceRef> {
  const find = () =>
    withContext(db, { userId: actor.userId }, (tx) =>
      tx.select().from(organizations).where(eq(organizations.personalOwnerUserId, actor.userId))
    );
  const [existing] = await find();
  if (existing) return toRef(existing);
  const first = displayName.trim().split(/\s+/)[0] || "My";
  try {
    return await createWorkspace(db, actor, { name: `${first}'s workspace`.slice(0, 80), type: "personal" });
  } catch (e) {
    // Two concurrent first logins: the unique constraint picks one winner.
    if (isUniqueViolation(e, "organizations_personal_owner_user_id_unique")) {
      const [row] = await find();
      if (row) return toRef(row);
    }
    throw e;
  }
}

export async function createAgencyWorkspace(db: Db, actor: Actor, rawName: string): Promise<WorkspaceRef> {
  const name = parse(nameSchema, rawName);
  const who = await withContext(db, { userId: actor.userId }, identity);
  if (!who?.emailVerified) throw new AppError("email_not_verified", "Verify your email before creating an agency workspace");
  return createWorkspace(db, actor, { name, type: "agency" });
}

export interface MyWorkspace extends WorkspaceRef {
  role: Role;
}

export async function listMyWorkspaces(db: Db, userId: string): Promise<MyWorkspace[]> {
  const rows = await withContext(db, { userId }, (tx) =>
    tx
      .select({ org: organizations, role: memberships.role })
      .from(memberships)
      .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
      .where(and(eq(memberships.userId, userId), eq(organizations.status, "active")))
  );
  return rows
    .map((r) => ({ ...toRef(r.org), role: r.role }))
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "personal" ? -1 : 1));
}

/** Membership check for a request. null => render 404 (never reveal existence). */
export async function resolveWorkspace(db: Db, userId: string, slug: string): Promise<WorkspaceAccess | null> {
  if (!/^[a-z0-9-]{1,60}$/.test(slug)) return null;
  const [row] = await withContext(db, { userId }, (tx) =>
    tx
      .select({ org: organizations, role: memberships.role, membershipId: memberships.id })
      .from(organizations)
      .innerJoin(memberships, and(eq(memberships.organizationId, organizations.id), eq(memberships.userId, userId)))
      .where(and(eq(organizations.slug, slug), eq(organizations.status, "active")))
  );
  return row ? { workspace: toRef(row.org), role: row.role, membershipId: row.membershipId } : null;
}

export async function updateWorkspace(
  db: Db,
  actor: Actor,
  access: WorkspaceAccess,
  input: { name?: string; branding?: unknown }
): Promise<WorkspaceRef> {
  return inWorkspace(db, actor, access, async (tx, role) => {
    const patch: Partial<typeof organizations.$inferInsert> = {};
    if (input.name !== undefined) {
      requireAction(role, "workspace.update");
      patch.name = parse(nameSchema, input.name);
    }
    if (input.branding !== undefined) {
      requireAction(role, "branding.manage");
      patch.branding = parse(brandingSchema, input.branding) as OrgBranding;
    }
    if (Object.keys(patch).length === 0) throw new AppError("invalid_input", "Nothing to update");
    const [before] = await tx.select().from(organizations).where(eq(organizations.id, access.workspace.id));
    const [org] = await tx.update(organizations).set(patch).where(eq(organizations.id, access.workspace.id)).returning();
    await audit(tx, {
      organizationId: access.workspace.id,
      actorUserId: actor.userId,
      action: "workspace.updated",
      entityType: "organization",
      entityId: access.workspace.id,
      metadata: {
        before: { name: before?.name, branding: before?.branding },
        after: { name: org!.name, branding: org!.branding }
      },
      ip: actor.ip,
      userAgent: actor.userAgent
    });
    return toRef(org!);
  });
}

/* ──────────────────────────────── Members ───────────────────────────────── */

export interface MemberProfile {
  membershipId: string;
  userId: string;
  name: string;
  email: string;
  image: string | null;
  role: Role;
  joinedAt: Date;
}

async function memberProfiles(tx: Tx): Promise<MemberProfile[]> {
  const r = await tx.execute<{
    membership_id: string;
    user_id: string;
    name: string;
    email: string;
    image: string | null;
    role: Role;
    joined_at: string | Date;
  }>(sql`select * from org_member_profiles()`);
  return r.rows.map((m) => ({
    membershipId: m.membership_id,
    userId: m.user_id,
    name: m.name,
    email: m.email,
    image: m.image,
    role: m.role,
    joinedAt: new Date(m.joined_at)
  }));
}

export async function listMembers(db: Db, actor: Actor, access: WorkspaceAccess): Promise<MemberProfile[]> {
  return inWorkspace(db, actor, access, async (tx, role) => {
    requireAction(role, "members.view");
    return memberProfiles(tx);
  });
}

async function targetMembership(tx: Tx, organizationId: string, membershipId: string) {
  const [m] = await tx
    .select()
    .from(memberships)
    .where(and(eq(memberships.id, membershipId), eq(memberships.organizationId, organizationId)));
  if (!m) throw new AppError("not_found", "Member not found");
  return m;
}

export async function changeMemberRole(
  db: Db,
  actor: Actor,
  access: WorkspaceAccess,
  membershipId: string,
  newRole: Role
): Promise<void> {
  await inWorkspace(db, actor, access, async (tx, role, ownId) => {
    if (membershipId === ownId) throw new AppError("forbidden", "You can't change your own role");
    const target = await targetMembership(tx, access.workspace.id, membershipId);
    if (!canManageMember(role, target.role) || !canAssignRole(role, newRole))
      throw new AppError("forbidden", "You don't have permission to do that");
    if (newRole === "client") throw new AppError("invalid_input", "Client access is set up from client management");
    await tx.update(memberships).set({ role: newRole }).where(eq(memberships.id, membershipId));
    await audit(tx, {
      organizationId: access.workspace.id,
      actorUserId: actor.userId,
      action: "member.role_changed",
      entityType: "membership",
      entityId: membershipId,
      metadata: { userId: target.userId, from: target.role, to: newRole },
      ip: actor.ip,
      userAgent: actor.userAgent
    });
  });
}

export async function removeMember(db: Db, actor: Actor, access: WorkspaceAccess, membershipId: string): Promise<void> {
  await inWorkspace(db, actor, access, async (tx, role, ownId) => {
    if (membershipId === ownId) throw new AppError("invalid_input", "Use “Leave workspace” to remove yourself");
    const target = await targetMembership(tx, access.workspace.id, membershipId);
    if (!canManageMember(role, target.role)) throw new AppError("forbidden", "You don't have permission to do that");
    await tx.delete(memberships).where(eq(memberships.id, membershipId));
    await audit(tx, {
      organizationId: access.workspace.id,
      actorUserId: actor.userId,
      action: "member.removed",
      entityType: "membership",
      entityId: membershipId,
      metadata: { userId: target.userId, role: target.role },
      ip: actor.ip,
      userAgent: actor.userAgent
    });
  });
}

export async function leaveWorkspace(db: Db, actor: Actor, access: WorkspaceAccess): Promise<void> {
  await inWorkspace(db, actor, access, async (tx, role, ownId) => {
    if (access.workspace.type === "personal") throw new AppError("forbidden", "You can't leave your personal workspace");
    if (role === "owner") throw new AppError("last_owner", "Transfer ownership to another member before leaving");
    await audit(tx, {
      organizationId: access.workspace.id,
      actorUserId: actor.userId,
      action: "member.left",
      entityType: "membership",
      entityId: ownId,
      ip: actor.ip,
      userAgent: actor.userAgent
    });
    await tx.delete(memberships).where(eq(memberships.id, ownId));
  });
}

export async function transferOwnership(
  db: Db,
  actor: Actor,
  access: WorkspaceAccess,
  toMembershipId: string
): Promise<void> {
  await inWorkspace(db, actor, access, async (tx, role, ownId) => {
    requireAction(role, "workspace.transfer");
    if (access.workspace.type === "personal") throw new AppError("forbidden", "Personal workspaces can't be transferred");
    if (toMembershipId === ownId) throw new AppError("invalid_input", "You already own this workspace");
    const target = await targetMembership(tx, access.workspace.id, toMembershipId);
    if (target.role === "client") throw new AppError("invalid_input", "Client users can't own a workspace");
    // Demote first: the one-owner unique index forbids two owners at any instant.
    await tx.update(memberships).set({ role: "admin" }).where(eq(memberships.id, ownId));
    await tx.update(memberships).set({ role: "owner" }).where(eq(memberships.id, toMembershipId));
    await audit(tx, {
      organizationId: access.workspace.id,
      actorUserId: actor.userId,
      action: "ownership.transferred",
      entityType: "membership",
      entityId: toMembershipId,
      metadata: { fromUserId: actor.userId, toUserId: target.userId, previousRole: target.role },
      ip: actor.ip,
      userAgent: actor.userAgent
    });
  });
}

/* ────────────────────────────── Invitations ─────────────────────────────── */

export async function inviteMember(
  db: Db,
  actor: Actor,
  access: WorkspaceAccess,
  input: { email: string; role: Role }
): Promise<{ token: string; invitationId: string; email: string; expiresAt: Date }> {
  const email = parse(emailSchema, input.email);
  return inWorkspace(db, actor, access, async (tx, role) => {
    requireAction(role, "members.manage");
    if (access.workspace.type === "personal")
      throw new AppError("forbidden", "Personal workspaces don't have teams. Create an agency workspace to invite people.");
    if (input.role === "client") throw new AppError("invalid_input", "Client access is set up from client management");
    if (!canAssignRole(role, input.role)) throw new AppError("forbidden", "You can't grant that role");
    const members = await memberProfiles(tx);
    if (members.some((m) => m.email.toLowerCase() === email))
      throw new AppError("conflict", "That person is already a member");

    const token = newToken();
    const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * 86_400_000);
    try {
      const [inv] = await tx
        .insert(invitations)
        .values({
          organizationId: access.workspace.id,
          email,
          role: input.role,
          tokenHash: hashToken(token),
          invitedByUserId: actor.userId,
          expiresAt
        })
        .returning({ id: invitations.id });
      await audit(tx, {
        organizationId: access.workspace.id,
        actorUserId: actor.userId,
        action: "member.invited",
        entityType: "invitation",
        entityId: inv!.id,
        metadata: { email, role: input.role },
        ip: actor.ip,
        userAgent: actor.userAgent
      });
      return { token, invitationId: inv!.id, email, expiresAt };
    } catch (e) {
      if (isUniqueViolation(e, "invitations_pending_email_uq"))
        throw new AppError("conflict", "There is already a pending invitation for that email");
      throw e;
    }
  });
}

export async function listPendingInvitations(db: Db, actor: Actor, access: WorkspaceAccess) {
  return inWorkspace(db, actor, access, async (tx, role) => {
    requireAction(role, "members.manage");
    return tx
      .select({
        id: invitations.id,
        email: invitations.email,
        role: invitations.role,
        expiresAt: invitations.expiresAt,
        createdAt: invitations.createdAt
      })
      .from(invitations)
      .where(and(eq(invitations.organizationId, access.workspace.id), eq(invitations.status, "pending")))
      .orderBy(invitations.createdAt);
  });
}

export async function revokeInvitation(
  db: Db,
  actor: Actor,
  access: WorkspaceAccess,
  invitationId: string
): Promise<void> {
  await inWorkspace(db, actor, access, async (tx, role) => {
    requireAction(role, "members.manage");
    const [inv] = await tx
      .update(invitations)
      .set({ status: "revoked" })
      .where(
        and(
          eq(invitations.id, invitationId),
          eq(invitations.organizationId, access.workspace.id),
          eq(invitations.status, "pending")
        )
      )
      .returning({ id: invitations.id, email: invitations.email });
    if (!inv) throw new AppError("not_found", "Invitation not found");
    await audit(tx, {
      organizationId: access.workspace.id,
      actorUserId: actor.userId,
      action: "invitation.revoked",
      entityType: "invitation",
      entityId: inv.id,
      metadata: { email: inv.email },
      ip: actor.ip,
      userAgent: actor.userAgent
    });
  });
}

export type InvitationState = "valid" | "expired" | "accepted" | "revoked";

export interface InvitationPreview {
  workspaceName: string;
  workspaceType: Organization["type"];
  email: string;
  role: Role;
  state: InvitationState;
}

export async function previewInvitation(db: Db, token: string): Promise<InvitationPreview | null> {
  if (!isWellFormedToken(token)) return null;
  const [row] = await withContext(db, { inviteTokenHash: hashToken(token) }, (tx) =>
    tx
      .select({ inv: invitations, orgName: organizations.name, orgType: organizations.type })
      .from(invitations)
      .innerJoin(organizations, eq(organizations.id, invitations.organizationId))
  );
  if (!row) return null;
  const state: InvitationState =
    row.inv.status === "accepted"
      ? "accepted"
      : row.inv.status === "revoked"
        ? "revoked"
        : row.inv.expiresAt < new Date()
          ? "expired"
          : "valid";
  return { workspaceName: row.orgName, workspaceType: row.orgType, email: row.inv.email, role: row.inv.role, state };
}

/** Joins the workspace. Returns its slug. Email must match and be verified. */
export async function acceptInvitation(db: Db, actor: Actor, token: string): Promise<string> {
  if (!isWellFormedToken(token)) throw new AppError("invitation_invalid", "This invitation link is not valid");
  const tokenHash = hashToken(token);
  return withContext(db, { userId: actor.userId, inviteTokenHash: tokenHash }, async (tx) => {
    const [found] = await tx.select().from(invitations).where(eq(invitations.tokenHash, tokenHash));
    if (!found) throw new AppError("invitation_invalid", "This invitation link is not valid");

    // Enter the tenant so the row can be locked and the membership written.
    await setTenant(tx, found.organizationId);
    const [inv] = await tx.select().from(invitations).where(eq(invitations.id, found.id)).for("update");
    if (!inv || inv.status !== "pending") throw new AppError("invitation_invalid", "This invitation is no longer valid");
    if (inv.expiresAt < new Date()) throw new AppError("invitation_expired", "This invitation has expired");
    if (inv.role === "owner") throw new AppError("invitation_invalid", "This invitation is not valid");

    const who = await identity(tx);
    if (!who) throw new AppError("forbidden", "Sign in to accept this invitation");
    if (!who.emailVerified) throw new AppError("email_not_verified", "Verify your email before joining a workspace");
    if (who.email.toLowerCase() !== inv.email.toLowerCase())
      throw new AppError("email_mismatch", `This invitation was sent to ${inv.email}. Sign in with that address to accept it.`);

    await tx
      .insert(memberships)
      .values({ organizationId: inv.organizationId, userId: actor.userId, role: inv.role })
      .onConflictDoNothing({ target: [memberships.organizationId, memberships.userId] });
    await tx
      .update(invitations)
      .set({ status: "accepted", acceptedByUserId: actor.userId, acceptedAt: new Date() })
      .where(eq(invitations.id, inv.id));
    await audit(tx, {
      organizationId: inv.organizationId,
      actorUserId: actor.userId,
      action: "invitation.accepted",
      entityType: "invitation",
      entityId: inv.id,
      metadata: { role: inv.role },
      ip: actor.ip,
      userAgent: actor.userAgent
    });
    const [org] = await tx.select({ slug: organizations.slug }).from(organizations).where(eq(organizations.id, inv.organizationId));
    return org!.slug;
  });
}

/* ───────────────────────────────── Audit ────────────────────────────────── */

export async function listWorkspaceAudit(db: Db, actor: Actor, access: WorkspaceAccess, limit = 100) {
  return inWorkspace(db, actor, access, async (tx, role) => {
    requireAction(role, "audit.view");
    return listAuditLogs(tx, access.workspace.id, limit);
  });
}
