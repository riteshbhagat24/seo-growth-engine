import pg from "pg";
import { randomUUID } from "node:crypto";
import { createDb, getPool } from "@sge/db";

export const db = createDb(process.env.TEST_DATABASE_URL!);
export const owner = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL_OWNER, max: 2 });

export async function closeAll() {
  await owner.end();
  await getPool(process.env.TEST_DATABASE_URL!).end();
}

let n = 0;
/** Creates an identity row directly (Better Auth does this in the app). */
export async function makeUser(opts: { verified?: boolean; name?: string; email?: string } = {}) {
  n++;
  const id = randomUUID();
  const email = opts.email ?? `user${n}-${id.slice(0, 6)}@example.test`;
  await owner.query(`INSERT INTO auth.users (id, name, email, email_verified) VALUES ($1, $2, $3, $4)`, [
    id,
    opts.name ?? `User ${n}`,
    email,
    opts.verified ?? true
  ]);
  return { userId: id, email };
}

/** Run SQL as the owner inside a tenant (FORCE RLS applies to the owner too). */
export async function ownerInTenant(orgId: string, text: string, params: unknown[] = []) {
  const c = await owner.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.org_id', $1, true), set_config('app.client_scope', '*', true)", [orgId]);
    const r = await c.query(text, params);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

// ── Shared fixtures (imported lazily to avoid a cycle with src) ─────────────
import {
  acceptInvitation,
  createAgencyWorkspace,
  inviteMember,
  resolveWorkspace,
  type WorkspaceAccess
} from "../src/index";
import type { Role } from "../src/permissions";

export async function accessFor(userId: string, slug: string): Promise<WorkspaceAccess> {
  const a = await resolveWorkspace(db, userId, slug);
  if (!a) throw new Error("no access");
  return a;
}

/** An agency workspace with an owner; `plan` defaults to the roomy "agency" plan. */
export async function makeAgency(opts: { plan?: string; name?: string } = {}) {
  const owner = await makeUser();
  const ws = await createAgencyWorkspace(db, owner, opts.name ?? "Fixture Agency");
  await ownerInTenant(ws.id, "UPDATE subscriptions SET plan_id = $2 WHERE organization_id = $1", [ws.id, opts.plan ?? "agency"]);
  const ownerAccess = await accessFor(owner.userId, ws.slug);
  async function addMember(role: Exclude<Role, "owner">, clientIds: string[] = []) {
    const u = await makeUser();
    const { token } = await inviteMember(db, owner, ownerAccess, { email: u.email, role, clientIds });
    await acceptInvitation(db, u, token);
    return { ...u, access: await accessFor(u.userId, ws.slug) };
  }
  return { owner, ws, ownerAccess, addMember };
}
