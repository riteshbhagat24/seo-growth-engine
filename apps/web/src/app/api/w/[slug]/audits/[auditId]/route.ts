import { connection } from "next/server";
import { AppError, getAudit, isUuidLike, resolveWorkspace } from "@sge/core";
import { db } from "@/lib/db";
import { processAfterResponse } from "@/lib/jobs";
import { currentActor, getSession } from "@/lib/session";

export const maxDuration = 60;

/** Live audit progress for the audit page; also nudges processing on serverless hosts. */
export async function GET(_req: Request, ctx: RouteContext<"/api/w/[slug]/audits/[auditId]">) {
  await connection();
  const { slug, auditId } = await ctx.params;
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorised" }, { status: 401 });
  if (!isUuidLike(auditId)) return Response.json({ error: "not_found" }, { status: 404 });
  const access = await resolveWorkspace(db(), session.user.id, slug);
  if (!access) return Response.json({ error: "not_found" }, { status: 404 });
  try {
    const { audit: a, crawl } = await getAudit(db(), await currentActor(), access, auditId);
    if (["crawling", "checking_links", "analyzing"].includes(a.status)) processAfterResponse(access.workspace.id);
    return Response.json({ status: a.status, pagesFetched: crawl.pagesFetched, pagesFound: crawl.pagesFound, linksChecked: a.externalLinksChecked });
  } catch (e) {
    if (e instanceof AppError) return Response.json({ error: e.code }, { status: e.status });
    throw e;
  }
}
