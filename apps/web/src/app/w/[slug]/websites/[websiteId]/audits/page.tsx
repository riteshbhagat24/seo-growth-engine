import Link from "next/link";
import { CalendarClock, Gauge, SearchCheck } from "lucide-react";
import { can, getAuditSchedule, getWebsite, listAudits, listCwv } from "@sge/core";
import { ACTIVE_AUDIT, AuditStatus, scoreTone, Sparkline } from "@/components/audit-ui";
import { CwvTable } from "@/components/cwv-table";
import { ActionForm, SubmitButton } from "@/components/form";
import { LiveCrawl } from "@/components/live-crawl";
import { Card, CardHeader, EmptyState, Field, Input, Kpi, Select } from "@/components/ui";
import { db } from "@/lib/db";
import { currentActor, requireWorkspace } from "@/lib/session";
import { requestCwvAction, setScheduleAction, startAuditAction } from "./actions";

export const maxDuration = 60;

export default async function AuditsPage({ params }: PageProps<"/w/[slug]/websites/[websiteId]/audits">) {
  const { slug, websiteId } = await params;
  const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
  const { website: w } = await getWebsite(db(), actor, access, websiteId);
  const [audits, schedule, cwv] = await Promise.all([
    listAudits(db(), actor, access, w.id, 20),
    getAuditSchedule(db(), actor, access, w.id),
    listCwv(db(), actor, access, w.id, 6)
  ]);
  const canRun = can(access.role, "work.run");
  const manage = can(access.role, "websites.manage");
  const running = audits.find((a) => ACTIVE_AUDIT.includes(a.status));
  const completed = audits.filter((a) => a.status === "completed");
  const latest = completed[0];
  const prev = completed[1];
  const trend = completed.filter((a) => a.healthScore !== null).map((a) => a.healthScore!).reverse();
  const base = `/w/${slug}/websites/${w.id}`;
  const cwvActive = cwv.some((c) => c.status === "queued");
  const lastCwvUrl = cwv[0]?.url;
  const latestCwv = lastCwvUrl ? cwv.filter((c) => c.url === lastCwvUrl && c.createdAt.getTime() === cwv[0]!.createdAt.getTime()) : [];

  const runButton =
    canRun && !running ? (
      <ActionForm action={startAuditAction.bind(null, slug, w.id)}>
        <SubmitButton pending="Starting…">{audits.length ? "Run new audit" : "Run first audit"}</SubmitButton>
      </ActionForm>
    ) : null;

  return (
    <div className="flex flex-col gap-6">
      <LiveCrawl url={`/api/w/${slug}/websites/${w.id}/cwv`} active={cwvActive} activeStatuses={["queued"]} />
      {audits.length === 0 ? (
        <EmptyState icon={<SearchCheck className="size-5" />} title="Run your first technical SEO audit" action={runButton}>
          We crawl the site like a search engine (respecting robots.txt) and check 54 issues: broken pages and links, redirects, titles, meta descriptions,
          headings, canonicals, indexability, duplicates, images, sitemaps and HTTPS. {w.verificationStatus === "verified" ? "Up to 500 pages." : "Unverified sites: up to 25 pages."}
        </EmptyState>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl border border-border bg-surface p-4 shadow-card">
              <div className="text-xs font-medium text-muted">Health score</div>
              <div className="mt-1 flex items-end justify-between gap-3">
                <span className={`text-3xl font-semibold tabular-nums ${scoreTone(latest?.healthScore ?? null)}`}>{latest?.healthScore ?? "–"}</span>
                <Sparkline values={trend} label="Health score trend" />
              </div>
            </div>
            <Kpi label="Critical issues" value={latest?.critical ?? "–"} foot={prev && latest ? `${prev.critical} in the previous audit` : undefined} />
            <Kpi label="Warnings" value={latest?.warning ?? "–"} foot={prev && latest ? `${prev.warning} in the previous audit` : undefined} />
            <Kpi label="Pages analysed" value={latest?.pagesAnalyzed ?? "–"} foot={w.verificationStatus === "verified" ? "Up to 500 per audit" : "Verify for up to 500"} />
          </div>

          <Card className="p-0 sm:p-0">
            <div className="p-5 pb-0 sm:p-6 sm:pb-0">
              <CardHeader title="Audits" description={running ? "An audit is running. Open it to watch progress." : "Newest first; the 10 most recent are kept."} actions={runButton} />
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-y border-border bg-surface-2 text-xs text-muted">
                  <tr>
                    <th className="px-6 py-2.5 font-medium">Started</th>
                    <th className="px-4 py-2.5 font-medium">Status</th>
                    <th className="px-4 py-2.5 text-right font-medium">Health</th>
                    <th className="px-4 py-2.5 text-right font-medium">Critical</th>
                    <th className="px-4 py-2.5 text-right font-medium">Warnings</th>
                    <th className="px-4 py-2.5 text-right font-medium">Notices</th>
                    <th className="px-6 py-2.5 text-right font-medium">Pages</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {audits.map((a) => (
                    <tr key={a.id} className="hover:bg-surface-2">
                      <td className="px-6 py-2.5">
                        <Link href={`${base}/audits/${a.id}`} className="font-medium text-brand hover:underline">
                          {a.createdAt.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}
                        </Link>
                        {a.trigger === "schedule" && <span className="ml-2 text-xs text-subtle">scheduled</span>}
                      </td>
                      <td className="px-4 py-2.5">
                        <AuditStatus status={a.status} />
                      </td>
                      <td className={`px-4 py-2.5 text-right font-semibold tabular-nums ${scoreTone(a.healthScore)}`}>{a.status === "completed" ? a.healthScore : "–"}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{a.status === "completed" ? a.critical : "–"}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{a.status === "completed" ? a.warning : "–"}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-muted">{a.status === "completed" ? a.notice : "–"}</td>
                      <td className="px-6 py-2.5 text-right tabular-nums text-muted">{a.status === "completed" ? a.pagesAnalyzed : "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_1.4fr]">
        <Card>
          <CardHeader icon={<CalendarClock className="size-4" />} title="Automatic audits" description="Re-audit on a schedule to catch new issues early." />
          {manage ? (
            <ActionForm action={setScheduleAction.bind(null, slug, w.id)} className="flex flex-wrap items-end gap-3">
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
            </ActionForm>
          ) : (
            <p className="text-sm text-muted">{schedule.frequency === "off" ? "Off" : `Runs ${schedule.frequency}.`}</p>
          )}
          {schedule.nextRunAt && <p className="mt-3 text-xs text-muted">Next: {schedule.nextRunAt.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}</p>}
        </Card>

        <Card>
          <CardHeader
            icon={<Gauge className="size-4" />}
            title="Core Web Vitals"
            description="Lab test from Google PageSpeed Insights plus real-user data (Chrome UX Report) when Google has enough traffic."
          />
          {canRun && (
            <ActionForm action={requestCwvAction.bind(null, slug, w.id)} className="flex flex-wrap items-end gap-3">
              <div className="min-w-48 flex-1">
                <Field label="Page" htmlFor="cwv-page">
                  <Input id="cwv-page" name="page" defaultValue={lastCwvUrl ? new URL(lastCwvUrl).pathname : "/"} maxLength={2000} />
                </Field>
              </div>
              {cwvActive ? (
                <span className="pb-2 text-sm text-muted">Measuring…</span>
              ) : (
                <SubmitButton variant="secondary" pending="Queuing…">
                  Measure
                </SubmitButton>
              )}
            </ActionForm>
          )}
          {latestCwv.length > 0 && <CwvTable rows={latestCwv} />}
        </Card>
      </div>
    </div>
  );
}
