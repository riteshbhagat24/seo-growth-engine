import { connection } from "next/server";
import { AppError, getCrawl, isUuidLike, resolveWorkspace } from "@sge/core";
import { db } from "@/lib/db";
import { processAfterResponse } from "@/lib/jobs";
import { currentActor, getSession } from "@/lib/session";

export const maxDuration = 60;

/** Live crawl progress for the crawl page; also nudges processing on serverless hosts. */
export async function GET(_req: Request, ctx: RouteContext<"/api/w/[slug]/crawls/[crawlId]">) {
  await connection();
  const { slug, crawlId } = await ctx.params;
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorised" }, { status: 401 });
  if (!isUuidLike(crawlId)) return Response.json({ error: "not_found" }, { status: 404 });
  const access = await resolveWorkspace(db(), session.user.id, slug);
  if (!access) return Response.json({ error: "not_found" }, { status: 404 });
  try {
    const { crawl, counts } = await getCrawl(db(), await currentActor(), access, crawlId, { limit: 0 });
    if (crawl.status === "queued" || crawl.status === "running") processAfterResponse(access.workspace.id);
    return Response.json({ status: crawl.status, pagesFetched: crawl.pagesFetched, pagesFound: crawl.pagesFound, maxPages: crawl.maxPages, counts });
  } catch (e) {
    if (e instanceof AppError) return Response.json({ error: e.code }, { status: e.status });
    throw e;
  }
}
