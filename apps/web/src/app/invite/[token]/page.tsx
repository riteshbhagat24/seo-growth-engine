import type { Metadata } from "next";
import { previewInvitation, ROLE_LABEL } from "@sge/core";
import { ActionForm, SubmitButton } from "@/components/form";
import { Alert, LinkButton } from "@/components/ui";
import { db } from "@/lib/db";
import { getSession } from "@/lib/session";
import { acceptInvitationAction } from "./actions";

export const metadata: Metadata = { title: "Invitation", robots: { index: false } };

export default async function InvitePage({ params }: PageProps<"/invite/[token]">) {
  const { token } = await params;
  const [preview, session] = await Promise.all([previewInvitation(db(), token), getSession()]);
  const here = `/invite/${token}`;

  let body: React.ReactNode;
  if (!preview) {
    body = <Alert tone="error">This invitation link isn't valid. Ask whoever invited you to send a new one.</Alert>;
  } else if (preview.state !== "valid") {
    const why = { expired: "has expired", accepted: "has already been used", revoked: "was withdrawn" }[preview.state];
    body = <Alert tone="error">This invitation {why}. Ask {preview.workspaceName} to send a new one.</Alert>;
  } else {
    const intro = (
      <p className="text-sm">
        You've been invited to join <strong>{preview.workspaceName}</strong> as <strong>{ROLE_LABEL[preview.role]}</strong>.
      </p>
    );
    if (!session) {
      body = (
        <div className="flex flex-col gap-4">
          {intro}
          <p className="text-sm text-muted">
            Sign in or create an account with <strong>{preview.email}</strong> to accept.
          </p>
          <div className="flex gap-2">
            <LinkButton href={`/sign-in?next=${encodeURIComponent(here)}`}>Sign in</LinkButton>
            <LinkButton variant="secondary" href={`/sign-up?next=${encodeURIComponent(here)}&email=${encodeURIComponent(preview.email)}`}>
              Create account
            </LinkButton>
          </div>
        </div>
      );
    } else if (session.user.email.toLowerCase() !== preview.email.toLowerCase()) {
      body = (
        <div className="flex flex-col gap-4">
          {intro}
          <Alert tone="error">
            This invitation was sent to <strong>{preview.email}</strong>, but you're signed in as {session.user.email}. Sign out
            and sign in with the invited address.
          </Alert>
        </div>
      );
    } else {
      body = (
        <div className="flex flex-col gap-4">
          {intro}
          <ActionForm action={acceptInvitationAction.bind(null, token)}>
            <SubmitButton pending="Joining…">Accept and join</SubmitButton>
          </ActionForm>
        </div>
      );
    }
  }

  return (
    <main className="flex min-h-full flex-1 items-center justify-center px-4 py-16">
      <div className="w-full max-w-md rounded-xl border border-border bg-surface p-6 sm:p-8">
        <h1 className="mb-4 text-xl font-semibold">Workspace invitation</h1>
        {body}
      </div>
    </main>
  );
}
