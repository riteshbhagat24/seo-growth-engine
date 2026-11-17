import { connection } from "next/server";
import { sql } from "@sge/db";
import { serverEnv } from "@sge/config";
import { db } from "@/lib/db";

/**
 * Liveness + configuration + database reachability + isolation safety.
 * Details go to logs, not the response.
 */
export async function GET() {
  await connection();
  try {
    serverEnv();
  } catch (err) {
    console.error("[health] configuration error:", (err as Error).message);
    return Response.json({ status: "error", config: "invalid" }, { status: 503 });
  }

  let role: { superuser: boolean; bypass: boolean; owns_tables: boolean } | undefined;
  try {
    const r = await db().execute<{ superuser: boolean; bypass: boolean; owns_tables: boolean }>(sql`
      select r.rolsuper as superuser, r.rolbypassrls as bypass,
             exists (select 1 from pg_tables t where t.schemaname = 'public' and t.tableowner = current_user) as owns_tables
      from pg_roles r where r.rolname = current_user`);
    role = r.rows[0];
  } catch (err) {
    console.error("[health] database error:", (err as Error).message, (err as { cause?: unknown }).cause);
    // Only a code (e.g. 28P01, ENOTFOUND, ETIMEDOUT): useful for diagnosis, reveals no secrets.
    const e = err as { code?: string; cause?: { code?: string; errno?: string } };
    const code = e.cause?.code ?? e.code ?? e.cause?.errno ?? "unknown";
    return Response.json({ status: "degraded", config: "ok", database: "unreachable", code: String(code).slice(0, 20) }, { status: 503 });
  }

  // Tenant isolation depends on the runtime role being unprivileged.
  if (!role || role.superuser || role.bypass || role.owns_tables) {
    console.error("[health] APP_DATABASE_URL uses a privileged role; tenant isolation is not guaranteed", role);
    return Response.json({ status: "error", config: "ok", database: "ok", isolation: "unsafe_role" }, { status: 503 });
  }
  // "log" = demo mode: emails are not delivered (see MAIL_TRANSPORT).
  return Response.json({ status: "ok", config: "ok", database: "ok", isolation: "ok", mail: serverEnv().MAIL_TRANSPORT });
}
