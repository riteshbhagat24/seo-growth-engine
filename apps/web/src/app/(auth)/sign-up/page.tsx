import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { googleSignInEnabled, serverEnv } from "@sge/config";
import { getSession, safeNext } from "@/lib/session";
import { SignUpForm } from "./sign-up-form";

export const metadata: Metadata = { title: "Create account" };

export default async function SignUpPage({ searchParams }: PageProps<"/sign-up">) {
  const sp = await searchParams;
  const next = safeNext(typeof sp.next === "string" ? sp.next : null);
  if (await getSession()) redirect(next);
  const email = typeof sp.email === "string" ? sp.email.slice(0, 254) : "";
  return (
    <>
      <h1 className="text-xl font-semibold">Create your account</h1>
      <p className="mt-1 mb-6 text-sm text-muted">Free to start. No card required.</p>
      <SignUpForm next={next} defaultEmail={email} google={googleSignInEnabled(serverEnv())} />
    </>
  );
}
