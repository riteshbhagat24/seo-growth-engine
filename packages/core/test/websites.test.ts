import { afterAll, describe, expect, it } from "vitest";
import {
  addWebsite,
  AppError,
  checkOwnership,
  deleteWebsite,
  ensurePersonalWorkspace,
  getWebsite,
  listWorkspaceAudit,
  normalizeWebsiteUrl,
  updateWebsite,
  verificationInstructions,
  verifyWebsite,
  type VerificationDeps
} from "../src/index";
import { SafeFetchError } from "@sge/crawler";
import { accessFor, closeAll, db, makeAgency, makeUser, ownerInTenant } from "./helpers";

afterAll(closeAll);

async function codeOf(p: Promise<unknown>) {
  return p.then(() => "ok", (e) => (e instanceof AppError ? e.code : `unexpected: ${(e as Error).message}`));
}

describe("normalizeWebsiteUrl", () => {
  it.each([
    ["example.org", "https://example.org", "example.org"],
    ["https://www.Example.ORG/path?q=1#x", "https://www.example.org", "example.org"],
    ["http://shop.example.co.in:80/", "http://shop.example.co.in", "shop.example.co.in"],
    ["https://www.example.org.", "https://www.example.org", "example.org"],
    ["https://xn--bcher-kva.de/", "https://xn--bcher-kva.de", "xn--bcher-kva.de"]
  ])("%s → %s (%s)", (input, url, domain) => {
    expect(normalizeWebsiteUrl(input)).toEqual({ url, domain });
  });

  it.each([
    "",
    "localhost",
    "http://localhost:3000",
    "intranet",
    "192.168.1.10",
    "http://[::1]/",
    "ftp://example.org",
    "https://user:pw@example.org",
    "https://example.org:8443",
    "https://-bad-.example.org",
    "https://router.lan",
    "https://my.site.internal"
  ])("rejects %s", (input) => {
    expect(() => normalizeWebsiteUrl(input)).toThrow(AppError);
  });
});

/** A personal workspace on an override plan with room for several sites. */
async function personalWithSite(url = "verify-me.com") {
  const u = await makeUser();
  const ws = await ensurePersonalWorkspace(db, u, "Vera");
  await ownerInTenant(ws.id, `UPDATE subscriptions SET overrides = '{"websites": 10}' WHERE organization_id = $1`, [ws.id]);
  const access = await accessFor(u.userId, ws.slug);
  const site = await addWebsite(db, u, access, { url });
  return { u, ws, access, site };
}

/** Fake network: DNS TXT records and HTTP responses keyed by URL. */
function fakeDeps(opts: { txt?: Record<string, string[][]>; http?: Record<string, { status?: number; body?: string; finalUrl?: string }> }): VerificationDeps {
  return {
    resolveTxt: async (host) => {
      const r = opts.txt?.[host];
      if (!r) throw Object.assign(new Error("ENODATA"), { code: "ENODATA" });
      return r;
    },
    fetch: async (url) => {
      const r = opts.http?.[url];
      if (!r) throw new SafeFetchError("network", "Couldn't connect to the site");
      return { url: r.finalUrl ?? url, status: r.status ?? 200, contentType: "text/html", body: r.body ?? "", redirects: [] };
    }
  };
}

describe("websites", () => {
  it("adds, renames and deletes, with duplicates rejected", async () => {
    const { u, access, site } = await personalWithSite("dup-check.com");
    expect(site).toMatchObject({ url: "https://dup-check.com", domain: "dup-check.com", verificationStatus: "unverified" });
    expect(site.verificationToken).toMatch(/^[0-9a-f]{32}$/);
    expect(await codeOf(addWebsite(db, u, access, { url: "https://www.dup-check.com/" }))).toBe("conflict");
    await updateWebsite(db, u, access, site.id, { displayName: "Main site" });
    expect((await getWebsite(db, u, access, site.id)).website.displayName).toBe("Main site");
    await deleteWebsite(db, u, access, site.id);
    expect(await codeOf(getWebsite(db, u, access, site.id))).toBe("not_found");
  });

  it("the same domain may exist in two different workspaces", async () => {
    await personalWithSite("shared-domain.com");
    await expect(personalWithSite("shared-domain.com")).resolves.toBeTruthy();
  });

  it("only managers and above can add or verify websites", async () => {
    const a = await makeAgency();
    const site = await addWebsite(db, a.owner, a.ownerAccess, { url: "agency-site.com" });
    const viewer = await a.addMember("viewer");
    expect(await codeOf(addWebsite(db, viewer, viewer.access, { url: "viewer-site.com" }))).toBe("forbidden");
    expect(await codeOf(verifyWebsite(db, viewer, viewer.access, site.id, "dns_txt", fakeDeps({})))).toBe("forbidden");
  });
});

describe("ownership verification", () => {
  it("DNS TXT: passes with the record (split TXT chunks are joined), fails without", async () => {
    const { site } = await personalWithSite();
    const value = verificationInstructions(site).dnsTxt.value;
    const half = Math.floor(value.length / 2);
    expect(await checkOwnership("dns_txt", site, fakeDeps({ txt: { [site.domain]: [["v=spf1 -all"], [value.slice(0, half), value.slice(half)]] } }))).toBeNull();
    expect(await checkOwnership("dns_txt", site, fakeDeps({ txt: { [site.domain]: [["sge-site-verification=wrong"]] } }))).toMatch(/wasn't found/);
    expect(await checkOwnership("dns_txt", site, fakeDeps({}))).toMatch(/No TXT records/);
  });

  it("meta tag: must be on the homepage of the same site", async () => {
    const { site } = await personalWithSite();
    const tag = verificationInstructions(site).metaTag;
    const page = (head: string) => `<!doctype html><html><head>${head}</head><body></body></html>`;
    expect(await checkOwnership("meta_tag", site, fakeDeps({ http: { [site.url]: { body: page(tag) } } }))).toBeNull();
    expect(
      await checkOwnership("meta_tag", site, fakeDeps({ http: { [site.url]: { body: page(`<meta name="SGE-Site-Verification" content="${site.verificationToken}">`) } } }))
    ).toBeNull(); // attribute name is case-insensitive
    expect(await checkOwnership("meta_tag", site, fakeDeps({ http: { [site.url]: { body: page("") } } }))).toMatch(/wasn't found/);
    expect(
      await checkOwnership("meta_tag", site, fakeDeps({ http: { [site.url]: { body: page(tag), finalUrl: "https://attacker.example.net/" } } }))
    ).toMatch(/redirected to another site/);
    expect(await checkOwnership("meta_tag", site, fakeDeps({ http: { [site.url]: { status: 500, body: page(tag) } } }))).toMatch(/HTTP 500/);
    // Token in a comment or visible text doesn't count.
    expect(
      await checkOwnership("meta_tag", site, fakeDeps({ http: { [site.url]: { body: page(`<!-- ${tag} -->`) } } }))
    ).toMatch(/wasn't found/);
  });

  it("HTML file: correct path and content", async () => {
    const { site } = await personalWithSite();
    const f = verificationInstructions(site).htmlFile;
    expect(await checkOwnership("html_file", site, fakeDeps({ http: { [f.url]: { body: f.content } } }))).toBeNull();
    expect(await checkOwnership("html_file", site, fakeDeps({ http: { [f.url]: { body: "something else" } } }))).toMatch(/doesn't match/);
    expect(await checkOwnership("html_file", site, fakeDeps({ http: { [f.url]: { status: 404 } } }))).toMatch(/HTTP 404/);
    expect(await checkOwnership("html_file", site, fakeDeps({}))).toMatch(/Couldn't connect/);
  });

  it("verifyWebsite records success, failure and audit entries, and throttles retries", async () => {
    const { u, access, site } = await personalWithSite();
    const failing = await verifyWebsite(db, u, access, site.id, "dns_txt", fakeDeps({}));
    expect(failing.verified).toBe(false);
    expect((await getWebsite(db, u, access, site.id)).website).toMatchObject({ verificationStatus: "unverified", lastVerificationError: expect.stringMatching(/TXT/) });

    expect(await codeOf(verifyWebsite(db, u, access, site.id, "dns_txt", fakeDeps({})))).toBe("rate_limited");

    await ownerInTenant(access.workspace.id, `UPDATE websites SET last_verification_at = now() - interval '1 minute' WHERE id = $1`, [site.id]);
    const value = verificationInstructions(site).dnsTxt.value;
    const ok = await verifyWebsite(db, u, access, site.id, "dns_txt", fakeDeps({ txt: { [site.domain]: [[value]] } }));
    expect(ok).toEqual({ verified: true, reason: null });
    expect((await getWebsite(db, u, access, site.id)).website).toMatchObject({
      verificationStatus: "verified",
      verificationMethod: "dns_txt",
      lastVerificationError: null
    });
  });

  it("verification attempts are audited in agency workspaces", async () => {
    const a = await makeAgency();
    const site = await addWebsite(db, a.owner, a.ownerAccess, { url: "audited-site.com" });
    await verifyWebsite(db, a.owner, a.ownerAccess, site.id, "meta_tag", fakeDeps({}));
    const actions = (await listWorkspaceAudit(db, a.owner, a.ownerAccess)).map((l) => l.action);
    expect(actions).toEqual(expect.arrayContaining(["website.added", "website.verification_failed"]));
  });
});
