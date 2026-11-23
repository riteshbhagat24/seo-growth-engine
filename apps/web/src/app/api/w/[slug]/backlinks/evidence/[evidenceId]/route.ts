import { connection } from "next/server";
import { evidenceFile } from "@sge/backlinks";
import { AppError, isUuidLike, resolveWorkspace } from "@sge/core";
import { db } from "@/lib/db";
import { currentActor, getSession } from "@/lib/session";

/**
 * One piece of submission evidence. Screenshots are shown inline; everything else (HTML snapshots of third-party
 * pages, HTTP exchanges) is served as plain-text attachments in a sandbox, so it can never run on our origin.
 */
export async function GET(_req: Request, ctx: RouteContext<"/api/w/[slug]/backlinks/evidence/[evidenceId]">) {
  await connection();
  const { slug, evidenceId } = await ctx.params;
  const session = await getSession();
  if (!session) return new Response("Sign in first", { status: 401 });
  if (!isUuidLike(evidenceId)) return new Response("Not found", { status: 404 });
  const access = await resolveWorkspace(db(), session.user.id, slug);
  if (!access) return new Response("Not found", { status: 404 });
  try {
    const e = await evidenceFile(db(), await currentActor(), access, evidenceId);
    const safe = { "x-content-type-options": "nosniff", "content-security-policy": "sandbox; default-src 'none'", "cache-control": "private, no-store" };
    if (e.data && e.content_type === "image/png")
      return new Response(new Uint8Array(e.data), { headers: { ...safe, "content-type": "image/png", "content-disposition": `inline; filename="evidence-${evidenceId.slice(0, 8)}.png"` } });
    const body = e.content ?? (e.data ? e.data.toString("utf8") : "");
    return new Response(body, {
      headers: { ...safe, "content-type": "text/plain; charset=utf-8", "content-disposition": `attachment; filename="evidence-${evidenceId.slice(0, 8)}-${e.kind}.txt"` }
    });
  } catch (err) {
    if (err instanceof AppError) return new Response(err.message, { status: err.status });
    throw err;
  }
}
