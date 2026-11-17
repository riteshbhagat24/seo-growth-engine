import Link from "next/link";
import { notFound } from "next/navigation";
import { BarChart3, Globe2, ShieldCheck, Trash2, Wrench } from "lucide-react";
import {
  can,
  getGoogleConnection,
  getWebsite,
  getWebsiteGoogle,
  isAppError,
  listClients,
  listGoogleProperties,
  verificationInstructions,
  type PropertyChoices
} from "@sge/core";
import { ActionForm, SubmitButton } from "@/components/form";
import { Alert, Badge, Card, CardHeader, Field, fmtDate, Input, LinkButton, Select } from "@/components/ui";
import { db } from "@/lib/db";
import { currentActor, requireWorkspace } from "@/lib/session";
import { deleteWebsiteAction, updateWebsiteAction, verifyWebsiteAction } from "../../actions";
import { setPropertiesAction, syncNowAction } from "./actions";

export const maxDuration = 60;

function Code({ children }: { children: string }) {
  return <code className="block overflow-x-auto whitespace-pre rounded-lg border border-border bg-surface-2 px-3 py-2 font-mono text-xs">{children}</code>;
}

const METHOD_LABEL: Record<string, string> = { dns_txt: "DNS TXT record", meta_tag: "HTML meta tag", html_file: "HTML file", gsc: "Google Search Console" };

export default async function WebsiteSettings({ params }: PageProps<"/w/[slug]/websites/[websiteId]/settings">) {
  const { slug, websiteId } = await params;
  const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
  if (!can(access.role, "websites.manage")) notFound();
  const { website: w } = await getWebsite(db(), actor, access, websiteId);
  const isAgency = access.workspace.type === "agency";
  const [clients, google, linked] = await Promise.all([
    isAgency ? listClients(db(), actor, access) : Promise.resolve([]),
    getGoogleConnection(db(), actor, access),
    getWebsiteGoogle(db(), actor, access, w.id)
  ]);
  let choices: PropertyChoices | null = null;
  let choicesError: string | null = null;
  if (google.connected) {
    try {
      choices = await listGoogleProperties(db(), actor, access, w.id);
    } catch (e) {
      choicesError = isAppError(e) ? e.message : "Couldn't load your Google properties. Try again in a moment.";
    }
  }
  const ins = verificationInstructions(w);
  const verify = verifyWebsiteAction.bind(null, slug, w.id);
  const canIntegrations = can(access.role, "integrations.manage");

  const methods = [
    {
      id: "dns_txt",
      title: "DNS TXT record",
      button: "Check DNS record",
      hint: "Best if you manage the domain's DNS. Covers every page and subdomain.",
      steps: (
        <>
          <p>At your DNS provider, add a TXT record on {ins.dnsTxt.host} (often written as @) with the value:</p>
          <Code>{ins.dnsTxt.value}</Code>
          <p className="text-xs text-muted">DNS changes can take minutes to hours to appear.</p>
        </>
      )
    },
    {
      id: "meta_tag",
      title: "HTML meta tag",
      button: "Check meta tag",
      hint: "Paste one line into your homepage's <head>. Easy with WordPress SEO plugins.",
      steps: (
        <>
          <p>Add this inside the &lt;head&gt; of {w.url}/:</p>
          <Code>{ins.metaTag}</Code>
        </>
      )
    },
    {
      id: "html_file",
      title: "HTML file upload",
      button: "Check file",
      hint: "Upload a small file to your site's root folder (e.g. cPanel File Manager).",
      steps: (
        <>
          <p>Create a file so this URL works:</p>
          <Code>{ins.htmlFile.url}</Code>
          <p>with exactly this content:</p>
          <Code>{ins.htmlFile.content}</Code>
        </>
      )
    }
  ] as const;

  return (
    <div className="flex flex-col gap-6">
      <Card id="verification">
        <CardHeader
          icon={<ShieldCheck className="size-4" />}
          title="Ownership"
          description="Verified websites get full audits (500 pages), and later outreach and submissions."
          actions={w.verificationStatus === "verified" ? <Badge tone="success">✓ Verified</Badge> : <Badge>Not verified</Badge>}
        />
        {w.verificationStatus === "verified" ? (
          <p className="text-sm text-muted">
            Verified by {METHOD_LABEL[w.verificationMethod ?? ""] ?? "—"}
            {w.verifiedAt ? ` on ${fmtDate(w.verifiedAt)}` : ""}. Ownership is re-checked weekly; keep the record, tag, file or Search Console access in place.
            {w.lastVerificationError && <span className="mt-2 block text-warning">{w.lastVerificationError}</span>}
          </p>
        ) : (
          <>
            {w.lastVerificationError && (
              <div className="mb-4">
                <Alert tone="error">Last check: {w.lastVerificationError}</Alert>
              </div>
            )}
            <p className="mb-4 text-sm text-muted">
              Use any one method below, or link a Search Console property you own in <a href="#google" className="text-brand hover:underline">Google data</a>.
            </p>
            <div className="grid gap-4 lg:grid-cols-3">
              {methods.map((m) => (
                <div key={m.id} className="flex flex-col gap-3 rounded-xl border border-border bg-surface-2 p-4 text-sm">
                  <div>
                    <h3 className="font-semibold">{m.title}</h3>
                    <p className="mt-1 text-xs text-muted">{m.hint}</p>
                  </div>
                  <div className="flex flex-1 flex-col gap-2">{m.steps}</div>
                  <ActionForm action={verify}>
                    <input type="hidden" name="method" value={m.id} />
                    <SubmitButton variant="secondary" pending="Checking…" className="w-full">
                      {m.button}
                    </SubmitButton>
                  </ActionForm>
                </div>
              ))}
            </div>
          </>
        )}
      </Card>

      <Card id="google">
        <CardHeader
          icon={<BarChart3 className="size-4" />}
          title="Google data"
          description="Link this website to Search Console (clicks, impressions, queries, positions) and Google Analytics 4 (sessions, sources, key events). Read-only; free."
          actions={
            google.connected && linked && (linked.gscProperty || linked.ga4Property) ? (
              <ActionForm action={syncNowAction.bind(null, slug, w.id)}>
                <SubmitButton variant="secondary" pending="Starting…">
                  Sync now
                </SubmitButton>
              </ActionForm>
            ) : null
          }
        />
        {!google.configured ? (
          <Alert>Google isn&apos;t set up on this platform yet. The platform administrator needs to add a Google OAuth client.</Alert>
        ) : !google.connected ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-border-strong bg-surface-2 p-4 text-sm">
            <span className="text-muted">
              {google.status === "expired" ? "Google access expired or was revoked. Reconnect to resume syncing." : "Connect a Google account for this workspace first."}
            </span>
            {canIntegrations ? (
              <LinkButton href={`/api/integrations/google/start?w=${slug}&next=${encodeURIComponent(`/w/${slug}/websites/${w.id}/settings#google`)}`} prefetch={false}>
                Connect Google
              </LinkButton>
            ) : (
              <span className="text-muted">Ask a workspace owner or admin to connect Google.</span>
            )}
          </div>
        ) : choicesError ? (
          <Alert tone="error">{choicesError}</Alert>
        ) : (
          <>
            <ActionForm action={setPropertiesAction.bind(null, slug, w.id)} className="grid gap-4 md:grid-cols-[1fr_1fr_auto] md:items-end">
              <Field label="Search Console property" htmlFor="gsc" hint={choices?.gscError ?? `Properties for ${w.domain} are listed first.`}>
                <Select id="gsc" name="gsc" defaultValue={linked?.gscProperty ?? ""} className="w-full">
                  <option value="">Not linked</option>
                  {choices?.gsc.map((s) => (
                    <option key={s.siteUrl} value={s.siteUrl} disabled={!s.matches}>
                      {s.siteUrl}
                      {s.matches ? "" : " (different domain)"}
                      {s.permissionLevel === "siteOwner" ? " · owner" : ""}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Analytics 4 property" htmlFor="ga4" hint={choices?.ga4Error ?? undefined}>
                <Select id="ga4" name="ga4" defaultValue={linked?.ga4Property ?? ""} className="w-full">
                  <option value="">Not linked</option>
                  {choices?.ga4.map((p) => (
                    <option key={p.property} value={p.property}>
                      {p.displayName} ({p.account})
                    </option>
                  ))}
                </Select>
              </Field>
              <SubmitButton pending="Saving…">Save</SubmitButton>
            </ActionForm>
            <p className="mt-3 text-xs text-subtle">Connected as {google.email ?? "a Google account"}.</p>
          </>
        )}
        {linked && (linked.gscProperty || linked.ga4Property) && (
          <dl className="mt-5 grid gap-3 border-t border-border pt-4 text-sm sm:grid-cols-2">
            {linked.gscProperty && (
              <div>
                <dt className="font-medium">Search Console</dt>
                <dd className="text-muted">
                  {linked.gscSyncedFrom && linked.gscSyncedThrough ? `Data ${fmtDate(linked.gscSyncedFrom)} – ${fmtDate(linked.gscSyncedThrough)}` : "Waiting for the first import"}
                  {linked.gscLastSyncAt && ` · synced ${linked.gscLastSyncAt.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}`}
                  {linked.gscError && <span className="block text-danger">{linked.gscError}</span>}
                </dd>
              </div>
            )}
            {linked.ga4Property && (
              <div>
                <dt className="font-medium">Analytics 4 · {linked.ga4PropertyName ?? linked.ga4Property}</dt>
                <dd className="text-muted">
                  {linked.ga4SyncedFrom && linked.ga4SyncedThrough ? `Data ${fmtDate(linked.ga4SyncedFrom)} – ${fmtDate(linked.ga4SyncedThrough)}` : "Waiting for the first import"}
                  {linked.ga4LastSyncAt && ` · synced ${linked.ga4LastSyncAt.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}`}
                  {linked.ga4Error && <span className="block text-danger">{linked.ga4Error}</span>}
                </dd>
              </div>
            )}
          </dl>
        )}
      </Card>

      <Card>
        <CardHeader icon={<Wrench className="size-4" />} title="Details" />
        <ActionForm action={updateWebsiteAction.bind(null, slug, w.id)} className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <Field label="Display name" htmlFor="displayName">
            <Input id="displayName" name="displayName" defaultValue={w.displayName ?? ""} maxLength={120} placeholder={w.domain} />
          </Field>
          {isAgency ? (
            <Field label="Client" htmlFor="clientId">
              <Select id="clientId" name="clientId" defaultValue={w.clientId ?? ""} className="w-full">
                {access.allClients && <option value="">No client (agency site)</option>}
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <span className="hidden sm:block" />
          )}
          <SubmitButton pending="Saving…">Save</SubmitButton>
        </ActionForm>
      </Card>

      <Card className="border-danger/30">
        <CardHeader icon={<Trash2 className="size-4" />} title="Remove website" description="Removes the website with its audits, keywords and imported Google data from this workspace." />
        <ActionForm action={deleteWebsiteAction.bind(null, slug, w.id)} confirm={`Remove ${w.domain} and all its data from this workspace?`}>
          <SubmitButton variant="danger">Remove {w.domain}</SubmitButton>
        </ActionForm>
      </Card>
      <p className="text-xs text-subtle">
        <Globe2 className="mr-1 inline size-3.5" aria-hidden />
        Need the raw crawl? Open an audit in <Link href={`/w/${slug}/websites/${w.id}/audits`} className="text-brand hover:underline">Site audit</Link>.
      </p>
    </div>
  );
}
