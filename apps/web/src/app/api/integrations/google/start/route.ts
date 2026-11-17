import { connection, NextResponse, type NextRequest } from "next/server";
import { can, defaultGoogleDeps, googleAuthStart, resolveWorkspace } from "@sge/core";
import { serverEnv } from "@sge/config";
import { db } from "@/lib/db";
import { getSession, safeNext } from "@/lib/session";
import { OAUTH_COOKIE, sign } from "@/lib/signed";

/** Starts "Connect Google" for a workspace: PKCE + state kept in a signed, httpOnly, 10-minute cookie. */
export async function GET(req: NextRequest) {
  await connection();
  const appUrl = serverEnv().APP_URL;
  const slug = req.nextUrl.searchParams.get("w") ?? "";
  const back = (q: string) => Response.redirect(new URL(`/w/${encodeURIComponent(slug)}/settings/integrations?${q}`, appUrl), 303);
  const session = await getSession();
  if (!session) return Response.redirect(new URL(`/sign-in?next=${encodeURIComponent(`/w/${slug}/settings/integrations`)}`, appUrl), 303);
  const access = await resolveWorkspace(db(), session.user.id, slug);
  if (!access) return new Response("Not found", { status: 404 });
  if (!can(access.role, "integrations.manage")) return back("google=forbidden");
  const cfg = defaultGoogleDeps.config();
  if (!cfg) return back("google=not_configured");

  const start = googleAuthStart(cfg, session.user.email);
  const next = safeNext(req.nextUrl.searchParams.get("next"), `/w/${access.workspace.slug}/settings/integrations`);
  const res = NextResponse.redirect(start.url, 303);
  res.cookies.set(OAUTH_COOKIE, sign({ state: start.state, verifier: start.verifier, slug: access.workspace.slug, userId: session.user.id, next }, 600), {
    httpOnly: true,
    secure: appUrl.startsWith("https://"),
    sameSite: "lax",
    path: "/api/integrations/google",
    maxAge: 600
  });
  return res;
}
