"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth-client";
import { Alert, Button, Field, Input } from "@/components/ui";

type Msg = { tone: "error" | "success"; text: string } | null;

function useSubmit(fn: (data: FormData) => Promise<Msg>) {
  const [msg, setMsg] = useState<Msg>(null);
  const [pending, setPending] = useState(false);
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    setPending(true);
    setMsg(null);
    try {
      const result = await fn(new FormData(form));
      setMsg(result);
      if (result?.tone === "success") form.reset();
    } finally {
      setPending(false);
    }
  }
  return { msg, pending, onSubmit };
}

export function ProfileForm({ name }: { name: string }) {
  const router = useRouter();
  const { msg, pending, onSubmit } = useSubmit(async (d) => {
    const { error } = await authClient.updateUser({ name: String(d.get("name") ?? "").trim() });
    if (error) return { tone: "error", text: error.message ?? "Couldn't save" };
    router.refresh();
    return { tone: "success", text: "Name updated." };
  });
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <Field label="Name" htmlFor="name">
        <Input id="name" name="name" defaultValue={name} required maxLength={80} />
      </Field>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}

export function ChangePasswordForm() {
  const { msg, pending, onSubmit } = useSubmit(async (d) => {
    const newPassword = String(d.get("newPassword") ?? "");
    if (newPassword !== String(d.get("confirm") ?? "")) return { tone: "error", text: "New passwords don't match" };
    const { error } = await authClient.changePassword({
      currentPassword: String(d.get("currentPassword") ?? ""),
      newPassword,
      revokeOtherSessions: true
    });
    if (error) return { tone: "error", text: error.message ?? "Couldn't change the password" };
    return { tone: "success", text: "Password changed. Other devices have been signed out." };
  });
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <Field label="Current password" htmlFor="currentPassword" hint="Signed up with Google or an email link? Use “Forgot password” to set one.">
        <Input id="currentPassword" name="currentPassword" type="password" autoComplete="current-password" required />
      </Field>
      <Field label="New password" htmlFor="newPassword" hint="At least 10 characters.">
        <Input id="newPassword" name="newPassword" type="password" autoComplete="new-password" required minLength={10} maxLength={128} />
      </Field>
      <Field label="Confirm new password" htmlFor="confirm">
        <Input id="confirm" name="confirm" type="password" autoComplete="new-password" required minLength={10} maxLength={128} />
      </Field>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Change password"}
        </Button>
      </div>
    </form>
  );
}

interface SessionRow {
  id: string;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
}

function describe(ua: string | null): string {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

export function SessionsList({ sessions, currentId }: { sessions: SessionRow[]; currentId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const others = sessions.filter((s) => s.id !== currentId);
  return (
    <div className="flex flex-col gap-4">
      <ul className="divide-y divide-border text-sm">
        {sessions.map((s) => (
          <li key={s.id} className="flex justify-between gap-4 py-2">
            <span>
              {describe(s.userAgent)}
              {s.id === currentId && <span className="ml-2 text-xs text-success">This device</span>}
            </span>
            <span className="text-muted">
              {s.ipAddress ?? "—"} · {new Date(s.createdAt).toLocaleDateString("en-GB")}
            </span>
          </li>
        ))}
      </ul>
      {others.length > 0 && (
        <div>
          <Button
            variant="secondary"
            disabled={pending}
            onClick={async () => {
              setPending(true);
              await authClient.revokeOtherSessions();
              setPending(false);
              router.refresh();
            }}
          >
            Sign out of {others.length} other {others.length === 1 ? "session" : "sessions"}
          </Button>
        </div>
      )}
    </div>
  );
}
