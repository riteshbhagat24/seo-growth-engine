import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

/**
 * Optimistic redirect only: no session cookie → sign-in page.
 * Real authorisation happens server-side in every page and action
 * (session lookup + workspace membership + permission + RLS).
 */
export function proxy(request: NextRequest) {
  if (getSessionCookie(request, { cookiePrefix: "sge" })) return NextResponse.next();
  const url = new URL("/sign-in", request.url);
  url.searchParams.set("next", request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/app/:path*", "/w/:path*", "/account/:path*", "/workspaces/:path*"]
};
