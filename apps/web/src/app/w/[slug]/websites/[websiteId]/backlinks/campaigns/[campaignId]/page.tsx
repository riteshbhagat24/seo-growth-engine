import Link from "next/link";
import { notFound } from "next/navigation";
import { Search, Upload } from "lucide-react";
import { campaignDetail } from "@sge/backlinks";
import { AppError, can, isUuidLike } from "@sge/core";
import { ActionForm, SubmitButton } from "@/components/form";
import { Badge, Card, CardHeader, EmptyState, Field, fmtInt, Input, Kpi, PageHeader, Select, Textarea } from "@/components/ui";
import { db } from "@/lib/db";
import { currentActor, requireWorkspace } from "@/lib/session";
import { importAction, pauseCampaignAction, resumeCampaignAction } from "../../actions";
import { fmtWhen, SafeLink, StatusBadge } from "../../ui";

export default async function CampaignPage({ params }: PageProps<"/w/[slug]/websites/[websiteId]/backlinks/campaigns/[campaignId]">) {
  const { slug, websiteId, campaignId } = await params;
  if (!isUuidLike(campaignId)) notFound();
  const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
  const d = await campaignDetail(db(), actor, access, campaignId).catch((e) => {
    if (e instanceof AppError && e.code === "not_found") notFound();
    throw e;
  });
  const c = d.campaign;
  const base = `/w/${slug}/websites/${websiteId}/backlinks`;
  const canRun = can(access.role, "work.run");
  const f = d.metrics.funnel;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={
          <Link href={base} className="hover:text-foreground">
            Campaigns
          </Link>
        }
        title={c.name}
        description={`Min score ${c.min_quality_score} · up to ${c.max_daily_submissions}/day, ${c.max_weekly_submissions}/week · ${c.approval_required ? "approval required" : "approval per website mode"}`}
        actions={
          <>
            <StatusBadge status={c.status} />
            {canRun && c.status === "active" && (
              <ActionForm compact action={pauseCampaignAction.bind(null, slug, websiteId, campaignId)}>
                <SubmitButton variant="secondary" size="sm">
                  Pause
                </SubmitButton>
              </ActionForm>
            )}
            {canRun && c.status === "paused" && (
              <ActionForm compact action={resumeCampaignAction.bind(null, slug, websiteId, campaignId)}>
                <SubmitButton size="sm">Resume</SubmitButton>
              </ActionForm>
            )}
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Discovered" value={fmtInt(f.opportunities_discovered)} foot={`${fmtInt(f.opportunities_qualified)} qualified · ${fmtInt(f.opportunities_rejected)} rejected`} />
        <Kpi label="Submitted" value={fmtInt(f.successful_submissions)} foot={`${fmtInt(f.submission_attempts)} attempts`} />
        <Kpi label="Verified" value={fmtInt(f.verified_live_now)} foot={`${fmtInt(d.metrics.link_attributes.dofollow)} followed · ${fmtInt(d.metrics.link_attributes.nofollow)} nofollow`} />
        <Kpi label="Needs a person" value={fmtInt(f.manual_action_required + f.awaiting_approval)} foot={`${f.awaiting_approval} awaiting approval`} />
      </div>

      <Card className="p-0 sm:p-0">
        <div className="p-6 pb-3">
          <CardHeader title="Submissions" description="Only a link our crawler has found live counts as acquired." />
        </div>
        {d.submissions.length === 0 ? (
          <p className="px-6 pb-6 text-sm text-muted">No submissions yet. Qualified opportunities are prepared at the next planning run.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-y border-border text-xs uppercase tracking-wider text-muted">
                <tr>
                  <th className="px-6 py-3 font-medium">Destination</th>
                  <th className="px-6 py-3 font-medium">Method</th>
                  <th className="px-6 py-3 font-medium">Status</th>
                  <th className="px-6 py-3 font-medium">Live URL</th>
                  <th className="px-6 py-3 font-medium">Updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {d.submissions.map((s) => (
                  <tr key={s.id}>
                    <td className="px-6 py-3">
                      <Link href={`${base}/submissions/${s.id}`} className="font-medium text-brand hover:underline">
                        {s.destination_domain}
                      </Link>
                    </td>
                    <td className="px-6 py-3 text-muted">{s.adapter_key}</td>
                    <td className="px-6 py-3">
                      <StatusBadge status={s.status} />
                    </td>
                    <td className="max-w-[280px] truncate px-6 py-3">
                      <SafeLink href={s.live_url} />
                    </td>
                    <td className="px-6 py-3 text-muted">{fmtWhen(s.verified_at ?? s.submitted_at ?? s.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="p-0 sm:p-0">
        <div className="p-6 pb-3">
          <CardHeader title="Opportunities" description="Scored 0–100 from what our crawler saw on each site, with a reason for every factor. Third-party DA/DR scores are not used." />
        </div>
        {d.opportunities.length === 0 ? (
          <div className="px-6 pb-6">
            <EmptyState title="Nothing discovered yet">Discovery runs in the background; add URLs or a CSV export below.</EmptyState>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-y border-border text-xs uppercase tracking-wider text-muted">
                <tr>
                  <th className="px-6 py-3 font-medium">Page</th>
                  <th className="px-6 py-3 font-medium">Type</th>
                  <th className="px-6 py-3 font-medium">Found via</th>
                  <th className="px-6 py-3 text-right font-medium">Score</th>
                  <th className="px-6 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {d.opportunities.map((o) => (
                  <tr key={o.id} className="align-top">
                    <td className="max-w-[340px] px-6 py-3">
                      <div className="font-medium">{o.domain}</div>
                      <div className="truncate text-xs">
                        <SafeLink href={o.url} />
                      </div>
                    </td>
                    <td className="px-6 py-3 text-muted">{String(o.opportunity_type).replace(/_/g, " ")}</td>
                    <td className="px-6 py-3 text-xs text-muted">{String(o.discovery_method).replace(/_/g, " ")}</td>
                    <td className="px-6 py-3 text-right tabular-nums">
                      {o.score ?? "—"}
                      {o.score_breakdown.length > 0 && (
                        <details className="mt-1 text-left">
                          <summary className="cursor-pointer text-xs text-brand">Why</summary>
                          <ul className="mt-1 w-72 space-y-1 text-xs text-muted">
                            {o.score_breakdown.map((x) => (
                              <li key={x.factor}>
                                <span className="font-medium text-foreground">
                                  {x.factor.replace(/_/g, " ")} {x.points}/{x.max}
                                </span>{" "}
                                — {x.reason}
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </td>
                    <td className="px-6 py-3">
                      <StatusBadge status={o.status} />
                      {o.reject_reasons.length > 0 && <div className="mt-1 max-w-[260px] text-xs text-muted">{o.reject_reasons[0]}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {canRun && (
          <Card>
            <CardHeader icon={<Upload className="size-4" />} title="Add opportunities" description="Paste URLs, or upload a CSV: a list of URLs, or a competitor backlink export (Ahrefs, Semrush, Moz, Search Console)." />
            <ActionForm action={importAction.bind(null, slug, websiteId, campaignId)} className="flex flex-col gap-3">
              <Field label="URLs" htmlFor="urls" hint="One per line">
                <Textarea id="urls" name="urls" rows={3} />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="CSV file" htmlFor="file" hint="Up to 2 MB">
                  <Input id="file" name="file" type="file" accept=".csv,.tsv,text/csv,text/plain" />
                </Field>
                <Field label="CSV type" htmlFor="kind">
                  <Select id="kind" name="kind" defaultValue="generic">
                    <option value="generic">List of URLs</option>
                    <option value="competitor">Competitor backlinks</option>
                  </Select>
                </Field>
              </div>
              <Field label="Competitor (for competitor exports)" htmlFor="competitor">
                <Input id="competitor" name="competitor" placeholder="competitor.com" />
              </Field>
              <div>
                <SubmitButton pending="Adding…">Add</SubmitButton>
              </div>
            </ActionForm>
          </Card>
        )}
        <Card>
          <CardHeader icon={<Search className="size-4" />} title="Research queries" description="Run these yourself in a search engine, then paste useful pages above. The platform never scrapes search results." />
          <ul className="space-y-2 text-sm">
            {d.searchTemplates.map((t) => (
              <li key={t.query}>
                <Badge>{t.purpose}</Badge> <code className="break-all text-xs">{t.query}</code>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
