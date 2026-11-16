"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth-client";
import { Alert, Button, Field, Input } from "@/components/ui";

export function SignInForm({ next, google }: { next: string; google: boolean }) {
  const router = useRouter();
  const [mode, setMode] = useState<"password" | "link">("password");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setPending(true);
    const data = new FormData(e.currentTarget);
    const email = String(data.get("email") ?? "");
    try {
      if (mode === "link") {
        const { error } = await authClient.signIn.magicLink({ email, callbackURL: next });
        if (error) setError(error.message ?? "Couldn't send the link. Try again shortly.");
        else setInfo("Check your inbox for a sign-in link. It expires in 10 minutes.");
        return;
      }
      const { error } = await authClient.signIn.email({ email, password: String(data.get("password") ?? ""), callbackURL: next });
      if (error) {
        if (error.status === 403) setInfo("Please verify your email first. We've sent you a new verification link.");
        else setError(error.message ?? "Sign-in failed");
        return;
      }
      router.push(next);
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <Field label="Email" htmlFor="email">
          <Input id="email" name="email" type="email" autoComplete="email" required />
        </Field>
        {mode === "password" && (
          <Field label="Password" htmlFor="password">
            <Input id="password" name="password" type="password" autoComplete="current-password" required />
          </Field>
        )}
        {error && <Alert tone="error">{error}</Alert>}
        {info && <Alert tone="success">{info}</Alert>}
        <Button type="submit" disabled={pending}>
          {pending ? "Please wait…" : mode === "password" ? "Sign in" : "Email me a sign-in link"}
        </Button>
      </form>

      <button
        type="button"
        className="text-sm text-muted underline-offset-4 hover:text-foreground hover:underline"
        onClick={() => {
          setMode(mode === "password" ? "link" : "password");
          setError(null);
          setInfo(null);
        }}
      >
        {mode === "password" ? "Sign in with an email link instead" : "Sign in with a password instead"}
      </button>

      {google && (
        <Button
          type="button"
          variant="secondary"
          onClick={() => authClient.signIn.social({ provider: "google", callbackURL: next })}
        >
          Continue with Google
        </Button>
      )}

      <div className="flex justify-between border-t border-border pt-4 text-sm">
        <Link href={`/sign-up?next=${encodeURIComponent(next)}`} className="text-brand hover:underline">
          Create an account
        </Link>
        <Link href="/forgot-password" className="text-muted hover:text-foreground">
          Forgot password?
        </Link>
      </div>
    </div>
  );
}
