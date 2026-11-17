import { connection } from "next/server";
import { AppError, auditIssuesCsv, isUuidLike, resolveWorkspace } from "@sge/core";
import { db } from "@/lib/db";
import { currentActor, getSession } from "@/lib/session";

/** Download every issue of an audit as CSV. */
export async function GET(_req: Request, ctx: RouteContext<"/api/w/[slug]/audits/[auditId]/csv">) {
  await connection();
  const { slug, auditId } = await ctx.params;
  const session = await getSession();
  if (!session) return new Response("Sign in first", { status: 401 });
  if (!isUuidLike(auditId)) return new Response("Not found", { status: 404 });
  const access = await resolveWorkspace(db(), session.user.id, slug);
  if (!access) return new Response("Not found", { status: 404 });
  try {
    const csv = await auditIssuesCsv(db(), await currentActor(), access, auditId);
    return new Response(`﻿${csv}`, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="audit-${auditId.slice(0, 8)}-issues.csv"`,
        "cache-control": "no-store"
      }
    });
  } catch (e) {
    if (e instanceof AppError) return new Response(e.message, { status: e.status });
    throw e;
  }
}
