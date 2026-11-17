import { and, eq, schema, setClientScope, withContext, type Db, type Tx } from "@sge/db";
import type { Organization, OrgBranding } from "@sge/db/schema";
import { AppError } from "./errors";
import { can, type Action, type Role } from "./permissions";

const { organizations, memberships, membershipClients } = schema;

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
  /** false => restricted to `clientIds` (always false for the client role). */
  allClients: boolean;
  clientIds: string[];
}

/** The actor's membership as of this transaction (defeats stale-role races). */
export interface Member {
  role: Role;
  membershipId: string;
  allClients: boolean;
  clientIds: string[];
}

export const toRef = (o: Organization): WorkspaceRef => ({
  id: o.id,
  slug: o.slug,
  name: o.name,
  type: o.type,
  branding: o.branding
});

async function assignedClientIds(tx: Tx, membershipId: string): Promise<string[]> {
  const rows = await tx
    .select({ clientId: membershipClients.clientId })
    .from(membershipClients)
    .where(eq(membershipClients.membershipId, membershipId));
  return rows.map((r) => r.clientId);
}

async function freshMember(tx: Tx, organizationId: string, userId: string): Promise<Member> {
  const [m] = await tx
    .select({ role: memberships.role, id: memberships.id, allClients: memberships.allClients })
    .from(memberships)
    .where(and(eq(memberships.organizationId, organizationId), eq(memberships.userId, userId)));
  if (!m) throw new AppError("not_found", "Workspace not found");
  const allClients = m.allClients && m.role !== "client";
  const clientIds = allClients ? [] : await assignedClientIds(tx, m.id);
  return { role: m.role, membershipId: m.id, allClients, clientIds };
}

export function requireAction(role: Role, action: Action): void {
  if (!can(role, action)) throw new AppError("forbidden", "You don't have permission to do that");
}

/**
 * Runs `fn` as `actor` inside `access.workspace`: verifies membership in the
 * same transaction, then narrows RLS to the member's client scope.
 */
export async function inWorkspace<T>(
  db: Db,
  actor: Actor,
  access: WorkspaceAccess,
  fn: (tx: Tx, member: Member) => Promise<T>
): Promise<T> {
  return withContext(db, { userId: actor.userId, organizationId: access.workspace.id }, async (tx) => {
    const member = await freshMember(tx, access.workspace.id, actor.userId);
    await setClientScope(tx, member.allClients ? "*" : member.clientIds);
    return fn(tx, member);
  });
}

/** Membership check for a request. null => render 404 (never reveal existence). */
export async function resolveWorkspace(db: Db, userId: string, slug: string): Promise<WorkspaceAccess | null> {
  if (!/^[a-z0-9-]{1,60}$/.test(slug)) return null;
  return withContext(db, { userId }, async (tx) => {
    const [row] = await tx
      .select({ org: organizations, role: memberships.role, membershipId: memberships.id, allClients: memberships.allClients })
      .from(organizations)
      .innerJoin(memberships, and(eq(memberships.organizationId, organizations.id), eq(memberships.userId, userId)))
      .where(and(eq(organizations.slug, slug), eq(organizations.status, "active")));
    if (!row) return null;
    const allClients = row.allClients && row.role !== "client";
    return {
      workspace: toRef(row.org),
      role: row.role,
      membershipId: row.membershipId,
      allClients,
      clientIds: allClients ? [] : await assignedClientIds(tx, row.membershipId)
    };
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuidLike = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

/** Ids arrive from URLs and forms: anything malformed is simply "not found". */
export function assertId(id: unknown, what = "Item"): asserts id is string {
  if (!isUuidLike(id)) throw new AppError("not_found", `${what} not found`);
}

export function assertIds(ids: unknown[], what = "Item"): asserts ids is string[] {
  for (const id of ids) assertId(id, what);
}
