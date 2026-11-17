import { notFound } from "next/navigation";
import { can, getKeyIntegration } from "@sge/core";
import { ActionForm, SubmitButton } from "@/components/form";
import { Alert, Badge, Card, Field, Input, PageHeader } from "@/components/ui";
import { db } from "@/lib/db";
import { currentActor, requireWorkspace } from "@/lib/session";
import { removePsiKeyAction, savePsiKeyAction } from "./actions";

export default async function IntegrationsPage({ params, searchParams }: PageProps<"/w/[slug]/settings/integrations">) {
  const { slug } = await params;
  const sp = await searchParams;
  const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
  if (!can(access.role, "integrations.manage")) notFound();
  const psi = await getKeyIntegration(db(), actor, access, "psi");

  return (
    <>
      <PageHeader
        title="Integrations"
        description="Connect free services with your own credentials. Keys are encrypted at rest and only used for this workspace. Nothing here is ever billed by us."
      />
      <div className="flex max-w-3xl flex-col gap-6">
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="font-semibold">Google PageSpeed Insights</h2>
              <p className="mt-1 text-sm text-muted">
                Used for Core Web Vitals. Optional: without a key, tests share Google&apos;s small free quota and may be slow at busy times. Your own key is
                free (25,000 tests a day).
              </p>
            </div>
            <Badge>{psi.connected ? `Connected ${psi.keyHint ?? ""}` : "Not connected"}</Badge>
          </div>
          {sp.saved === "psi" && psi.connected && (
            <div className="mt-4">
              <Alert tone="success">Key saved. It&apos;s stored encrypted and used for this workspace&apos;s Core Web Vitals tests.</Alert>
            </div>
          )}
          {sp.removed === "psi" && !psi.connected && (
            <div className="mt-4">
              <Alert tone="success">Key removed.</Alert>
            </div>
          )}
          {psi.lastError && (
            <div className="mt-4">
              <Alert tone="error">{psi.lastError}</Alert>
            </div>
          )}
          <ActionForm key={psi.keyHint ?? "none"} action={savePsiKeyAction.bind(null, slug)} className="mt-5 flex flex-wrap items-end gap-3">
            <div className="min-w-64 flex-1">
              <Field label={psi.connected ? "Replace API key" : "API key"} htmlFor="psi-key">
                <Input id="psi-key" name="key" type="password" autoComplete="off" required minLength={20} maxLength={128} placeholder="AIza…" />
              </Field>
            </div>
            <SubmitButton pending="Saving…">Save key</SubmitButton>
          </ActionForm>
          {psi.connected && (
            <ActionForm action={removePsiKeyAction.bind(null, slug)} confirm="Remove the PageSpeed API key?" className="mt-3">
              <SubmitButton variant="ghost">Remove key</SubmitButton>
            </ActionForm>
          )}
          <details className="mt-5 text-sm">
            <summary className="cursor-pointer text-brand">How to get a free key</summary>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted">
              <li>Open the Google Cloud console (console.cloud.google.com) and create or pick a project.</li>
              <li>Go to APIs &amp; Services → Library and enable &quot;PageSpeed Insights API&quot;.</li>
              <li>Go to APIs &amp; Services → Credentials → Create credentials → API key.</li>
              <li>Optionally restrict the key to the PageSpeed Insights API, then paste it here.</li>
            </ol>
          </details>
        </Card>
        <Card>
          <h2 className="font-semibold">Coming next</h2>
          <p className="mt-1 text-sm text-muted">Google Search Console and Google Analytics 4 connections arrive with the keywords module.</p>
        </Card>
      </div>
    </>
  );
}
