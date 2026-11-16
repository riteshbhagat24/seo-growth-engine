"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth-client";
import { Alert, Button, Field, Input } from "@/components/ui";

export default function ForgotPasswordPage() {
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const email = String(new FormData(e.currentTarget).get("email") ?? "");
    const { error } = await authClient.requestPasswordReset({ email, redirectTo: "/reset-password" });
    setPending(false);
    // Same message whether or not the account exists (no account enumeration).
    if (error && error.status === 429) setError("Too many requests. Please wait a few minutes.");
    else setDone(true);
  }

  return (
    <>
      <h1 className="text-xl font-semibold">Reset your password</h1>
      <p className="mt-1 mb-6 text-sm text-muted">We'll email you a link to choose a new one.</p>
      {done ? (
        <Alert tone="success">If an account exists for that email, a reset link is on its way. It expires in 1 hour.</Alert>
      ) : (
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <Field label="Email" htmlFor="email">
            <Input id="email" name="email" type="email" autoComplete="email" required />
          </Field>
          {error && <Alert tone="error">{error}</Alert>}
          <Button type="submit" disabled={pending}>
            {pending ? "Sending…" : "Send reset link"}
          </Button>
        </form>
      )}
      <p className="mt-6 border-t border-border pt-4 text-sm">
        <Link href="/sign-in" className="text-brand hover:underline">
          Back to sign in
        </Link>
      </p>
    </>
  );
}
