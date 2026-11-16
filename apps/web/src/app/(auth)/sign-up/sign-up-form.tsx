"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth-client";
import { Alert, Button, Field, Input } from "@/components/ui";

export function SignUpForm({ next, defaultEmail, google }: { next: string; defaultEmail: string; google: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const data = new FormData(e.currentTarget);
    const email = String(data.get("email") ?? "");
    const password = String(data.get("password") ?? "");
    if (password !== String(data.get("confirm") ?? "")) {
      setError("Passwords don't match");
      return;
    }
    setPending(true);
    try {
      const { error } = await authClient.signUp.email({
        name: String(data.get("name") ?? "").trim(),
        email,
        password,
        callbackURL: next
      });
      if (error) setError(error.message ?? "Couldn't create the account");
      else setSentTo(email);
    } finally {
      setPending(false);
    }
  }

  if (sentTo) {
    return (
      <Alert tone="success">
        We've sent a verification link to <strong>{sentTo}</strong>. Open it to finish creating your account.
      </Alert>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <Field label="Your name" htmlFor="name">
          <Input id="name" name="name" autoComplete="name" required maxLength={80} />
        </Field>
        <Field label="Work email" htmlFor="email">
          <Input id="email" name="email" type="email" autoComplete="email" required defaultValue={defaultEmail} />
        </Field>
        <Field label="Password" htmlFor="password" hint="At least 10 characters.">
          <Input id="password" name="password" type="password" autoComplete="new-password" required minLength={10} maxLength={128} />
        </Field>
        <Field label="Confirm password" htmlFor="confirm">
          <Input id="confirm" name="confirm" type="password" autoComplete="new-password" required minLength={10} maxLength={128} />
        </Field>
        {error && <Alert tone="error">{error}</Alert>}
        <Button type="submit" disabled={pending}>
          {pending ? "Creating account…" : "Create account"}
        </Button>
      </form>
      {google && (
        <Button type="button" variant="secondary" onClick={() => authClient.signIn.social({ provider: "google", callbackURL: next })}>
          Continue with Google
        </Button>
      )}
      <p className="border-t border-border pt-4 text-sm text-muted">
        Already have an account?{" "}
        <Link href={`/sign-in?next=${encodeURIComponent(next)}`} className="text-brand hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}
