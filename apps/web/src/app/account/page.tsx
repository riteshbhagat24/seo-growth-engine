import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { Card, PageHeader } from "@/components/ui";
import { getAuth } from "@/lib/auth";
import { getSession, requireUser } from "@/lib/session";
import { ChangePasswordForm, ProfileForm, SessionsList } from "./account-forms";

export const metadata: Metadata = { title: "Account" };

export default async function AccountPage() {
  const user = await requireUser("/account");
  const current = await getSession();
  const h = await headers();
  const sessions = await getAuth().api.listSessions({ headers: h });

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-10 sm:px-6">
      <Link href="/app" className="text-sm text-muted hover:text-foreground">
        ← Back to app
      </Link>
      <div className="mt-4">
        <PageHeader title="Your account" description={user.email} />
      </div>
      <div className="flex flex-col gap-6">
        <Card>
          <h2 className="mb-4 font-semibold">Profile</h2>
          <ProfileForm name={user.name} />
        </Card>
        <Card>
          <h2 className="mb-4 font-semibold">Password</h2>
          <ChangePasswordForm />
        </Card>
        <Card>
          <h2 className="mb-1 font-semibold">Active sessions</h2>
          <p className="mb-4 text-sm text-muted">Devices where you're signed in.</p>
          <SessionsList
            currentId={current?.session.id ?? ""}
            sessions={sessions.map((s) => ({
              id: s.id,
              userAgent: s.userAgent ?? null,
              ipAddress: s.ipAddress ?? null,
              createdAt: new Date(s.createdAt).toISOString()
            }))}
          />
        </Card>
      </div>
    </main>
  );
}
