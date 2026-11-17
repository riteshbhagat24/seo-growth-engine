import { cookies } from "next/headers";
import { connection, NextResponse, type NextRequest } from "next/server";
import { completeGoogleConnection, isAppError, resolveWorkspace } from "@sge/core";
import { serverEnv } from "@sge/config";
import { db } from "@/lib/db";
import { currentActor, getSession } from "@/lib/session";
import { OAUTH_COOKIE, safeEqual, verify } from "@/lib/signed";

type Pending = { state: string; verifier: string; slug: string; userId: string; next: string };

/** Google redirects here after consent. Checks state (CSRF), the signed-in user, then stores the encrypted refresh token. */
export async function GET(req: NextRequest) {
  await connection();
  const appUrl = serverEnv().APP_URL;
  const jar = await cookies();
  const pending = verify<Pending>(jar.get(OAUTH_COOKIE)?.value);
  // Single use: always clear the pending-state cookie.
  const go = (path: string, q: string) => {
    const res = NextResponse.redirect(new URL(`${path}${path.includes("?") ? "&" : "?"}${q}`, appUrl), 303);
    res.cookies.set(OAUTH_COOKIE, "", { path: "/api/integrations/google", maxAge: 0 });
    return res;
  };

  if (!pending) return go("/app", "google=expired");
  const settings = `/w/${pending.slug}/settings/integrations`;
  const state = req.nextUrl.searchParams.get("state") ?? "";
  if (!safeEqual(state, pending.state)) return go(settings, "google=state_mismatch");
  if (req.nextUrl.searchParams.get("error")) return go(settings, "google=denied");
  const code = req.nextUrl.searchParams.get("code");
  if (!code) return go(settings, "google=denied");

  const session = await getSession();
  if (!session || session.user.id !== pending.userId) return go(settings, "google=wrong_user");
  const access = await resolveWorkspace(db(), session.user.id, pending.slug);
  if (!access) return new Response("Not found", { status: 404 });
  try {
    await completeGoogleConnection(db(), await currentActor(), access, { code, verifier: pending.verifier });
  } catch (e) {
    if (isAppError(e)) return go(settings, `google=error&reason=${encodeURIComponent(e.message.slice(0, 160))}`);
    console.error("[google] connection failed:", (e as Error).message);
    return go(settings, "google=error");
  }
  return go(pending.next, "google=connected");
}
