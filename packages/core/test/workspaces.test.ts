import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import { sql, withContext } from "@sge/db";
import {
  acceptInvitation,
  changeMemberRole,
  createAgencyWorkspace,
  ensurePersonalWorkspace,
  inviteMember,
  leaveWorkspace,
  listMembers,
  listMyWorkspaces,
  listPendingInvitations,
  listWorkspaceAudit,
  previewInvitation,
  removeMember,
  resolveWorkspace,
  revokeInvitation,
  transferOwnership,
  updateWorkspace,
  type WorkspaceAccess
} from "../src/index";
import { AppError } from "../src/errors";
import { closeAll, db, makeUser, owner, ownerInTenant } from "./helpers";

afterAll(closeAll);

async function expectAppError(p: Promise<unknown>, code: AppError["code"]) {
  const err = await p.then(
    () => null,
    (e: unknown) => e
  );
  expect(err, `expected AppError(${code})`).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
}

async function access(userId: string, slug: string): Promise<WorkspaceAccess> {
  const a = await resolveWorkspace(db, userId, slug);
  if (!a) throw new Error("no access");
  return a;
}

/** An agency with an owner, plus helpers to add members via real invitations. */
async function agency() {
  const o = await makeUser();
  const ws = await createAgencyWorkspace(db, o, "Acme Agency");
  // Tests exercise team flows, not plan limits (those are in plans.test.ts).
  await ownerInTenant(ws.id, "UPDATE subscriptions SET plan_id = 'agency' WHERE organization_id = $1", [ws.id]);
  const ownerAccess = await access(o.userId, ws.slug);
  async function addMember(role: "admin" | "manager" | "specialist" | "viewer") {
    const u = await makeUser();
    const { token } = await inviteMember(db, o, ownerAccess, { email: u.email, role });
    await acceptInvitation(db, u, token);
    return { ...u, access: await access(u.userId, ws.slug) };
  }
  return { owner: o, ws, ownerAccess, addMember };
}

describe("personal workspaces", () => {
  it("is created once per user, even under concurrent first logins", async () => {
    const u = await makeUser({ name: "Priya Sharma" });
    const results = await Promise.all([1, 2, 3, 4].map(() => ensurePersonalWorkspace(db, u, "Priya Sharma")));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results[0]!.name).toBe("Priya's workspace");
    const mine = await listMyWorkspaces(db, u.userId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ type: "personal", role: "owner" });
  });

  it("cannot invite people", async () => {
    const u = await makeUser();
    const ws = await ensurePersonalWorkspace(db, u, "Solo");
    await expectAppError(
      inviteMember(db, u, await access(u.userId, ws.slug), { email: "x@example.test", role: "viewer" }),
      "forbidden"
    );
  });
});

describe("agency workspaces", () => {
  it("require a verified email", async () => {
    const u = await makeUser({ verified: false });
    await expectAppError(createAgencyWorkspace(db, u, "Nope Ltd"), "email_not_verified");
  });

  it("validate the name", async () => {
    const u = await makeUser();
    await expectAppError(createAgencyWorkspace(db, u, " "), "invalid_input");
  });

  it("are listed only for their members, and resolve only for members", async () => {
    const a = await agency();
    const outsider = await makeUser();
    expect(await listMyWorkspaces(db, outsider.userId)).toEqual([]);
    expect(await resolveWorkspace(db, outsider.userId, a.ws.slug)).toBeNull();
    expect(await resolveWorkspace(db, a.owner.userId, "../etc/passwd")).toBeNull();
    expect((await listMyWorkspaces(db, a.owner.userId)).map((w) => w.id)).toEqual([a.ws.id]);
  });
});

describe("invitations", () => {
  it("full flow: invite → preview → accept → member", async () => {
    const a = await agency();
    const invitee = await makeUser({ email: "Invitee.Person@Example.test" });
    const { token } = await inviteMember(db, a.owner, a.ownerAccess, { email: "invitee.person@example.test", role: "manager" });

    expect(await previewInvitation(db, token)).toMatchObject({ workspaceName: "Acme Agency", role: "manager", state: "valid" });
    expect(await listPendingInvitations(db, a.owner, a.ownerAccess)).toHaveLength(1);

    const slug = await acceptInvitation(db, invitee, token);
    expect(slug).toBe(a.ws.slug);
    expect((await access(invitee.userId, slug)).role).toBe("manager");
    expect(await previewInvitation(db, token)).toMatchObject({ state: "accepted" });
    expect(await listPendingInvitations(db, a.owner, a.ownerAccess)).toHaveLength(0);

    // A used token can't be replayed.
    await expectAppError(acceptInvitation(db, invitee, token), "invitation_invalid");
  });

  it("must be accepted by the invited, verified email", async () => {
    const a = await agency();
    const { token } = await inviteMember(db, a.owner, a.ownerAccess, { email: "right@example.test", role: "viewer" });
    await expectAppError(acceptInvitation(db, await makeUser(), token), "email_mismatch");
    const unverified = await makeUser({ email: "right@example.test", verified: false });
    await expectAppError(acceptInvitation(db, unverified, token), "email_not_verified");
  });

  it("rejects malformed, unknown, revoked and expired tokens", async () => {
    const a = await agency();
    const u = await makeUser();
    expect(await previewInvitation(db, "not-a-token")).toBeNull();
    await expectAppError(acceptInvitation(db, u, "x".repeat(43)), "invitation_invalid");

    const r = await inviteMember(db, a.owner, a.ownerAccess, { email: u.email, role: "viewer" });
    await revokeInvitation(db, a.owner, a.ownerAccess, r.invitationId);
    await expectAppError(acceptInvitation(db, u, r.token), "invitation_invalid");

    const e = await inviteMember(db, a.owner, a.ownerAccess, { email: u.email, role: "viewer" });
    await ownerInTenant(a.ws.id, `UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE id = $1`, [e.invitationId]);
    expect(await previewInvitation(db, e.token)).toMatchObject({ state: "expired" });
    await expectAppError(acceptInvitation(db, u, e.token), "invitation_expired");
  });

  it("prevents duplicates and inviting existing members", async () => {
    const a = await agency();
    await inviteMember(db, a.owner, a.ownerAccess, { email: "dup@example.test", role: "viewer" });
    await expectAppError(inviteMember(db, a.owner, a.ownerAccess, { email: "DUP@example.test", role: "viewer" }), "conflict");
    const m = await a.addMember("viewer");
    await expectAppError(inviteMember(db, a.owner, a.ownerAccess, { email: m.email, role: "viewer" }), "conflict");
  });

  it("enforces who may invite and which roles they may grant", async () => {
    const a = await agency();
    const manager = await a.addMember("manager");
    const admin = await a.addMember("admin");
    await expectAppError(inviteMember(db, manager, manager.access, { email: "m@example.test", role: "viewer" }), "forbidden");
    await expectAppError(inviteMember(db, admin, admin.access, { email: "o@example.test", role: "owner" }), "forbidden");
    await expectAppError(inviteMember(db, admin, admin.access, { email: "c@example.test", role: "client" }), "invalid_input");
    await expect(inviteMember(db, admin, admin.access, { email: "ok@example.test", role: "admin" })).resolves.toBeTruthy();
    await expectAppError(listPendingInvitations(db, manager, manager.access), "forbidden");
  });
});

describe("member management", () => {
  it("changes roles within the rules", async () => {
    const a = await agency();
    const admin = await a.addMember("admin");
    const viewer = await a.addMember("viewer");
    await changeMemberRole(db, admin, admin.access, viewer.access.membershipId, "specialist");
    expect((await access(viewer.userId, a.ws.slug)).role).toBe("specialist");
    await expectAppError(changeMemberRole(db, admin, admin.access, a.ownerAccess.membershipId, "viewer"), "forbidden");
    await expectAppError(changeMemberRole(db, admin, admin.access, admin.access.membershipId, "viewer"), "forbidden");
    await expectAppError(changeMemberRole(db, viewer, viewer.access, admin.access.membershipId, "viewer"), "forbidden");
  });

  it("uses the actor's current role, not the one cached in the request", async () => {
    const a = await agency();
    const admin = await a.addMember("admin");
    const stale = admin.access; // resolved while still admin
    await changeMemberRole(db, a.owner, a.ownerAccess, admin.access.membershipId, "viewer");
    await expectAppError(inviteMember(db, admin, stale, { email: "late@example.test", role: "viewer" }), "forbidden");
  });

  it("removes members and denies their access afterwards", async () => {
    const a = await agency();
    const m = await a.addMember("specialist");
    await removeMember(db, a.owner, a.ownerAccess, m.access.membershipId);
    expect(await resolveWorkspace(db, m.userId, a.ws.slug)).toBeNull();
    await expectAppError(listMembers(db, m, m.access), "not_found");
  });

  it("members can leave; the owner must transfer first", async () => {
    const a = await agency();
    const m = await a.addMember("viewer");
    await expectAppError(leaveWorkspace(db, a.owner, a.ownerAccess), "last_owner");
    await leaveWorkspace(db, m, m.access);
    expect(await resolveWorkspace(db, m.userId, a.ws.slug)).toBeNull();
  });

  it("transfers ownership atomically with exactly one owner", async () => {
    const a = await agency();
    const admin = await a.addMember("admin");
    await expectAppError(transferOwnership(db, admin, admin.access, a.ownerAccess.membershipId), "forbidden");
    await transferOwnership(db, a.owner, a.ownerAccess, admin.access.membershipId);
    const roles = (await listMembers(db, admin, await access(admin.userId, a.ws.slug))).map((m) => m.role).sort();
    expect(roles).toEqual(["admin", "owner"]);
    expect((await access(a.owner.userId, a.ws.slug)).role).toBe("admin");
  });

  it("lists member profiles for the current workspace only", async () => {
    const a = await agency();
    const b = await agency();
    await a.addMember("viewer");
    const members = await listMembers(db, a.owner, a.ownerAccess);
    expect(members).toHaveLength(2);
    expect(members.some((m) => m.userId === b.owner.userId)).toBe(false);
  });
});

describe("cross-tenant forgery", () => {
  it("a forged access object for another workspace is rejected by the database", async () => {
    const a = await agency();
    const b = await agency();
    // Attacker (owner of A) claims to be owner of B.
    const forged: WorkspaceAccess = { ...b.ownerAccess, membershipId: a.ownerAccess.membershipId };
    await expectAppError(listMembers(db, a.owner, forged), "not_found");
    await expectAppError(inviteMember(db, a.owner, forged, { email: "evil@example.test", role: "admin" }), "not_found");
    await expectAppError(updateWorkspace(db, a.owner, forged, { name: "Pwned" }), "not_found");
    expect((await access(b.owner.userId, b.ws.slug)).workspace.name).toBe("Acme Agency");
  });
});

describe("workspace settings and audit", () => {
  it("validates branding and records before/after in the audit log", async () => {
    const a = await agency();
    await expectAppError(updateWorkspace(db, a.owner, a.ownerAccess, { branding: { primary: "red" } }), "invalid_input");
    await expectAppError(
      updateWorkspace(db, a.owner, a.ownerAccess, { branding: { logoUrl: "http://insecure.example/logo.png" } }),
      "invalid_input"
    );
    await expectAppError(
      updateWorkspace(db, a.owner, a.ownerAccess, { branding: { primary: "#112233", script: "x" } }),
      "invalid_input"
    );
    const ws = await updateWorkspace(db, a.owner, a.ownerAccess, { name: "Acme Digital", branding: { primary: "#112233" } });
    expect(ws).toMatchObject({ name: "Acme Digital", branding: { primary: "#112233" } });

    const log = await listWorkspaceAudit(db, a.owner, a.ownerAccess);
    expect(log.map((l) => l.action)).toEqual(expect.arrayContaining(["workspace.created", "workspace.updated"]));
  });

  it("restricts who can change what", async () => {
    const a = await agency();
    const manager = await a.addMember("manager");
    const viewer = await a.addMember("viewer");
    await expectAppError(updateWorkspace(db, manager, manager.access, { name: "Manager rename" }), "forbidden");
    await expect(updateWorkspace(db, manager, manager.access, { branding: { primary: "#000000" } })).resolves.toBeTruthy();
    await expectAppError(updateWorkspace(db, viewer, viewer.access, { branding: { primary: "#000000" } }), "forbidden");
    await expectAppError(listWorkspaceAudit(db, manager, manager.access), "forbidden");
  });

  it("audit logs are append-only for the application role", async () => {
    const a = await agency();
    await expect(
      withContext(db, { organizationId: a.ws.id, userId: a.owner.userId }, (tx) => tx.execute(sql`update audit_logs set action = 'x'`))
    ).rejects.toThrow();
    await expect(
      withContext(db, { organizationId: a.ws.id, userId: a.owner.userId }, (tx) => tx.execute(sql`delete from audit_logs`))
    ).rejects.toThrow();
  });
});

describe("identity isolation", () => {
  it("the tenant role cannot read identity tables", async () => {
    await expect(db.execute(sql`select * from auth.users`)).rejects.toThrow();
    await expect(db.execute(sql`select * from auth.sessions`)).rejects.toThrow();
  });

  it("the identity role cannot read tenant tables", async () => {
    const url = process.env.TEST_DATABASE_URL!.replace("app_user:app_user", "auth_user:auth_user");
    const authPool = new pg.Pool({ connectionString: url, max: 1 });
    try {
      await expect(authPool.query("select * from public.organizations")).rejects.toThrow();
      await expect(authPool.query("select * from public.memberships")).rejects.toThrow();
      await expect(authPool.query("select count(*) from auth.users")).resolves.toBeTruthy();
    } finally {
      await authPool.end();
    }
  });

  it("current_user_identity() only ever returns the current user", async () => {
    const u = await makeUser();
    await makeUser();
    const none = await withContext(db, {}, (tx) => tx.execute(sql`select * from current_user_identity()`));
    expect(none.rows).toEqual([]);
    const mine = await withContext(db, { userId: u.userId }, (tx) => tx.execute(sql`select email from current_user_identity()`));
    expect(mine.rows).toEqual([{ email: u.email }]);
  });

  it("platform settings are readable but not writable by the app", async () => {
    await expect(db.execute(sql`update platform_settings set value = '{}'`)).rejects.toThrow();
    const r = await owner.query(`select value->>'name' as name from platform_settings where key = 'product'`);
    expect(r.rows[0]?.name).toBe("Futuready Media");
  });
});
