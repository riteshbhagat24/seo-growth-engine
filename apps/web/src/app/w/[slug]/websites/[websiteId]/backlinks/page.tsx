import Link from "next/link";
import { Link2, Plus } from "lucide-react";
import { backlinksOverview } from "@sge/backlinks";
import { can } from "@sge/core";
import { ActionForm, SubmitButton } from "@/components/form";
import { Alert, Card, CardHeader, EmptyState, Field, fmtInt, Input, Kpi, Textarea } from "@/components/ui";
import { db } from "@/lib/db";
import { currentActor, requireWorkspace } from "@/lib/session";
import { createCampaignAction } from "./actions";
import { fmtWhen, StatusBadge } from "./ui";

export default async function BacklinksPage({ params }: PageProps<"/w/[slug]/websites/[websiteId]/backlinks">) {
  const { slug, websiteId } = await params;
  const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
  const o = await backlinksOverview(db(), actor, access, websiteId);
  const base = `/w/${slug}/websites/${websiteId}/backlinks`;
  const f = o.metrics.funnel;
  const canRun = can(access.role, "work.run");

  return (
    <div className="flex flex-col gap-6">
      {(!o.profile || o.profile.status !== "approved") && (
        <Alert tone="warning">
          Submission content is written only from an approved business profile.{" "}
          <Link href={`${base}/profile`} className="font-medium underline">
            {o.profile ? "Review and approve the profile" : "Create the business profile"}
          </Link>{" "}
          before campaigns can prepare submissions.
        </Alert>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Verified live links" value={fmtInt(f.verified_live_now)} foot={`${fmtInt(o.metrics.new_referring_domains)} new referring domains`} />
        <Kpi label="Submitted" value={fmtInt(f.successful_submissions)} foot={`${fmtInt(f.published)} published · not counted until verified`} />
        <Kpi label="Waiting on you" value={fmtInt(o.counts.approvals + o.counts.tasks)} href={o.counts.approvals ? `${base}/approvals` : `${base}/tasks`} foot={`${o.counts.approvals} approvals · ${o.counts.tasks} tasks`} />
        <Kpi label="Lost" value={fmtInt(f.lost)} foot="Recovery is drafted for approval" />
      </div>
      <p className="-mt-3 text-xs text-subtle">
        {o.metrics.disclaimer} Opportunities discovered: {fmtInt(f.opportunities_discovered)}, qualified: {fmtInt(f.opportunities_qualified)}. Mode:{" "}
        <strong className="font-medium text-muted">{o.automation.mode}</strong>.
      </p>

      <Card className="p-0 sm:p-0">
        <div className="p-6 pb-0">
          <CardHeader icon={<Link2 className="size-4" />} title="Campaigns" description="Each campaign discovers, scores and prepares opportunities for this website." />
        </div>
        {o.campaigns.length === 0 ? (
          <div className="p-6">
            <EmptyState title="No campaigns yet">Create one below. Discovery starts from the curated catalogue and any URLs or CSV exports you add.</EmptyState>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-y border-border text-xs uppercase tracking-wider text-muted">
                <tr>
                  <th className="px-6 py-3 font-medium">Campaign</th>
                  <th className="px-6 py-3 font-medium">Status</th>
                  <th className="px-6 py-3 text-right font-medium">Opportunities</th>
                  <th className="px-6 py-3 text-right font-medium">Submissions</th>
                  <th className="px-6 py-3 text-right font-medium">Verified</th>
                  <th className="px-6 py-3 font-medium">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {o.campaigns.map((c) => (
                  <tr key={c.id}>
                    <td className="px-6 py-3">
                      <Link href={`${base}/campaigns/${c.id}`} className="font-medium text-brand hover:underline">
                        {c.name}
                      </Link>
                    </td>
                    <td className="px-6 py-3">
                      <StatusBadge status={c.status} />
                    </td>
                    <td className="px-6 py-3 text-right tabular-nums">{fmtInt(c.opportunities)}</td>
                    <td className="px-6 py-3 text-right tabular-nums">{fmtInt(c.submissions)}</td>
                    <td className="px-6 py-3 text-right tabular-nums">{fmtInt(c.verified)}</td>
                    <td className="px-6 py-3 text-muted">{fmtWhen(c.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {canRun && (
        <Card>
          <CardHeader icon={<Plus className="size-4" />} title="New campaign" description="Industry and countries come from the business profile. Supervised by default: nothing is submitted without approval." />
          <ActionForm action={createCampaignAction.bind(null, slug, websiteId)} className="grid gap-4 md:grid-cols-2">
            <Field label="Name" htmlFor="name">
              <Input id="name" name="name" required maxLength={200} placeholder="Q1 directories" />
            </Field>
            <Field label="Target pages" htmlFor="target_pages" hint="One URL per line; links will point here. Default: the profile's landing pages.">
              <Textarea id="target_pages" name="target_pages" rows={2} />
            </Field>
            <Field label="Target keywords" htmlFor="target_keywords" hint="One per line (used for relevance)">
              <Textarea id="target_keywords" name="target_keywords" rows={2} />
            </Field>
            <Field label="Extra URLs to evaluate" htmlFor="seed_urls" hint="Resource pages or directories you already know, one per line">
              <Textarea id="seed_urls" name="seed_urls" rows={2} />
            </Field>
            <Field label="Excluded domains" htmlFor="excluded_domains" hint="One per line">
              <Textarea id="excluded_domains" name="excluded_domains" rows={2} />
            </Field>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Min score" htmlFor="min_quality_score">
                <Input id="min_quality_score" name="min_quality_score" type="number" min={0} max={100} defaultValue={50} />
              </Field>
              <Field label="Per day" htmlFor="max_daily">
                <Input id="max_daily" name="max_daily" type="number" min={0} max={500} defaultValue={5} />
              </Field>
              <Field label="Per week" htmlFor="max_weekly">
                <Input id="max_weekly" name="max_weekly" type="number" min={0} max={2000} defaultValue={20} />
              </Field>
            </div>
            <label className="flex items-center gap-2 text-sm md:col-span-2">
              <input type="checkbox" name="approval_required" defaultChecked className="size-4 accent-[var(--brand)]" />
              Every submission needs approval (recommended; autopilot also needs explicit permission per destination)
            </label>
            <div className="md:col-span-2">
              <SubmitButton pending="Creating…">Create campaign</SubmitButton>
            </div>
          </ActionForm>
        </Card>
      )}
    </div>
  );
}
