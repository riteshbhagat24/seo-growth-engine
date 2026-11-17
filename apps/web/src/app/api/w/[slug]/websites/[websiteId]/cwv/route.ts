import { connection } from "next/server";
import { AppError, isUuidLike, listCwv, resolveWorkspace } from "@sge/core";
import { db } from "@/lib/db";
import { processAfterResponse } from "@/lib/jobs";
import { currentActor, getSession } from "@/lib/session";

export const maxDuration = 60;

/** Core Web Vitals progress for the website page; also nudges processing on serverless hosts. */
export async function GET(_req: Request, ctx: RouteContext<"/api/w/[slug]/websites/[websiteId]/cwv">) {
  await connection();
  const { slug, websiteId } = await ctx.params;
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorised" }, { status: 401 });
  if (!isUuidLike(websiteId)) return Response.json({ error: "not_found" }, { status: 404 });
  const access = await resolveWorkspace(db(), session.user.id, slug);
  if (!access) return Response.json({ error: "not_found" }, { status: 404 });
  try {
    const rows = await listCwv(db(), await currentActor(), access, websiteId, 4);
    const queued = rows.filter((r) => r.status === "queued").length;
    if (queued) processAfterResponse(access.workspace.id);
    return Response.json({ status: queued ? "queued" : "done", queued });
  } catch (e) {
    if (e instanceof AppError) return Response.json({ error: e.code }, { status: e.status });
    throw e;
  }
}
