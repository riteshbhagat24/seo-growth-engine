import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { googleSignInEnabled, serverEnv } from "@sge/config";
import { getSession, safeNext } from "@/lib/session";
import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  const sp = await searchParams;
  const next = safeNext(typeof sp.next === "string" ? sp.next : null);
  if (await getSession()) redirect(next);
  return (
    <>
      <h1 className="text-xl font-semibold">Sign in</h1>
      <p className="mt-1 mb-6 text-sm text-muted">Welcome back.</p>
      <SignInForm next={next} google={googleSignInEnabled(serverEnv())} />
    </>
  );
}
