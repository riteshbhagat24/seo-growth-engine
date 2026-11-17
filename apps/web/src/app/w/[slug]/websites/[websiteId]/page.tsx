import Link from "next/link";
import { ArrowRight, ListChecks } from "lucide-react";
import {
  can,
  getAudit,
  getGoogleConnection,
  getWebsite,
  getWebsiteGoogle,
  listAudits,
  listKeywords,
  searchPerformance,
  trafficOverview
} from "@sge/core";
import { RULES } from "@sge/seo-rules";
import { ACTIVE_AUDIT, scoreTone, SeverityBadge } from "@/components/audit-ui";
import { TimeSeriesChart } from "@/components/charts";
import { Step } from "@/components/data-ui";
import { ActionForm, SubmitButton } from "@/components/form";
import { Card, CardHeader, Change, fmtCompact, fmtInt, fmtPos, Kpi, LinkButton } from "@/components/ui";
import { db } from "@/lib/db";
import { currentActor, requireWorkspace } from "@/lib/session";
import { startAuditAction } from "./audits/actions";

// Starting an audit processes the first batch right after the response (see lib/jobs).
export const maxDuration = 60;

export default async function WebsiteOverview({ params }: PageProps<"/w/[slug]/websites/[websiteId]">) {
  const { slug, websiteId } = await params;
  const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
  const { website: w } = await getWebsite(db(), actor, access, websiteId);
  const base = `/w/${slug}/websites/${w.id}`;
  const [audits, linked, google, search, traffic, kw] = await Promise.all([
    listAudits(db(), actor, access, w.id, 10),
    getWebsiteGoogle(db(), actor, access, w.id),
    getGoogleConnection(db(), actor, access),
    searchPerformance(db(), actor, access, w.id, "28d"),
    trafficOverview(db(), actor, access, w.id, "28d"),
    listKeywords(db(), actor, access, w.id)
  ]);
  const latest = audits.find((a) => a.status === "completed");
  const prevAudit = audits.filter((a) => a.status === "completed")[1];
  const running = audits.some((a) => ACTIVE_AUDIT.includes(a.status));
  const detail = latest ? await getAudit(db(), actor, access, latest.id) : null;
  const topIssues = detail?.rules.filter((r) => r.severity !== "notice").slice(0, 6) ?? [];
  const manage = can(access.role, "websites.manage");
  const canRun = can(access.role, "work.run");

  const steps = [
    {
      done: w.verificationStatus === "verified",
      title: "Verify ownership",
      body: "Unlocks full 500-page audits. Use DNS, a meta tag, a file, or Search Console.",
      action: manage ? <LinkButton variant="secondary" href={`${base}/settings#verification`}>Verify</LinkButton> : null
    },
    {
      done: Boolean(linked?.gscProperty),
      title: "Link Google Search Console",
      body: google.connected ? "Choose this site's Search Console and Analytics properties." : "Connect Google for clicks, queries and positions (free).",
      action: manage ? <LinkButton variant="secondary" href={`${base}/settings#google`}>Link</LinkButton> : null
    },
    {
      done: Boolean(latest),
      title: "Run a technical audit",
      body: "Find broken pages, redirects, missing tags and more.",
      action:
        canRun && !running ? (
          <ActionForm action={startAuditAction.bind(null, slug, w.id)}>
            <SubmitButton variant="secondary" pending="Starting…">
              Run audit
            </SubmitButton>
          </ActionForm>
        ) : null
    },
    {
      done: kw.rows.length > 0,
      title: "Track your keywords",
      body: "Follow positions and clicks for the searches that matter.",
      action: canRun ? <LinkButton variant="secondary" href={`${base}/keywords`}>Add</LinkButton> : null
    }
  ];
  const remaining = steps.filter((s) => !s.done).length;
  const topKw = [...kw.rows].filter((k) => k.impressions > 0).sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions).slice(0, 6);

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Kpi
          label="Health score"
          href={latest ? `${base}/audits/${latest.id}` : `${base}/audits`}
          value={<span className={scoreTone(latest?.healthScore ?? null)}>{latest?.healthScore ?? "–"}</span>}
          change={latest && prevAudit ? <Change current={latest.healthScore ?? 0} previous={prevAudit.healthScore} format="abs" /> : undefined}
          foot={latest ? `${latest.critical} critical · ${latest.warning} warnings` : running ? "Audit running…" : "No audit yet"}
        />
        <Kpi
          label="Clicks · 28 days"
          href={`${base}/search`}
          value={search.hasData ? fmtCompact(search.totals.clicks) : "–"}
          change={search.hasData ? <Change current={search.totals.clicks} previous={search.previous?.clicks} /> : undefined}
          foot={search.hasData ? `${fmtCompact(search.totals.impressions)} impressions` : "Search Console not linked"}
        />
        <Kpi
          label="Avg position"
          href={`${base}/search`}
          value={search.hasData ? fmtPos(search.totals.position) : "–"}
          change={search.previous ? <Change current={search.totals.position} previous={search.previous.position} invert format="abs" /> : undefined}
          foot="Lower is better"
        />
        <Kpi
          label="Sessions · 28 days"
          href={`${base}/traffic`}
          value={traffic.hasData ? fmtCompact(traffic.totals.sessions) : "–"}
          change={traffic.hasData ? <Change current={traffic.totals.sessions} previous={traffic.previous?.sessions} /> : undefined}
          foot={traffic.hasData ? `${fmtCompact(traffic.totals.keyEvents)} key events` : "Analytics not linked"}
        />
        <Kpi label="Keywords tracked" href={`${base}/keywords`} value={fmtInt(kw.rows.length)} foot={`${kw.rows.filter((k) => k.position !== null && k.position <= 10).length} on page 1`} />
      </div>

      {remaining > 0 && (
        <Card>
          <CardHeader icon={<ListChecks className="size-4" />} title="Set up this website" description={`${steps.length - remaining} of ${steps.length} done`} />
          <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden>
            <div className="h-full rounded-full bg-success" style={{ width: `${((steps.length - remaining) / steps.length) * 100}%` }} />
          </div>
          <ol className="divide-y divide-border">
            {steps.map((s) => (
              <Step key={s.title} done={s.done} title={s.title} action={s.action}>
                {s.body}
              </Step>
            ))}
          </ol>
        </Card>
      )}

      {search.hasData && (
        <Card>
          <CardHeader
            title="Clicks from Google"
            description="Last 28 days of Search Console data."
            actions={
              <Link href={`${base}/search`} className="inline-flex items-center gap-1 text-sm text-brand hover:underline">
                Search performance <ArrowRight className="size-3.5" aria-hidden />
              </Link>
            }
          />
          <TimeSeriesChart data={search.series.map((d) => ({ x: d.date, y: d.clicks }))} label="Clicks" height={200} />
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Top issues"
            description={latest ? `From the audit on ${latest.createdAt.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : "Run an audit to see issues."}
            actions={
              latest ? (
                <Link href={`${base}/audits/${latest.id}`} className="inline-flex items-center gap-1 text-sm text-brand hover:underline">
                  All issues <ArrowRight className="size-3.5" aria-hidden />
                </Link>
              ) : null
            }
          />
          {topIssues.length ? (
            <ul className="divide-y divide-border text-sm">
              {topIssues.map((r) => (
                <li key={r.rule} className="flex items-center gap-3 py-2">
                  <SeverityBadge severity={r.severity} />
                  <Link href={`${base}/audits/${latest!.id}/issues/${r.rule}`} className="min-w-0 flex-1 truncate hover:text-brand hover:underline">
                    {RULES[r.rule]?.title ?? r.rule}
                  </Link>
                  <span className="tabular-nums text-muted">{RULES[r.rule]?.scope === "site" ? "site" : r.count}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">{latest ? "No critical issues or warnings." : "No audit yet."}</p>
          )}
        </Card>
        <Card>
          <CardHeader
            title="Top keywords"
            description={kw.period ? "By clicks, last 28 days" : "Tracked keywords with Search Console data appear here."}
            actions={
              <Link href={`${base}/keywords`} className="inline-flex items-center gap-1 text-sm text-brand hover:underline">
                Keywords <ArrowRight className="size-3.5" aria-hidden />
              </Link>
            }
          />
          {topKw.length ? (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="pb-2 font-medium">Keyword</th>
                  <th className="pb-2 text-right font-medium">Position</th>
                  <th className="pb-2 text-right font-medium">Clicks</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {topKw.map((k) => (
                  <tr key={k.id}>
                    <td className="max-w-[240px] truncate py-2">
                      <Link href={`${base}/keywords/${k.id}`} className="hover:text-brand hover:underline">
                        {k.keyword}
                      </Link>
                    </td>
                    <td className="py-2 text-right tabular-nums">{fmtPos(k.position)}</td>
                    <td className="py-2 text-right tabular-nums">{fmtInt(k.clicks)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm text-muted">{kw.rows.length ? "No Search Console data for tracked keywords yet." : "No keywords tracked yet."}</p>
          )}
        </Card>
      </div>
    </div>
  );
}
