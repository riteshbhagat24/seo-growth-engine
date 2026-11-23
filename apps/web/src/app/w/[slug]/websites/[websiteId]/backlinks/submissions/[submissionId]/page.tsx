import Link from "next/link";
import { notFound } from "next/navigation";
import { submissionDetail } from "@sge/backlinks";
import { AppError, isUuidLike } from "@sge/core";
import { Badge, Card, CardHeader, PageHeader } from "@/components/ui";
import { db } from "@/lib/db";
import { currentActor, requireWorkspace } from "@/lib/session";
import { fmtWhen, SafeLink, StatusBadge } from "../../ui";

export default async function SubmissionPage({ params }: PageProps<"/w/[slug]/websites/[websiteId]/backlinks/submissions/[submissionId]">) {
  const { slug, websiteId, submissionId } = await params;
  if (!isUuidLike(submissionId)) notFound();
  const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
  const d = await submissionDetail(db(), actor, access, submissionId).catch((e) => {
    if (e instanceof AppError && e.code === "not_found") notFound();
    throw e;
  });
  const s = d.submission;
  const base = `/w/${slug}/websites/${websiteId}/backlinks`;
  const attrs = (s.link_attributes ?? {}) as Record<string, unknown>;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={
          <Link href={`${base}/campaigns/${s.campaign_id}`} className="hover:text-foreground">
            Campaign
          </Link>
        }
        title={s.destination_domain}
        description={`${s.adapter_key} · target ${s.target_url}${s.anchor_text ? ` · anchor “${s.anchor_text}”` : ""}`}
        actions={<StatusBadge status={s.status} />}
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Link" description="Verified means our crawler found the link live on the page." />
          <dl className="grid gap-1 text-sm">
            <div className="flex gap-2">
              <dt className="w-36 text-muted">Live URL</dt>
              <dd className="min-w-0">
                <SafeLink href={s.live_url} />
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-36 text-muted">Submitted</dt>
              <dd>{fmtWhen(s.submitted_at)}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-36 text-muted">First verified</dt>
              <dd>{fmtWhen(s.first_detected_at)}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-36 text-muted">Last checked</dt>
              <dd>{fmtWhen(s.last_verified_at)}</dd>
            </div>
            {s.lost_at && (
              <div className="flex gap-2">
                <dt className="w-36 text-muted">Lost</dt>
                <dd>{fmtWhen(s.lost_at)}</dd>
              </div>
            )}
            <div className="flex gap-2">
              <dt className="w-36 text-muted">Attributes</dt>
              <dd className="flex flex-wrap gap-1">
                {attrs.anchor_text !== undefined ? (
                  <>
                    <Badge tone={attrs.nofollow || attrs.sponsored || attrs.ugc ? "neutral" : "success"}>{attrs.nofollow || attrs.sponsored || attrs.ugc ? "not followed" : "followed"}</Badge>
                    {Boolean(attrs.nofollow) && <Badge>nofollow</Badge>}
                    {Boolean(attrs.sponsored) && <Badge>sponsored</Badge>}
                    {Boolean(attrs.ugc) && <Badge>ugc</Badge>}
                  </>
                ) : (
                  <span className="text-subtle">not seen yet</span>
                )}
              </dd>
            </div>
            {s.confirmation_text && (
              <div className="flex gap-2">
                <dt className="w-36 shrink-0 text-muted">Confirmation</dt>
                <dd className="min-w-0 break-words">{s.confirmation_text}</dd>
              </div>
            )}
            {s.error_message && (
              <div className="flex gap-2">
                <dt className="w-36 shrink-0 text-muted">Error</dt>
                <dd className="min-w-0 break-words text-danger">{s.error_message}</dd>
              </div>
            )}
          </dl>
        </Card>
        <Card>
          <CardHeader title="Evidence" description="Captured at submission time. SHA-256 recorded for each item." />
          {d.evidence.length === 0 ? (
            <p className="text-sm text-muted">No evidence yet.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {d.evidence.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center gap-2">
                  <Badge>{String(e.kind).replace(/_/g, " ")}</Badge>
                  {typeof e.meta?.stage === "string" && <span className="text-muted">{e.meta.stage}</span>}
                  {e.content ? (
                    <span className="min-w-0 break-words text-muted">{String(e.content).slice(0, 240)}</span>
                  ) : (
                    <a className="text-brand hover:underline" href={`/api/w/${slug}/backlinks/evidence/${e.id}`} target="_blank" rel="noreferrer">
                      {e.has_file ? "view" : "download"} ({Math.ceil((e.bytes ?? 0) / 1024)} KB)
                    </a>
                  )}
                  <code className="text-[10px] text-subtle" title="SHA-256">
                    {String(e.sha256 ?? "").slice(0, 12)}
                  </code>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <Card>
        <CardHeader title="History" />
        <ol className="space-y-2 text-sm">
          {d.events.map((e, i) => (
            <li key={i} className="flex flex-wrap gap-x-3">
              <span className="w-40 shrink-0 text-muted">{fmtWhen(e.created_at)}</span>
              <span className="w-56 shrink-0">
                {e.from_status !== e.to_status ? (
                  <>
                    {e.from_status ?? "—"} → <strong className="font-medium">{e.to_status}</strong>
                  </>
                ) : (
                  <span className="text-muted">{e.to_status}</span>
                )}
              </span>
              <span className="min-w-0 flex-1 break-words text-muted">
                {e.message} <span className="text-subtle">({e.actor_type})</span>
              </span>
            </li>
          ))}
        </ol>
      </Card>
      {d.verifications.length > 0 && (
        <Card className="p-0 sm:p-0">
          <div className="p-6 pb-3">
            <CardHeader title="Crawler checks" />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-y border-border text-xs uppercase tracking-wider text-muted">
                <tr>
                  <th className="px-6 py-3 font-medium">Checked</th>
                  <th className="px-6 py-3 font-medium">Result</th>
                  <th className="px-6 py-3 font-medium">HTTP</th>
                  <th className="px-6 py-3 font-medium">Anchor</th>
                  <th className="px-6 py-3 font-medium">rel</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {d.verifications.map((v) => (
                  <tr key={v.id}>
                    <td className="px-6 py-3 text-muted">{fmtWhen(v.checked_at)}</td>
                    <td className="px-6 py-3">{String(v.result).replace(/_/g, " ")}</td>
                    <td className="px-6 py-3 tabular-nums">{v.http_status ?? "—"}</td>
                    <td className="px-6 py-3">{v.anchor_text ?? "—"}</td>
                    <td className="px-6 py-3 text-muted">{v.rel.join(" ") || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
