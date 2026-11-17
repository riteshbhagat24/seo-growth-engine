import { and, desc, eq, schema, withContext, type Db, type Tx } from "@sge/db";
import type { CwvResult } from "@sge/db/schema";
import { normalizeCrawlUrl, sameSite } from "@sge/crawler";
import { enqueue, type JobHandler } from "@sge/jobs";
import { parsePsi, psiRequestUrl, type Strategy } from "@sge/seo-rules";
import { audit } from "./audit";
import { assertId, inWorkspace, requireAction, type Actor, type WorkspaceAccess } from "./context";
import { AppError } from "./errors";
import { recordIntegrationError, workspaceApiKey } from "./integrations";
import { consumeUsage } from "./plans";

const { cwvResults, websites } = schema;

export const CWV_JOB = "cwv.run";
const STRATEGIES: Strategy[] = ["mobile", "desktop"];

/** Resolves user input ("/pricing" or a full URL) to a URL on the website. */
export function urlOnWebsite(input: string, w: { url: string; domain: string }): string {
  const raw = input.trim() || "/";
  const url = normalizeCrawlUrl(raw.startsWith("/") ? `${w.url}${raw}` : /^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  if (!url || !sameSite(url, new URL(w.url).hostname)) throw new AppError("invalid_input", `Enter a page on ${w.domain}`);
  return url;
}

/** Queues a mobile + desktop measurement (2 PageSpeed runs against the plan). */
export async function requestCwv(db: Db, actor: Actor, access: WorkspaceAccess, websiteId: string, pageInput = "/"): Promise<CwvResult[]> {
  assertId(websiteId, "Website");
  return inWorkspace(db, actor, access, async (tx, { role }) => {
    requireAction(role, "work.run");
    const [w] = await tx.select().from(websites).where(eq(websites.id, websiteId));
    if (!w) throw new AppError("not_found", "Website not found");
    const url = urlOnWebsite(pageInput, w);
    const [busy] = await tx
      .select({ id: cwvResults.id })
      .from(cwvResults)
      .where(and(eq(cwvResults.websiteId, w.id), eq(cwvResults.status, "queued")));
    if (busy) throw new AppError("conflict", "A Core Web Vitals measurement is already running for this website");
    if (!(await consumeUsage(tx, access.workspace.id, "psi_runs_month", STRATEGIES.length)))
      throw new AppError("limit_reached", "This month's Core Web Vitals allowance for your plan is used up.");

    const rows = await tx
      .insert(cwvResults)
      .values(STRATEGIES.map((strategy) => ({ organizationId: access.workspace.id, websiteId: w.id, url, strategy, createdByUserId: actor.userId })))
      .returning();
    for (const r of rows)
      await enqueue(tx, {
        type: CWV_JOB,
        organizationId: access.workspace.id,
        websiteId: w.id,
        payload: { resultId: r.id },
        idempotencyKey: `cwv:${r.id}`,
        maxAttempts: 3,
        createdByUserId: actor.userId
      });
    await audit(tx, {
      organizationId: access.workspace.id,
      actorUserId: actor.userId,
      action: "cwv.requested",
      entityType: "website",
      entityId: w.id,
      metadata: { url },
      ip: actor.ip,
      userAgent: actor.userAgent
    });
    return rows;
  });
}

export async function listCwv(db: Db, actor: Actor, access: WorkspaceAccess, websiteId: string, limit = 10): Promise<CwvResult[]> {
  assertId(websiteId, "Website");
  return inWorkspace(db, actor, access, (tx) =>
    tx.select().from(cwvResults).where(eq(cwvResults.websiteId, websiteId)).orderBy(desc(cwvResults.createdAt)).limit(Math.min(limit, 50))
  );
}

export interface CwvHandlerOptions {
  /** Platform-wide PSI key (optional; keyless requests share Google's small quota). */
  apiKey?: string | null;
  fetch?: typeof fetch;
}

const friendly = (status: number, message: string, usedOrgKey: boolean) => {
  if (status === 429)
    return usedOrgKey
      ? "Your Google API key's PageSpeed quota is used up for now. Try again later."
      : "Google's shared PageSpeed quota is busy. Try again later, or add your own free API key in Settings → Integrations.";
  if (status === 400 && /api key/i.test(message)) return "Google rejected the PageSpeed API key. Check it in Settings → Integrations.";
  if (status === 400 || status === 500) return `PageSpeed couldn't test this page: ${message}`.slice(0, 300);
  return `PageSpeed Insights error (${status}).`;
};

export function createCwvHandler(o: CwvHandlerOptions = {}): JobHandler {
  const fetchFn = o.fetch ?? fetch;
  return async ({ job, appDb, deadline }) => {
    const org = job.organizationId!;
    const resultId = String(job.payload.resultId ?? "");
    assertId(resultId, "Result");
    const t = <T>(fn: (tx: Tx) => Promise<T>) => withContext(appDb, { organizationId: org }, fn);
    const [row, orgKey] = await t(async (tx) => [(await tx.select().from(cwvResults).where(eq(cwvResults.id, resultId)))[0], await workspaceApiKey(tx, org, "psi")] as const);
    if (!row || row.status !== "queued") return { done: true };

    const fail = (error: string) =>
      t((tx) => tx.update(cwvResults).set({ status: "failed", error, updatedAt: new Date() }).where(eq(cwvResults.id, row.id)));
    const lastAttempt = job.attempts >= job.maxAttempts;
    const key = orgKey ?? o.apiKey ?? null;
    const timeout = Math.max(5_000, Math.min(60_000, deadline - Date.now() - 1_000));

    let res: Response;
    try {
      res = await fetchFn(psiRequestUrl(row.url, row.strategy as Strategy, key), { signal: AbortSignal.timeout(timeout) });
    } catch {
      if (lastAttempt) {
        await fail("PageSpeed Insights didn't respond in time. Try again later.");
        return { done: true };
      }
      throw new Error("PageSpeed request failed or timed out");
    }
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const message = String((body as { error?: { message?: string } } | null)?.error?.message ?? res.statusText);
      const transient = res.status === 429 || res.status >= 502;
      if (transient && !lastAttempt) throw new Error(`PageSpeed returned ${res.status}`);
      const text = friendly(res.status, message, Boolean(orgKey));
      if (orgKey && res.status === 400 && /api key/i.test(message)) await t((tx) => recordIntegrationError(tx, org, "psi", text));
      await fail(text);
      return { done: true };
    }
    try {
      const metrics = parsePsi(body);
      await t(async (tx) => {
        await tx
          .update(cwvResults)
          .set({ status: "completed", metrics: metrics as unknown as Record<string, unknown>, measuredAt: new Date(), error: null, updatedAt: new Date() })
          .where(eq(cwvResults.id, row.id));
        if (orgKey) await recordIntegrationError(tx, org, "psi", null);
      });
    } catch (e) {
      await fail((e as Error).message.slice(0, 300));
    }
    return { done: true };
  };
}
