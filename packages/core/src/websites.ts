import { resolveTxt as dnsResolveTxt } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import { and, asc, eq, schema, sql, type Db, type Tx } from "@sge/db";
import type { Website } from "@sge/db/schema";
import { metaContents, safeFetch, SafeFetchError, type SafeFetchResult } from "@sge/crawler";
import { audit } from "./audit";
import { assertId, inWorkspace, requireAction, type Actor, type WorkspaceAccess } from "./context";
import { AppError, isUniqueViolation } from "./errors";
import { assertWithinLimit } from "./plans";

const { websites, clients } = schema;

export const VERIFICATION_NAME = "sge-site-verification";
export type VerificationMethod = NonNullable<Website["verificationMethod"]>;
export const VERIFICATION_RETRY_SECONDS = 10;
export const REVERIFY_JOB = "website.reverify";
export const REVERIFY_INTERVAL_MINUTES = 7 * 24 * 60;

/** Called when a website becomes verified: ownership is re-checked weekly (see maintenance.ts). */
export async function scheduleReverification(tx: Tx, organizationId: string, websiteId: string): Promise<void> {
  const next = new Date(Date.now() + REVERIFY_INTERVAL_MINUTES * 60_000);
  await tx
    .insert(schema.schedules)
    .values({ organizationId, websiteId, jobType: REVERIFY_JOB, payload: { websiteId }, intervalMinutes: REVERIFY_INTERVAL_MINUTES, nextRunAt: next })
    .onConflictDoUpdate({
      target: [schema.schedules.websiteId, schema.schedules.jobType],
      set: { enabled: true, nextRunAt: next, updatedAt: new Date() }
    });
}

/* ─────────────────────────────── Normalisation ──────────────────────────── */

/**
 * "Example.com/path", "https://www.example.com:443/?q" → url "https://www.example.com",
 * domain "example.com". Rejects IPs, localhost, single-label and non-http hosts.
 */
export function normalizeWebsiteUrl(input: string): { url: string; domain: string } {
  const raw = input.trim();
  if (!raw || raw.length > 2048) throw new AppError("invalid_input", "Enter your website address, e.g. example.com");
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new AppError("invalid_input", "That doesn't look like a website address");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new AppError("invalid_input", "Use an http or https address");
  if (u.username || u.password) throw new AppError("invalid_input", "Remove the username/password from the address");
  if (u.port && u.port !== "80" && u.port !== "443") throw new AppError("invalid_input", "Websites on custom ports aren't supported");
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (isIP(host.replace(/^\[|\]$/g, ""))) throw new AppError("invalid_input", "Use a domain name, not an IP address");
  const labels = host.split(".");
  if (
    host.length > 253 ||
    labels.length < 2 ||
    labels.some((l) => !/^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(l)) ||
    !/^(xn--[a-z0-9-]+|[a-z]{2,63})$/.test(labels.at(-1)!) ||
    ["localhost", "local", "internal", "test", "invalid", "example", "lan", "home"].includes(labels.at(-1)!)
  )
    throw new AppError("invalid_input", "That doesn't look like a public website address");
  return { url: `${u.protocol}//${host}`, domain: host.replace(/^www\./, "") };
}

/* ──────────────────────────────── Queries ───────────────────────────────── */

async function visibleWebsite(tx: Tx, organizationId: string, websiteId: string): Promise<Website> {
  assertId(websiteId, "Website");
  const [w] = await tx.select().from(websites).where(and(eq(websites.id, websiteId), eq(websites.organizationId, organizationId)));
  if (!w) throw new AppError("not_found", "Website not found");
  return w;
}

export async function listWebsites(db: Db, actor: Actor, access: WorkspaceAccess) {
  return inWorkspace(db, actor, access, (tx) =>
    tx
      .select({ website: websites, clientName: clients.name })
      .from(websites)
      .leftJoin(clients, eq(clients.id, websites.clientId))
      .where(eq(websites.organizationId, access.workspace.id))
      .orderBy(asc(websites.domain))
  );
}

export async function getWebsite(db: Db, actor: Actor, access: WorkspaceAccess, websiteId: string) {
  return inWorkspace(db, actor, access, async (tx) => {
    const website = await visibleWebsite(tx, access.workspace.id, websiteId);
    const [client] = website.clientId ? await tx.select().from(clients).where(eq(clients.id, website.clientId)) : [];
    return { website, client: client ?? null };
  });
}

/* ──────────────────────────────── Mutations ─────────────────────────────── */

const displayName = z.string().trim().max(120).optional().transform((v) => (v ? v : null));

async function checkClient(tx: Tx, access: WorkspaceAccess, clientId: string | null | undefined): Promise<string | null> {
  if (!clientId) return null;
  assertId(clientId, "Client");
  if (access.workspace.type !== "agency") throw new AppError("invalid_input", "Personal workspaces don't have clients");
  const [c] = await tx.select({ id: clients.id, status: clients.status }).from(clients).where(eq(clients.id, clientId));
  if (!c || c.status !== "active") throw new AppError("invalid_input", "Choose an active client");
  return c.id;
}

export async function addWebsite(
  db: Db,
  actor: Actor,
  access: WorkspaceAccess,
  input: { url: string; displayName?: string; clientId?: string | null }
): Promise<Website> {
  const { url, domain } = normalizeWebsiteUrl(input.url);
  const name = displayName.parse(input.displayName);
  return inWorkspace(db, actor, access, async (tx, member) => {
    requireAction(member.role, "websites.manage");
    const clientId = await checkClient(tx, access, input.clientId);
    if (!member.allClients && !clientId) throw new AppError("invalid_input", "Choose one of your clients for this website");
    await assertWithinLimit(tx, access.workspace.id, "websites");
    try {
      const [w] = await tx
        .insert(websites)
        .values({ organizationId: access.workspace.id, url, domain, displayName: name, clientId })
        .returning();
      await audit(tx, {
        organizationId: access.workspace.id,
        actorUserId: actor.userId,
        action: "website.added",
        entityType: "website",
        entityId: w!.id,
        metadata: { domain, clientId },
        ip: actor.ip,
        userAgent: actor.userAgent
      });
      return w!;
    } catch (e) {
      if (isUniqueViolation(e, "websites_org_domain_uq")) throw new AppError("conflict", `${domain} is already in this workspace`);
      throw e;
    }
  });
}

export async function updateWebsite(
  db: Db,
  actor: Actor,
  access: WorkspaceAccess,
  websiteId: string,
  input: { displayName?: string; clientId?: string | null }
): Promise<Website> {
  return inWorkspace(db, actor, access, async (tx, member) => {
    requireAction(member.role, "websites.manage");
    const before = await visibleWebsite(tx, access.workspace.id, websiteId);
    const patch: Partial<typeof websites.$inferInsert> = {};
    if (input.displayName !== undefined) patch.displayName = displayName.parse(input.displayName);
    if (input.clientId !== undefined) {
      patch.clientId = await checkClient(tx, access, input.clientId);
      if (!member.allClients && !patch.clientId) throw new AppError("invalid_input", "Choose one of your clients for this website");
    }
    const [w] = await tx.update(websites).set(patch).where(eq(websites.id, websiteId)).returning();
    await audit(tx, {
      organizationId: access.workspace.id,
      actorUserId: actor.userId,
      action: "website.updated",
      entityType: "website",
      entityId: websiteId,
      metadata: { domain: before.domain, before: { clientId: before.clientId, displayName: before.displayName }, after: patch },
      ip: actor.ip,
      userAgent: actor.userAgent
    });
    return w!;
  });
}

export async function deleteWebsite(db: Db, actor: Actor, access: WorkspaceAccess, websiteId: string): Promise<void> {
  await inWorkspace(db, actor, access, async (tx, member) => {
    requireAction(member.role, "websites.manage");
    const w = await visibleWebsite(tx, access.workspace.id, websiteId);
    await tx.delete(websites).where(eq(websites.id, websiteId));
    await audit(tx, {
      organizationId: access.workspace.id,
      actorUserId: actor.userId,
      action: "website.deleted",
      entityType: "website",
      entityId: websiteId,
      metadata: { domain: w.domain },
      ip: actor.ip,
      userAgent: actor.userAgent
    });
  });
}

/* ────────────────────────────── Verification ────────────────────────────── */

export interface VerificationInstructions {
  dnsTxt: { host: string; value: string };
  metaTag: string;
  htmlFile: { url: string; content: string };
}

export function verificationInstructions(w: Pick<Website, "url" | "domain" | "verificationToken">): VerificationInstructions {
  const token = w.verificationToken;
  return {
    dnsTxt: { host: w.domain, value: `${VERIFICATION_NAME}=${token}` },
    metaTag: `<meta name="${VERIFICATION_NAME}" content="${token}">`,
    htmlFile: { url: `${w.url}/${VERIFICATION_NAME}-${token}.html`, content: `${VERIFICATION_NAME}: ${token}` }
  };
}

export interface VerificationDeps {
  fetch: (url: string) => Promise<SafeFetchResult>;
  resolveTxt: (host: string) => Promise<string[][]>;
}

export const defaultVerificationDeps: VerificationDeps = {
  fetch: (url) => safeFetch(url, { timeoutMs: 10_000, maxBytes: 1024 * 1024 }),
  resolveTxt: (host) => dnsResolveTxt(host)
};

const sameSite = (finalUrl: string, domain: string) => {
  const h = new URL(finalUrl).hostname.toLowerCase();
  return h === domain || h.endsWith(`.${domain}`);
};

/** Network check only (no database). Returns null on success, else a user-facing reason. */
export async function checkOwnership(
  method: VerificationMethod,
  w: Pick<Website, "url" | "domain" | "verificationToken">,
  deps: VerificationDeps
): Promise<string | null> {
  if (method === "gsc") return "Search Console ownership is checked through the connected Google account.";
  const ins = verificationInstructions(w);
  try {
    if (method === "dns_txt") {
      let records: string[][];
      try {
        records = await deps.resolveTxt(w.domain);
      } catch {
        return `No TXT records found for ${w.domain} yet. DNS changes can take a while to appear.`;
      }
      const values = records.map((chunks) => chunks.join("").trim());
      return values.includes(ins.dnsTxt.value)
        ? null
        : `The TXT record wasn't found on ${w.domain}. DNS changes can take up to a few hours to appear.`;
    }
    if (method === "meta_tag") {
      const res = await deps.fetch(w.url);
      if (!sameSite(res.url, w.domain)) return `Your homepage redirected to another site (${new URL(res.url).hostname}).`;
      if (res.status !== 200) return `Your homepage returned HTTP ${res.status}.`;
      return metaContents(res.body, VERIFICATION_NAME).includes(w.verificationToken)
        ? null
        : "The verification meta tag wasn't found in your homepage's HTML.";
    }
    const res = await deps.fetch(ins.htmlFile.url);
    if (!sameSite(res.url, w.domain)) return `The file URL redirected to another site (${new URL(res.url).hostname}).`;
    if (res.status !== 200) return `The verification file returned HTTP ${res.status}. Is it uploaded to the site's root?`;
    return res.body.includes(ins.htmlFile.content) ? null : "The verification file was found but its content doesn't match.";
  } catch (e) {
    if (e instanceof SafeFetchError) return e.message;
    return "Couldn't reach your website. Please try again.";
  }
}

export async function verifyWebsite(
  db: Db,
  actor: Actor,
  access: WorkspaceAccess,
  websiteId: string,
  method: VerificationMethod,
  deps: VerificationDeps = defaultVerificationDeps
): Promise<{ verified: boolean; reason: string | null }> {
  if (!["dns_txt", "meta_tag", "html_file"].includes(method)) throw new AppError("invalid_input", "Choose a verification method");

  // 1) Authorise, throttle and claim the attempt (short transaction).
  const website = await inWorkspace(db, actor, access, async (tx, member) => {
    requireAction(member.role, "websites.manage");
    const w = await visibleWebsite(tx, access.workspace.id, websiteId);
    const [claimed] = await tx
      .update(websites)
      .set({ lastVerificationAt: new Date() })
      .where(
        and(
          eq(websites.id, websiteId),
          sql`(${websites.lastVerificationAt} is null or ${websites.lastVerificationAt} < now() - make_interval(secs => ${VERIFICATION_RETRY_SECONDS}))`
        )
      )
      .returning({ id: websites.id });
    if (!claimed) throw new AppError("rate_limited", `Please wait ${VERIFICATION_RETRY_SECONDS} seconds between checks`);
    return w;
  });

  // 2) Network check outside any transaction.
  const reason = await checkOwnership(method, website, deps);

  // 3) Record the outcome (re-checks access in a fresh transaction).
  await inWorkspace(db, actor, access, async (tx) => {
    await visibleWebsite(tx, access.workspace.id, websiteId);
    await tx
      .update(websites)
      .set(
        reason === null
          ? { verificationStatus: "verified", verificationMethod: method, verifiedAt: new Date(), lastVerificationError: null }
          : { lastVerificationError: reason }
      )
      .where(eq(websites.id, websiteId));
    if (reason === null) await scheduleReverification(tx, access.workspace.id, websiteId);
    await audit(tx, {
      organizationId: access.workspace.id,
      actorUserId: actor.userId,
      action: reason === null ? "website.verified" : "website.verification_failed",
      entityType: "website",
      entityId: websiteId,
      metadata: { domain: website.domain, method, ...(reason ? { reason } : {}) },
      ip: actor.ip,
      userAgent: actor.userAgent
    });
  });
  return { verified: reason === null, reason };
}
