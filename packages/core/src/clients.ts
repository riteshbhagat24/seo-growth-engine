import { z } from "zod";
import { and, asc, eq, inArray, schema, type Db, type Tx } from "@sge/db";
import type { Client } from "@sge/db/schema";
import { audit } from "./audit";
import { assertId, assertIds, inWorkspace, requireAction, type Actor, type WorkspaceAccess } from "./context";
import { AppError } from "./errors";
import { canManageMember } from "./permissions";
import { assertWithinLimit } from "./plans";

const { clients, memberships, membershipClients, websites } = schema;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : null));

const clientInput = z.object({
  name: z.string().trim().min(2, "Client name must be at least 2 characters").max(120),
  website: optionalText(300).refine((v) => !v || /^https?:\/\/\S+\.\S+/.test(v), "Website must start with http:// or https://"),
  contactName: optionalText(120),
  contactEmail: optionalText(254).refine((v) => !v || z.string().email().safeParse(v).success, "Enter a valid contact email"),
  notes: optionalText(2000)
});
export type ClientInput = z.input<typeof clientInput>;

function parseInput(v: unknown) {
  const r = clientInput.safeParse(v);
  if (!r.success) throw new AppError("invalid_input", r.error.issues[0]?.message ?? "Invalid client details");
  return r.data;
}

function agencyOnly(access: WorkspaceAccess) {
  if (access.workspace.type !== "agency") throw new AppError("forbidden", "Clients are available in agency workspaces");
}

async function getVisibleClient(tx: Tx, organizationId: string, clientId: string): Promise<Client> {
  assertId(clientId, "Client");
  const [c] = await tx.select().from(clients).where(and(eq(clients.id, clientId), eq(clients.organizationId, organizationId)));
  if (!c) throw new AppError("not_found", "Client not found");
  return c;
}

/** Clients the actor may see (RLS applies their client scope). */
export async function listClients(db: Db, actor: Actor, access: WorkspaceAccess, opts: { includeArchived?: boolean } = {}) {
  agencyOnly(access);
  return inWorkspace(db, actor, access, async (tx) => {
    const rows = await tx
      .select()
      .from(clients)
      .where(opts.includeArchived ? eq(clients.organizationId, access.workspace.id) : and(eq(clients.organizationId, access.workspace.id), eq(clients.status, "active")))
      .orderBy(asc(clients.name));
    const counts = await tx
      .select({ clientId: websites.clientId, id: websites.id })
      .from(websites)
      .where(eq(websites.organizationId, access.workspace.id));
    const perClient = new Map<string, number>();
    for (const w of counts) if (w.clientId) perClient.set(w.clientId, (perClient.get(w.clientId) ?? 0) + 1);
    return rows.map((c) => ({ ...c, websiteCount: perClient.get(c.id) ?? 0 }));
  });
}

export async function getClient(db: Db, actor: Actor, access: WorkspaceAccess, clientId: string) {
  agencyOnly(access);
  return inWorkspace(db, actor, access, async (tx) => {
    const client = await getVisibleClient(tx, access.workspace.id, clientId);
    const sites = await tx.select().from(websites).where(eq(websites.clientId, client.id)).orderBy(asc(websites.domain));
    const assigned = await tx
      .select({ membershipId: membershipClients.membershipId })
      .from(membershipClients)
      .where(eq(membershipClients.clientId, client.id));
    return { client, websites: sites, assignedMembershipIds: assigned.map((a) => a.membershipId) };
  });
}

async function requireClientManager(member: { role: Parameters<typeof requireAction>[0]; allClients: boolean }) {
  requireAction(member.role, "clients.manage");
  if (!member.allClients) throw new AppError("forbidden", "Members limited to specific clients can't manage clients");
}

export async function createClient(db: Db, actor: Actor, access: WorkspaceAccess, input: ClientInput): Promise<Client> {
  agencyOnly(access);
  const data = parseInput(input);
  return inWorkspace(db, actor, access, async (tx, member) => {
    await requireClientManager(member);
    await assertWithinLimit(tx, access.workspace.id, "clients");
    const [c] = await tx
      .insert(clients)
      .values({ organizationId: access.workspace.id, ...data })
      .returning();
    await audit(tx, {
      organizationId: access.workspace.id,
      actorUserId: actor.userId,
      action: "client.created",
      entityType: "client",
      entityId: c!.id,
      metadata: { name: c!.name },
      ip: actor.ip,
      userAgent: actor.userAgent
    });
    return c!;
  });
}

export async function updateClient(db: Db, actor: Actor, access: WorkspaceAccess, clientId: string, input: ClientInput): Promise<Client> {
  agencyOnly(access);
  const data = parseInput(input);
  return inWorkspace(db, actor, access, async (tx, member) => {
    await requireClientManager(member);
    const before = await getVisibleClient(tx, access.workspace.id, clientId);
    const [c] = await tx.update(clients).set(data).where(eq(clients.id, clientId)).returning();
    await audit(tx, {
      organizationId: access.workspace.id,
      actorUserId: actor.userId,
      action: "client.updated",
      entityType: "client",
      entityId: clientId,
      metadata: { before: { name: before.name }, after: { name: c!.name } },
      ip: actor.ip,
      userAgent: actor.userAgent
    });
    return c!;
  });
}

export async function setClientArchived(
  db: Db,
  actor: Actor,
  access: WorkspaceAccess,
  clientId: string,
  archived: boolean
): Promise<void> {
  agencyOnly(access);
  await inWorkspace(db, actor, access, async (tx, member) => {
    await requireClientManager(member);
    const c = await getVisibleClient(tx, access.workspace.id, clientId);
    if ((c.status === "archived") === archived) return;
    if (!archived) await assertWithinLimit(tx, access.workspace.id, "clients");
    await tx
      .update(clients)
      .set({ status: archived ? "archived" : "active", archivedAt: archived ? new Date() : null })
      .where(eq(clients.id, clientId));
    await audit(tx, {
      organizationId: access.workspace.id,
      actorUserId: actor.userId,
      action: archived ? "client.archived" : "client.restored",
      entityType: "client",
      entityId: clientId,
      metadata: { name: c.name },
      ip: actor.ip,
      userAgent: actor.userAgent
    });
  });
}

/** Member → assigned client ids, for the members screen. */
export async function listClientAssignments(db: Db, actor: Actor, access: WorkspaceAccess): Promise<Map<string, string[]>> {
  return inWorkspace(db, actor, access, async (tx, { role }) => {
    requireAction(role, "members.view");
    const rows = await tx.select().from(membershipClients).where(eq(membershipClients.organizationId, access.workspace.id));
    const map = new Map<string, string[]>();
    for (const r of rows) map.set(r.membershipId, [...(map.get(r.membershipId) ?? []), r.clientId]);
    return map;
  });
}

/** Give a member access to all clients, or restrict them to a list. */
export async function setMemberClientAccess(
  db: Db,
  actor: Actor,
  access: WorkspaceAccess,
  membershipId: string,
  input: { allClients: boolean; clientIds: string[] }
): Promise<void> {
  agencyOnly(access);
  const clientIds = [...new Set(input.clientIds)];
  assertId(membershipId, "Member");
  assertIds(clientIds, "Client");
  await inWorkspace(db, actor, access, async (tx, member) => {
    requireAction(member.role, "members.manage");
    if (!member.allClients) throw new AppError("forbidden", "Members limited to specific clients can't change access");
    if (membershipId === member.membershipId) throw new AppError("forbidden", "You can't change your own access");
    const [target] = await tx
      .select()
      .from(memberships)
      .where(and(eq(memberships.id, membershipId), eq(memberships.organizationId, access.workspace.id)));
    if (!target) throw new AppError("not_found", "Member not found");
    if (!canManageMember(member.role, target.role)) throw new AppError("forbidden", "You don't have permission to do that");
    const allClients = input.allClients && target.role !== "client";
    if (!allClients && clientIds.length === 0) throw new AppError("invalid_input", "Choose at least one client");
    if (clientIds.length > 0) {
      const found = await tx.select({ id: clients.id }).from(clients).where(and(inArray(clients.id, clientIds), eq(clients.status, "active")));
      if (found.length !== clientIds.length) throw new AppError("invalid_input", "One of the selected clients doesn't exist");
    }
    await tx.update(memberships).set({ allClients }).where(eq(memberships.id, membershipId));
    await tx.delete(membershipClients).where(eq(membershipClients.membershipId, membershipId));
    if (!allClients)
      await tx
        .insert(membershipClients)
        .values(clientIds.map((clientId) => ({ organizationId: access.workspace.id, membershipId, clientId })));
    await audit(tx, {
      organizationId: access.workspace.id,
      actorUserId: actor.userId,
      action: "member.client_access_changed",
      entityType: "membership",
      entityId: membershipId,
      metadata: { userId: target.userId, allClients, clientIds: allClients ? [] : clientIds },
      ip: actor.ip,
      userAgent: actor.userAgent
    });
  });
}
