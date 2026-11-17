import { afterAll, describe, expect, it } from "vitest";
import { withContext } from "@sge/db";
import {
  AppError,
  consumeUsage,
  createClient,
  ensurePersonalWorkspace,
  inviteMember,
  usageSummary,
  addWebsite
} from "../src/index";
import { accessFor, closeAll, db, makeAgency, makeUser, ownerInTenant } from "./helpers";

afterAll(closeAll);

async function codeOf(p: Promise<unknown>) {
  return p.then(() => "ok", (e) => (e instanceof AppError ? e.code : `unexpected: ${(e as Error).message}`));
}

describe("plans and limits", () => {
  it("new workspaces get the default plan for their type", async () => {
    const u = await makeUser();
    const personal = await ensurePersonalWorkspace(db, u, "Pat");
    const s = await usageSummary(db, u, await accessFor(u.userId, personal.slug));
    expect(s.planId).toBe("free");
    expect(s.lines.find((l) => l.key === "websites")).toMatchObject({ used: 0, limit: 1 });

    const a = await makeAgency({ plan: "agency_free" });
    expect((await usageSummary(db, a.owner, a.ownerAccess)).planId).toBe("agency_free");
  });

  it("enforces the website limit (free plan: 1)", async () => {
    const u = await makeUser();
    const ws = await ensurePersonalWorkspace(db, u, "Pat");
    const access = await accessFor(u.userId, ws.slug);
    expect(await codeOf(addWebsite(db, u, access, { url: "first-site.com" }))).toBe("ok");
    expect(await codeOf(addWebsite(db, u, access, { url: "second-site.com" }))).toBe("limit_reached");
  });

  it("enforces client and member limits, counting pending invitations", async () => {
    const a = await makeAgency({ plan: "agency_free" }); // 3 clients, 3 members
    for (const n of [1, 2, 3]) await createClient(db, a.owner, a.ownerAccess, { name: `Client ${n}` });
    expect(await codeOf(createClient(db, a.owner, a.ownerAccess, { name: "Client 4" }))).toBe("limit_reached");

    await inviteMember(db, a.owner, a.ownerAccess, { email: "p1@example.test", role: "viewer" });
    await inviteMember(db, a.owner, a.ownerAccess, { email: "p2@example.test", role: "viewer" });
    expect(await codeOf(inviteMember(db, a.owner, a.ownerAccess, { email: "p3@example.test", role: "viewer" }))).toBe("limit_reached");
  });

  it("concurrent requests can't exceed a limit", async () => {
    const u = await makeUser();
    const ws = await ensurePersonalWorkspace(db, u, "Racer");
    const access = await accessFor(u.userId, ws.slug);
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => codeOf(addWebsite(db, u, access, { url: `race-${i}.com` })))
    );
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.filter((r) => r === "limit_reached")).toHaveLength(5);
  });

  it("per-workspace overrides change the effective limit", async () => {
    const u = await makeUser();
    const ws = await ensurePersonalWorkspace(db, u, "Comped");
    await ownerInTenant(ws.id, `UPDATE subscriptions SET overrides = '{"websites": 3}' WHERE organization_id = $1`, [ws.id]);
    const access = await accessFor(u.userId, ws.slug);
    for (const d of ["a-one.com", "a-two.com", "a-three.com"]) await addWebsite(db, u, access, { url: d });
    expect(await codeOf(addWebsite(db, u, access, { url: "a-four.com" }))).toBe("limit_reached");
  });

  it("metered usage is atomic and capped per month", async () => {
    const a = await makeAgency({ plan: "agency_free" }); // 2,000 pages / month
    const consume = (n: number) =>
      withContext(db, { organizationId: a.ws.id, userId: a.owner.userId }, (tx) => consumeUsage(tx, a.ws.id, "pages_crawled_month", n));
    const results = await Promise.all(Array.from({ length: 10 }, () => consume(300)));
    expect(results.filter(Boolean)).toHaveLength(6); // 6 × 300 = 1,800 ≤ 2,000; the 7th would exceed
    expect(await consume(200)).toBe(true); // exactly 2,000
    expect(await consume(1)).toBe(false);
    const line = (await usageSummary(db, a.owner, a.ownerAccess)).lines.find((l) => l.key === "pages_crawled_month");
    expect(line).toMatchObject({ used: 2000, limit: 2000, metered: true });
  });

  it("plan and subscription rows can't be changed by the app role", async () => {
    const a = await makeAgency();
    const err = await withContext(db, { organizationId: a.ws.id }, (tx) =>
      tx.execute(`update subscriptions set plan_id = 'agency' where organization_id = '${a.ws.id}'` as never)
    ).then(() => null, (e) => e);
    expect(err).not.toBeNull();
  });

  it("only owners and admins can see usage", async () => {
    const a = await makeAgency();
    const m = await a.addMember("manager");
    expect(await codeOf(usageSummary(db, m, m.access))).toBe("forbidden");
  });
});
