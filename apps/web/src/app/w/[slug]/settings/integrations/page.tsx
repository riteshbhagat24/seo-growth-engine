import { notFound } from "next/navigation";
import { BarChart3, Gauge } from "lucide-react";
import { can, getGoogleConnection, getKeyIntegration, GA4_SCOPE, GSC_SCOPE } from "@sge/core";
import { ActionForm, SubmitButton } from "@/components/form";
import { Alert, Badge, Card, CardHeader, Field, Input, LinkButton, PageHeader } from "@/components/ui";
import { db } from "@/lib/db";
import { currentActor, requireWorkspace } from "@/lib/session";
import { disconnectGoogleAction, removePsiKeyAction, savePsiKeyAction } from "./actions";

const GOOGLE_MESSAGES: Record<string, { tone: "success" | "error" | "info"; text: string }> = {
  connected: { tone: "success", text: "Google connected. Now link each website to its Search Console and Analytics properties in the website's Settings tab." },
  disconnected: { tone: "success", text: "Google disconnected. Imported data is kept; syncing has stopped." },
  denied: { tone: "error", text: "Google access wasn't granted." },
  expired: { tone: "error", text: "The connection attempt expired. Please try again." },
  state_mismatch: { tone: "error", text: "The connection attempt couldn't be verified. Please try again." },
  wrong_user: { tone: "error", text: "Finish connecting while signed in as the same user who started it." },
  forbidden: { tone: "error", text: "Only owners and admins can connect Google." },
  not_configured: { tone: "info", text: "Google isn't set up on this platform yet." },
  error: { tone: "error", text: "Google sign-in didn't complete." }
};

export default async function IntegrationsPage({ params, searchParams }: PageProps<"/w/[slug]/settings/integrations">) {
  const { slug } = await params;
  const sp = await searchParams;
  const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
  if (!can(access.role, "integrations.manage")) notFound();
  const [psi, google] = await Promise.all([getKeyIntegration(db(), actor, access, "psi"), getGoogleConnection(db(), actor, access)]);
  const gmsg = typeof sp.google === "string" ? GOOGLE_MESSAGES[sp.google] : undefined;
  const reason = typeof sp.reason === "string" ? sp.reason.slice(0, 160) : null;

  return (
    <>
      <PageHeader
        title="Integrations"
        description="Connect free services with your own credentials. Keys are encrypted at rest and only used for this workspace. Nothing here is ever billed by us."
      />
      <div className="flex max-w-3xl flex-col gap-6">
        <Card>
          <CardHeader
            icon={<BarChart3 className="size-4" />}
            title="Google Search Console & Analytics"
            description="One Google account per workspace, read-only. Used for clicks, queries and positions (Search Console) and sessions and key events (GA4). Tokens are encrypted at rest."
            actions={
              google.connected ? <Badge tone="success">Connected</Badge> : google.status === "expired" ? <Badge tone="warning">Reconnect needed</Badge> : <Badge>Not connected</Badge>
            }
          />
          {gmsg && (
            <div className="mb-4">
              <Alert tone={gmsg.tone}>
                {gmsg.text}
                {reason && ` ${reason}`}
              </Alert>
            </div>
          )}
          {!google.configured ? (
            <Alert>
              The platform administrator needs to add a Google OAuth client (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET) before workspaces can connect Google.
            </Alert>
          ) : google.connected ? (
            <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
              <div>
                <div className="font-medium">{google.email ?? "Google account"}</div>
                <div className="text-muted">
                  Access: {[google.scopes.includes(GSC_SCOPE) && "Search Console", google.scopes.includes(GA4_SCOPE) && "Analytics"].filter(Boolean).join(" and ") || "none"}
                  {google.lastError && <span className="block text-danger">{google.lastError}</span>}
                </div>
              </div>
              <div className="flex gap-2">
                <LinkButton variant="secondary" href={`/api/integrations/google/start?w=${slug}`} prefetch={false}>
                  Reconnect
                </LinkButton>
                <ActionForm action={disconnectGoogleAction.bind(null, slug)} confirm="Disconnect Google? Syncing stops; imported data is kept.">
                  <SubmitButton variant="ghost">Disconnect</SubmitButton>
                </ActionForm>
              </div>
            </div>
          ) : (
            <LinkButton href={`/api/integrations/google/start?w=${slug}`} prefetch={false}>
              {google.status === "expired" ? "Reconnect Google" : "Connect Google"}
            </LinkButton>
          )}
        </Card>
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-brand/10 text-brand">
                <Gauge className="size-4" />
              </span>
              <div>
              <h2 className="font-semibold">Google PageSpeed Insights</h2>
              <p className="mt-1 text-sm text-muted">
                Used for Core Web Vitals. Optional: without a key, tests share Google&apos;s small free quota and may be slow at busy times. Your own key is
                free (25,000 tests a day).
              </p>
              </div>
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
      </div>
    </>
  );
}
