import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, can, getWebsite, isUuidLike, listClients, verificationInstructions } from "@sge/core";
import { ActionForm, SubmitButton } from "@/components/form";
import { Alert, Card, Field, Input, PageHeader, Select } from "@/components/ui";
import { VerificationBadge } from "@/components/verification-badge";
import { db } from "@/lib/db";
import { currentActor, requireWorkspace } from "@/lib/session";
import { deleteWebsiteAction, updateWebsiteAction, verifyWebsiteAction } from "../actions";

function Code({ children }: { children: string }) {
  return (
    <code className="block overflow-x-auto whitespace-pre rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs">
      {children}
    </code>
  );
}

export default async function WebsitePage({ params }: PageProps<"/w/[slug]/websites/[websiteId]">) {
  const { slug, websiteId } = await params;
  if (!isUuidLike(websiteId)) notFound();
  const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
  const found = await getWebsite(db(), actor, access, websiteId).catch((e) => {
    if (e instanceof AppError && e.code === "not_found") notFound();
    throw e;
  });
  const { website: w, client } = found;
  const manage = can(access.role, "websites.manage");
  const isAgency = access.workspace.type === "agency";
  const clients = manage && isAgency ? await listClients(db(), actor, access) : [];
  const ins = verificationInstructions(w);
  const verify = verifyWebsiteAction.bind(null, slug, w.id);

  const methods = [
    {
      id: "dns_txt",
      title: "DNS TXT record",
      button: "Check DNS record",
      hint: "Best if you manage the domain's DNS. Works for every page and subdomain.",
      steps: (
        <>
          <p>At your domain registrar or DNS provider, add a TXT record:</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-muted">Host / Name</dt>
            <dd className="font-mono text-xs">@ ({ins.dnsTxt.host})</dd>
            <dt className="text-muted">Value</dt>
            <dd />
          </dl>
          <Code>{ins.dnsTxt.value}</Code>
          <p className="text-muted">DNS changes can take a few minutes to a few hours to appear.</p>
        </>
      )
    },
    {
      id: "meta_tag",
      title: "HTML meta tag",
      button: "Check meta tag",
      hint: "Paste one line into your homepage's <head>. Easy with WordPress SEO plugins and most site builders.",
      steps: (
        <>
          <p>
            Add this inside the <code>&lt;head&gt;</code> of <span className="font-mono text-xs">{w.url}/</span>:
          </p>
          <Code>{ins.metaTag}</Code>
        </>
      )
    },
    {
      id: "html_file",
      title: "HTML file upload",
      button: "Check file",
      hint: "Upload a small file to your site's root folder (e.g. via cPanel File Manager).",
      steps: (
        <>
          <p>Create a file so that this URL works:</p>
          <Code>{ins.htmlFile.url}</Code>
          <p>with exactly this content:</p>
          <Code>{ins.htmlFile.content}</Code>
        </>
      )
    }
  ] as const;

  return (
    <>
      <Link href={`/w/${slug}/websites`} className="text-sm text-muted hover:text-foreground">
        ← Websites
      </Link>
      <div className="mt-3">
        <PageHeader
          title={w.displayName ?? w.domain}
          description={`${w.url}${client ? ` · ${client.name}` : ""}`}
          actions={<VerificationBadge status={w.verificationStatus} />}
        />
      </div>

      <div className="flex flex-col gap-6">
        {w.verificationStatus === "verified" ? (
          <Alert tone="success">
            Ownership verified{w.verificationMethod ? ` by ${methods.find((m) => m.id === w.verificationMethod)?.title}` : ""}
            {w.verifiedAt ? ` on ${w.verifiedAt.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}` : ""}. Keep
            the record, tag or file in place: ownership is re-checked periodically.
          </Alert>
        ) : manage ? (
          <Card>
            <h2 className="font-semibold">Verify ownership</h2>
            <p className="mt-1 mb-5 text-sm text-muted">
              Prove you control {w.domain} using any one method. It's free and takes a couple of minutes.
            </p>
            {w.lastVerificationError && (
              <div className="mb-5">
                <Alert tone="error">Last check: {w.lastVerificationError}</Alert>
              </div>
            )}
            <div className="grid gap-4 lg:grid-cols-3">
              {methods.map((m) => (
                <div key={m.id} className="flex flex-col gap-3 rounded-xl border border-border p-4 text-sm">
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
          </Card>
        ) : (
          <Alert>This website hasn't been verified yet.</Alert>
        )}

        {manage && (
          <Card>
            <h2 className="mb-4 font-semibold">Details</h2>
            <ActionForm action={updateWebsiteAction.bind(null, slug, w.id)} className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
              <Field label="Display name" htmlFor="displayName">
                <Input id="displayName" name="displayName" defaultValue={w.displayName ?? ""} maxLength={120} placeholder={w.domain} />
              </Field>
              {isAgency ? (
                <Field label="Client" htmlFor="clientId">
                  <Select id="clientId" name="clientId" defaultValue={w.clientId ?? ""}>
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
        )}

        {manage && (
          <Card>
            <h2 className="font-semibold">Remove website</h2>
            <p className="mt-1 mb-4 text-sm text-muted">Removes the website and its verification from this workspace.</p>
            <ActionForm action={deleteWebsiteAction.bind(null, slug, w.id)} confirm={`Remove ${w.domain} from this workspace?`}>
              <SubmitButton variant="danger">Remove {w.domain}</SubmitButton>
            </ActionForm>
          </Card>
        )}
      </div>
    </>
  );
}
