import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, can, getAudit, isUuidLike } from "@sge/core";
import { CATEGORY_LABEL, RULES, type Category } from "@sge/seo-rules";
import { ACTIVE_AUDIT, AuditStatus, Delta, ScoreRing, SeverityBadge, Stat } from "@/components/audit-ui";
import { ActionForm, SubmitButton } from "@/components/form";
import { LiveCrawl } from "@/components/live-crawl";
import { Alert, Card, LinkButton, PageHeader } from "@/components/ui";
import { db } from "@/lib/db";
import { currentActor, requireWorkspace } from "@/lib/session";
import { cancelAuditAction } from "../actions";

export const maxDuration = 60;

const SEVERITIES = [
  { key: "all", label: "All issues" },
  { key: "critical", label: "Critical" },
  { key: "warning", label: "Warnings" },
  { key: "notice", label: "Notices" }
] as const;

export default async function AuditPage({ params, searchParams }: PageProps<"/w/[slug]/websites/[websiteId]/audits/[auditId]">) {
  const { slug, websiteId, auditId } = await params;
  const sp = await searchParams;
  if (!isUuidLike(websiteId) || !isUuidLike(auditId)) notFound();
  const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
  const d = await getAudit(db(), actor, access, auditId).catch((e) => {
    if (e instanceof AppError && e.code === "not_found") notFound();
    throw e;
  });
  const { audit: a, crawl, rules, previous, diff } = d;
  if (a.websiteId !== websiteId) notFound();

  const active = ACTIVE_AUDIT.includes(a.status);
  const base = `/w/${slug}/websites/${websiteId}/audits/${auditId}`;
  const severity = SEVERITIES.find((s) => s.key === sp.severity)?.key ?? "all";
  const category = typeof sp.category === "string" && sp.category in CATEGORY_LABEL ? (sp.category as Category) : null;
  const diffBy = new Map((diff ?? []).map((x) => [x.rule, x]));
  const shown = rules.filter((r) => (severity === "all" || r.severity === severity) && (!category || RULES[r.rule]?.category === category));
  const categories = [...new Set(rules.map((r) => RULES[r.rule]?.category).filter(Boolean))] as Category[];
  const fixed = (diff ?? []).filter((x) => x.before > 0 && x.after === 0);
  const host = new URL(crawl.startUrl).hostname;
  const qs = (o: { severity?: string; category?: string | null }) => {
    const p = new URLSearchParams();
    const s = o.severity ?? severity;
    const c = o.category === undefined ? category : o.category;
    if (s !== "all") p.set("severity", s);
    if (c) p.set("category", c);
    const q = p.toString();
    return q ? `${base}?${q}` : base;
  };

  return (
    <>
      <LiveCrawl url={`/api/w/${slug}/audits/${auditId}`} active={active} activeStatuses={ACTIVE_AUDIT} />
      <Link href={`/w/${slug}/websites/${websiteId}/audits`} className="text-sm text-muted hover:text-foreground">
        ← All audits
      </Link>
      <div className="mt-3">
        <PageHeader
          title={`Site audit: ${host}`}
          description={`${a.trigger === "schedule" ? "Scheduled audit" : "Started"} ${a.createdAt.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })} · up to ${crawl.maxPages} pages`}
          actions={<AuditStatus status={a.status} />}
        />
      </div>

      <div className="flex flex-col gap-6">
        {a.error && <Alert tone="error">{a.error}</Alert>}
        {crawl.maxPages <= 25 && <Alert>This website isn't verified yet, so audits cover up to {crawl.maxPages} pages. Verify ownership to audit up to 500.</Alert>}

        {active && (
          <Card>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h2 className="font-semibold">
                  {a.status === "crawling" ? "Crawling pages" : a.status === "checking_links" ? "Checking external links" : "Analysing results"}
                </h2>
                <p className="mt-1 text-sm text-muted">
                  {a.status === "crawling" && `${crawl.pagesFetched} of ${crawl.pagesFound} pages found so far.`}
                  {a.status === "checking_links" && `${a.externalLinksChecked} external links checked.`}
                  {a.status === "analyzing" && "Applying the audit rules."} This page updates automatically.
                </p>
              </div>
              {can(access.role, "work.run") && (
                <ActionForm action={cancelAuditAction.bind(null, slug, websiteId, auditId)} confirm="Stop this audit?">
                  <SubmitButton variant="secondary">Stop audit</SubmitButton>
                </ActionForm>
              )}
            </div>
            <ol className="mt-5 grid grid-cols-3 gap-2 text-xs" aria-label="Audit steps">
              {["crawling", "checking_links", "analyzing"].map((step, i) => {
                const idx = ACTIVE_AUDIT.indexOf(a.status);
                return (
                  <li key={step} className={`rounded-full px-3 py-1.5 text-center ${i < idx ? "bg-success/10 text-success" : i === idx ? "bg-brand text-brand-contrast" : "bg-background text-muted"}`}>
                    {["1. Crawl", "2. Links", "3. Analyse"][i]}
                  </li>
                );
              })}
            </ol>
          </Card>
        )}

        {a.status === "completed" && (
          <>
            <Card>
              <div className="flex flex-wrap items-center gap-8">
                <ScoreRing score={a.healthScore} label="Health score" />
                <dl className="grid flex-1 grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-4">
                  <Stat label="Pages analysed">{a.pagesAnalyzed}</Stat>
                  <Stat label="Critical">
                    <span className="text-danger">{a.critical}</span>
                  </Stat>
                  <Stat label="Warnings">
                    <span className="text-warning">{a.warning}</span>
                  </Stat>
                  <Stat label="Notices">{a.notice}</Stat>
                </dl>
              </div>
              {previous && (
                <p className="mt-5 border-t border-border pt-4 text-sm text-muted">
                  Since the{" "}
                  <Link className="text-brand hover:underline" href={`/w/${slug}/websites/${websiteId}/audits/${previous.id}`}>
                    previous audit
                  </Link>{" "}
                  ({previous.createdAt.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}): health{" "}
                  <Delta value={(a.healthScore ?? 0) - (previous.healthScore ?? 0)} />, critical <Delta value={a.critical - previous.critical} invert />,
                  warnings <Delta value={a.warning - previous.warning} invert />.
                  {fixed.length > 0 && ` ${fixed.length} issue type${fixed.length === 1 ? "" : "s"} fully fixed.`}
                </p>
              )}
              <div className="mt-5 flex flex-wrap gap-2">
                <a href={`/api/w/${slug}/audits/${auditId}/csv`} className="inline-flex h-10 items-center rounded-lg border border-border bg-surface px-4 text-sm font-medium hover:bg-surface-2">
                  Download issues (CSV)
                </a>
                <LinkButton variant="ghost" href={`/w/${slug}/websites/${websiteId}/crawls/${crawl.id}`}>
                  View crawled pages
                </LinkButton>
              </div>
            </Card>

            <Card className="p-0 sm:p-0">
              <div className="flex flex-col gap-3 border-b border-border px-4 py-3">
                <nav className="flex flex-wrap gap-1 text-sm" aria-label="Filter by severity">
                  {SEVERITIES.map((s) => (
                    <Link
                      key={s.key}
                      href={qs({ severity: s.key })}
                      aria-current={severity === s.key ? "page" : undefined}
                      className="rounded-lg px-3 py-1.5 text-muted hover:bg-surface-2 hover:text-foreground aria-[current=page]:bg-surface-2 aria-[current=page]:font-medium aria-[current=page]:text-foreground"
                    >
                      {s.label}
                    </Link>
                  ))}
                </nav>
                {categories.length > 1 && (
                  <nav className="flex flex-wrap gap-1 text-xs" aria-label="Filter by category">
                    <Link href={qs({ category: null })} aria-current={!category ? "page" : undefined} className="rounded-full border border-border px-2.5 py-1 text-muted aria-[current=page]:border-brand aria-[current=page]:text-brand">
                      All categories
                    </Link>
                    {categories.map((c) => (
                      <Link key={c} href={qs({ category: c })} aria-current={category === c ? "page" : undefined} className="rounded-full border border-border px-2.5 py-1 text-muted aria-[current=page]:border-brand aria-[current=page]:text-brand">
                        {CATEGORY_LABEL[c]}
                      </Link>
                    ))}
                  </nav>
                )}
              </div>
              {shown.length === 0 ? (
                <p className="p-6 text-sm text-muted">{rules.length === 0 ? "No issues found. Nice work!" : "No issues match this filter."}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="border-b border-border text-xs uppercase tracking-wider text-muted">
                      <tr>
                        <th className="px-6 py-3 font-medium">Issue</th>
                        <th className="px-6 py-3 font-medium">Category</th>
                        <th className="px-6 py-3 text-right font-medium">Affected</th>
                        {diff && <th className="px-6 py-3 text-right font-medium">Change</th>}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {shown.map((r) => {
                        const rule = RULES[r.rule];
                        const x = diffBy.get(r.rule);
                        return (
                          <tr key={r.rule}>
                            <td className="px-6 py-3">
                              <div className="flex items-center gap-3">
                                <SeverityBadge severity={r.severity} />
                                <Link href={`${base}/issues/${r.rule}`} className="font-medium text-foreground hover:text-brand hover:underline">
                                  {rule?.title ?? r.rule}
                                </Link>
                              </div>
                            </td>
                            <td className="px-6 py-3 text-muted">{rule ? CATEGORY_LABEL[rule.category] : ""}</td>
                            <td className="px-6 py-3 text-right tabular-nums">{rule?.scope === "site" ? "Site-wide" : r.count}</td>
                            {diff && (
                              <td className="px-6 py-3 text-right text-xs tabular-nums">
                                {x && x.added > 0 && <span className="text-danger">+{x.added} new</span>}
                                {x && x.added > 0 && x.fixed > 0 && " · "}
                                {x && x.fixed > 0 && <span className="text-success">{x.fixed} fixed</span>}
                                {(!x || (x.added === 0 && x.fixed === 0)) && <span className="text-muted">—</span>}
                              </td>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            {fixed.length > 0 && (
              <Card>
                <h2 className="font-semibold">Fixed since the previous audit</h2>
                <ul className="mt-3 flex flex-col gap-2 text-sm">
                  {fixed.map((x) => (
                    <li key={x.rule} className="flex items-center gap-3">
                      <span className="text-success" aria-hidden>
                        ✓
                      </span>
                      {RULES[x.rule]?.title ?? x.rule}
                      <span className="text-muted">({x.before} before)</span>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </>
        )}
      </div>
    </>
  );
}
