import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, can, getAuditSchedule, getWebsite, isUuidLike, listAudits, listClients, listCwv, verificationInstructions } from "@sge/core";
import { ACTIVE_AUDIT, AuditStatus, scoreTone, Sparkline } from "@/components/audit-ui";
import { CwvTable } from "@/components/cwv-table";
import { LiveCrawl } from "@/components/live-crawl";
import { ActionForm, SubmitButton } from "@/components/form";
import { Alert, Card, Field, Input, LinkButton, PageHeader, Select } from "@/components/ui";
import { VerificationBadge } from "@/components/verification-badge";
import { db } from "@/lib/db";
import { currentActor, requireWorkspace } from "@/lib/session";
import { deleteWebsiteAction, updateWebsiteAction, verifyWebsiteAction } from "../actions";
import { requestCwvAction, setScheduleAction, startAuditAction } from "./audits/actions";

// Starting an audit processes the first batch right after the response (see lib/jobs).
export const maxDuration = 60;

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
  const [auditList, schedule, cwv] = await Promise.all([
    listAudits(db(), actor, access, w.id, 10),
    getAuditSchedule(db(), actor, access, w.id),
    listCwv(db(), actor, access, w.id, 6)
  ]);
  const auditActive = auditList.some((a) => ACTIVE_AUDIT.includes(a.status));
  const canRun = can(access.role, "work.run");
  const trend = auditList.filter((a) => a.status === "completed" && a.healthScore !== null).map((a) => a.healthScore!).reverse();
  const latestCompleted = auditList.find((a) => a.status === "completed");
  const cwvActive = cwv.some((c) => c.status === "queued");
  const lastCwvUrl = cwv[0]?.url;
  const latestCwv = lastCwvUrl ? cwv.filter((c) => c.url === lastCwvUrl && c.createdAt.getTime() === cwv[0]!.createdAt.getTime()) : [];
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
      <LiveCrawl url={`/api/w/${slug}/websites/${w.id}/cwv`} active={cwvActive} activeStatuses={["queued"]} />
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

        <Card>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-center gap-5">
              {latestCompleted && (
                <div className="text-center">
                  <div className={`text-4xl font-semibold tabular-nums ${scoreTone(latestCompleted.healthScore)}`}>{latestCompleted.healthScore ?? "–"}</div>
                  <div className="text-xs text-muted">Health</div>
                </div>
              )}
              <div>
                <h2 className="font-semibold">Technical SEO audit</h2>
                <p className="mt-1 max-w-xl text-sm text-muted">
                  Crawls the site like a search engine (respecting robots.txt) and checks 54 issues: broken pages and links, redirects, titles, meta
                  descriptions, headings, canonicals, indexability, duplicates, images, sitemaps, HTTPS and more.{" "}
                  {w.verificationStatus === "verified" ? "Up to 500 pages per audit." : "Unverified sites: up to 25 pages."}
                </p>
                {trend.length > 1 && (
                  <div className="mt-2 flex items-center gap-2 text-xs text-muted">
                    <Sparkline values={trend} label="Health score trend" /> last {trend.length} audits
                  </div>
                )}
              </div>
            </div>
            {canRun && !auditActive && (
              <ActionForm action={startAuditAction.bind(null, slug, w.id)}>
                <SubmitButton pending="Starting…">{auditList.length ? "Run new audit" : "Run first audit"}</SubmitButton>
              </ActionForm>
            )}
          </div>
          {auditList.length > 0 && (
            <ul className="mt-4 divide-y divide-border border-t border-border text-sm">
              {auditList.slice(0, 6).map((a) => (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                  <Link href={`/w/${slug}/websites/${w.id}/audits/${a.id}`} className="text-brand hover:underline">
                    {a.createdAt.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}
                    {a.trigger === "schedule" && <span className="ml-2 text-xs text-muted">scheduled</span>}
                  </Link>
                  <span className="flex items-center gap-4 text-muted">
                    {a.status === "completed" && (
                      <>
                        <span className={`font-semibold tabular-nums ${scoreTone(a.healthScore)}`}>{a.healthScore}</span>
                        <span className="hidden text-xs sm:inline">
                          <span className="text-danger">{a.critical} critical</span> · <span className="text-warning">{a.warning} warnings</span> · {a.pagesAnalyzed} pages
                        </span>
                      </>
                    )}
                    <AuditStatus status={a.status} />
                  </span>
                </li>
              ))}
            </ul>
          )}
          {manage && (
            <ActionForm action={setScheduleAction.bind(null, slug, w.id)} className="mt-4 flex flex-wrap items-end gap-3 border-t border-border pt-4">
              <Field label="Automatic audits" htmlFor="frequency">
                <Select id="frequency" name="frequency" defaultValue={schedule.frequency}>
                  <option value="off">Off</option>
                  <option value="weekly">Every week</option>
                  <option value="monthly">Every month</option>
                </Select>
              </Field>
              <SubmitButton variant="secondary" pending="Saving…">
                Save schedule
              </SubmitButton>
              {schedule.nextRunAt && (
                <span className="pb-2.5 text-xs text-muted">Next: {schedule.nextRunAt.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}</span>
              )}
            </ActionForm>
          )}
        </Card>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <h2 className="font-semibold">Core Web Vitals</h2>
            <p className="mt-1 text-sm text-muted">Speed and stability from Google PageSpeed Insights (lab test) and real-user data from the Chrome UX Report, when Google has enough traffic for the page.</p>
            {canRun && (
              <ActionForm action={requestCwvAction.bind(null, slug, w.id)} className="mt-4 flex flex-wrap items-end gap-3">
                <Field label="Page" htmlFor="cwv-page">
                  <Input id="cwv-page" name="page" defaultValue={lastCwvUrl ? new URL(lastCwvUrl).pathname : "/"} maxLength={2000} />
                </Field>
                {cwvActive ? (
                  <span className="pb-2.5 text-sm text-muted">Measuring…</span>
                ) : (
                  <SubmitButton variant="secondary" pending="Queuing…">
                    Measure
                  </SubmitButton>
                )}
              </ActionForm>
            )}
            {latestCwv.length > 0 && <CwvTable rows={latestCwv} />}
          </Card>

          <Card>
            <h2 className="font-semibold">On-page analysis</h2>
            <p className="mt-1 text-sm text-muted">
              Check how well a page targets its keyword: title, meta description, headings, keyword placement and density, content length, readability,
              internal links, images and schema, with a search-result preview.
            </p>
            <LinkButton href={`/w/${slug}/websites/${w.id}/onpage`} variant="secondary" className="mt-4">
              Analyse a page
            </LinkButton>
          </Card>
        </div>

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
