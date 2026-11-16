import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/form";
import { Alert, Card, Field, Input } from "@/components/ui";
import { currentActor } from "@/lib/session";
import { createAgencyAction } from "./actions";

export const metadata: Metadata = { title: "New agency workspace" };

export default async function NewWorkspacePage() {
  const actor = await currentActor();
  return (
    <main className="mx-auto w-full max-w-lg flex-1 px-4 py-16">
      <Link href="/app" className="text-sm text-muted hover:text-foreground">
        ← Back
      </Link>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight">Create an agency workspace</h1>
      <p className="mt-1 mb-6 text-sm text-muted">
        For teams managing SEO for clients: invite teammates, assign roles, and (soon) give clients their own dashboards.
      </p>
      <Card>
        {actor.emailVerified ? (
          <ActionForm action={createAgencyAction} className="flex flex-col gap-4">
            <Field label="Agency name" htmlFor="name">
              <Input id="name" name="name" required minLength={2} maxLength={80} placeholder="Acme Digital" />
            </Field>
            <div>
              <SubmitButton pending="Creating…">Create workspace</SubmitButton>
            </div>
          </ActionForm>
        ) : (
          <Alert tone="error">Verify your email address before creating an agency workspace.</Alert>
        )}
      </Card>
    </main>
  );
}
