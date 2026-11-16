import { connection } from "next/server";
import { sql } from "@sge/db";
import { serverEnv } from "@sge/config";
import { db } from "@/lib/db";

/** Liveness + configuration + database reachability. Details go to logs, not the response. */
export async function GET() {
  await connection();
  try {
    serverEnv();
  } catch (err) {
    console.error("[health] configuration error:", (err as Error).message);
    return Response.json({ status: "error", config: "invalid" }, { status: 503 });
  }
  try {
    await db().execute(sql`select 1`);
    return Response.json({ status: "ok", config: "ok", database: "ok" });
  } catch (err) {
    console.error("[health] database error:", (err as Error).message);
    return Response.json({ status: "degraded", config: "ok", database: "unreachable" }, { status: 503 });
  }
}
