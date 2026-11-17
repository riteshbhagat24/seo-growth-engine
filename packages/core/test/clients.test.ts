import { afterAll, describe, expect, it } from "vitest";
import { schema, setClientScope, withContext } from "@sge/db";
import {
  addWebsite,
  AppError,
  createClient,
  ensurePersonalWorkspace,
  getClient,
  getWebsite,
  inviteMember,
  listClients,
  listWebsites,
  setClientArchived,
  setMemberClientAccess,
  updateClient
} from "../src/index";
import { accessFor, closeAll, db, makeAgency, makeUser } from "./helpers";

afterAll(closeAll);

async function codeOf(p: Promise<unknown>) {
  return p.then(() => "ok", (e) => (e instanceof AppError ? e.code : `unexpected: ${(e as Error).message}`));
}

/** Agency with two clients, a site each, plus one agency-level site. */
async function agencyWithClients() {
  const a = await makeAgency();
  const acme = await createClient(db, a.owner, a.ownerAccess, { name: "Acme Co", website: "https://acme.example.com" });
  const globex = await createClient(db, a.owner, a.ownerAccess, { name: "Globex" });
  const acmeSite = await addWebsite(db, a.owner, a.ownerAccess, { url: "acme-site.com", clientId: acme.id });
  const globexSite = await addWebsite(db, a.owner, a.ownerAccess, { url: "globex-site.com", clientId: globex.id });
  const ownSite = await addWebsite(db, a.owner, a.ownerAccess, { url: "agency-own.com" });
  return { ...a, acme, globex, acmeSite, globexSite, ownSite };
}

describe("clients", () => {
  it("are an agency feature", async () => {
    const u = await makeUser();
    const ws = await ensurePersonalWorkspace(db, u, "Solo");
    expect(await codeOf(createClient(db, u, await accessFor(u.userId, ws.slug), { name: "Nope" }))).toBe("forbidden");
  });

  it("validate their details", async () => {
    const a = await makeAgency();
    expect(await codeOf(createClient(db, a.owner, a.ownerAccess, { name: "x" }))).toBe("invalid_input");
    expect(await codeOf(createClient(db, a.owner, a.ownerAccess, { name: "Valid", contactEmail: "not-an-email" }))).toBe("invalid_input");
    expect(await codeOf(createClient(db, a.owner, a.ownerAccess, { name: "Valid", website: "javascript:alert(1)" }))).toBe("invalid_input");
  });

  it("can be created, edited, archived and restored, with website counts", async () => {
    const a = await agencyWithClients();
    await updateClient(db, a.owner, a.ownerAccess, a.acme.id, { name: "Acme Corporation", contactEmail: "ops@acme.example.com" });
    const list = await listClients(db, a.owner, a.ownerAccess);
    expect(list.map((c) => [c.name, c.websiteCount])).toEqual([
      ["Acme Corporation", 1],
      ["Globex", 1]
    ]);
    await setClientArchived(db, a.owner, a.ownerAccess, a.globex.id, true);
    expect((await listClients(db, a.owner, a.ownerAccess)).map((c) => c.name)).toEqual(["Acme Corporation"]);
    expect(await listClients(db, a.owner, a.ownerAccess, { includeArchived: true })).toHaveLength(2);
    await setClientArchived(db, a.owner, a.ownerAccess, a.globex.id, false);
    expect(await listClients(db, a.owner, a.ownerAccess)).toHaveLength(2);
  });

  it("can only be managed by owners, admins and managers", async () => {
    const a = await agencyWithClients();
    const specialist = await a.addMember("specialist");
    expect(await codeOf(createClient(db, specialist, specialist.access, { name: "Sneaky" }))).toBe("forbidden");
    expect(await codeOf(setClientArchived(db, specialist, specialist.access, a.acme.id, true))).toBe("forbidden");
  });
});

describe("client-scoped access", () => {
  it("a client user sees only their client's data, in services and in raw SQL", async () => {
    const a = await agencyWithClients();
    const clientUser = await a.addMember("client", [a.acme.id]);
    expect(clientUser.access).toMatchObject({ role: "client", allClients: false, clientIds: [a.acme.id] });

    expect((await listClients(db, clientUser, clientUser.access)).map((c) => c.id)).toEqual([a.acme.id]);
    expect((await listWebsites(db, clientUser, clientUser.access)).map((r) => r.website.domain)).toEqual(["acme-site.com"]);
    expect(await codeOf(getWebsite(db, clientUser, clientUser.access, a.globexSite.id))).toBe("not_found");
    expect(await codeOf(getWebsite(db, clientUser, clientUser.access, a.ownSite.id))).toBe("not_found");
    expect(await codeOf(getClient(db, clientUser, clientUser.access, a.globex.id))).toBe("not_found");

    // Even a raw query in that member's scope can't see other clients' rows.
    const raw = await withContext(db, { organizationId: a.ws.id, userId: clientUser.userId, clientScope: [a.acme.id] }, async (tx) => ({
      sites: (await tx.select().from(schema.websites)).map((w) => w.domain),
      clients: (await tx.select().from(schema.clients)).map((c) => c.name)
    }));
    expect(raw).toEqual({ sites: ["acme-site.com"], clients: ["Acme Co"] });
  });

  it("an empty scope sees nothing, and scoped writes can't escape the scope", async () => {
    const a = await agencyWithClients();
    const nothing = await withContext(db, { organizationId: a.ws.id, clientScope: [] }, (tx) => tx.select().from(schema.websites));
    expect(nothing).toEqual([]);
    const escaped = await withContext(db, { organizationId: a.ws.id }, async (tx) => {
      await setClientScope(tx, [a.acme.id]);
      return tx
        .insert(schema.websites)
        .values({ organizationId: a.ws.id, url: "https://sneak.com", domain: "sneak.com", clientId: a.globex.id })
        .then(() => "inserted", () => "blocked");
    });
    expect(escaped).toBe("blocked");
  });

  it("client users can't change anything", async () => {
    const a = await agencyWithClients();
    const c = await a.addMember("client", [a.acme.id]);
    expect(await codeOf(addWebsite(db, c, c.access, { url: "new-site.com", clientId: a.acme.id }))).toBe("forbidden");
    expect(await codeOf(updateClient(db, c, c.access, a.acme.id, { name: "Hacked" }))).toBe("forbidden");
  });

  it("a restricted specialist sees assigned clients only; widening access takes effect immediately", async () => {
    const a = await agencyWithClients();
    const s = await a.addMember("specialist", [a.globex.id]);
    expect((await listWebsites(db, s, s.access)).map((r) => r.website.domain)).toEqual(["globex-site.com"]);

    await setMemberClientAccess(db, a.owner, a.ownerAccess, s.access.membershipId, { allClients: true, clientIds: [] });
    // The old access object is stale; the scope is re-read inside every transaction.
    expect((await listWebsites(db, s, s.access)).map((r) => r.website.domain).sort()).toEqual([
      "acme-site.com",
      "agency-own.com",
      "globex-site.com"
    ]);

    await setMemberClientAccess(db, a.owner, a.ownerAccess, s.access.membershipId, { allClients: false, clientIds: [a.acme.id] });
    expect((await listWebsites(db, s, s.access)).map((r) => r.website.domain)).toEqual(["acme-site.com"]);
  });

  it("client invitations require at least one valid client", async () => {
    const a = await agencyWithClients();
    expect(await codeOf(inviteMember(db, a.owner, a.ownerAccess, { email: "c1@example.test", role: "client" }))).toBe("invalid_input");
    const other = await agencyWithClients();
    expect(
      await codeOf(inviteMember(db, a.owner, a.ownerAccess, { email: "c2@example.test", role: "client", clientIds: [other.acme.id] }))
    ).toBe("invalid_input"); // another workspace's client is invisible here
    const c = await a.addMember("client", [a.acme.id]);
    expect(await codeOf(setMemberClientAccess(db, a.owner, a.ownerAccess, c.access.membershipId, { allClients: true, clientIds: [] }))).toBe(
      "invalid_input"
    ); // client role can never be widened to "all clients"
  });

  it("restricted members can't manage clients or invite people", async () => {
    const a = await agencyWithClients();
    const m = await a.addMember("manager", [a.acme.id]);
    expect(await codeOf(createClient(db, m, m.access, { name: "New" }))).toBe("forbidden");
    expect(await codeOf(inviteMember(db, m, m.access, { email: "x@example.test", role: "viewer" }))).toBe("forbidden");
  });
});
