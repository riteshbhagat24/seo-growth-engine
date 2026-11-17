import { timingSafeEqual } from "node:crypto";
import { connection } from "next/server";
import { serverEnv } from "@sge/config";
import { jobsEnabled, processJobs } from "@/lib/jobs";

// Vercel Cron and external schedulers (e.g. cron-job.org) call this with
// "Authorization: Bearer <CRON_SECRET>". cPanel uses the worker's --once mode instead.
export const maxDuration = 60;

function authorised(header: string | null): boolean {
  const secret = serverEnv().CRON_SECRET;
  if (!secret || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(request: Request) {
  await connection();
  if (!authorised(request.headers.get("authorization"))) return Response.json({ error: "unauthorised" }, { status: 401 });
  if (!jobsEnabled()) return Response.json({ error: "WORKER_DATABASE_URL is not configured" }, { status: 503 });
  const result = await processJobs();
  return Response.json({ ok: true, ...result });
}
