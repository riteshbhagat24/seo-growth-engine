import { CheckCircle2 } from "lucide-react";
import { listApprovals } from "@sge/backlinks";
import { can } from "@sge/core";
import { ActionForm, SubmitButton } from "@/components/form";
import { Alert, Badge, Card, CardHeader, EmptyState, Input } from "@/components/ui";
import { db } from "@/lib/db";
import { currentActor, requireWorkspace } from "@/lib/session";
import { decideApprovalAction } from "../actions";
import { fmtWhen, SafeLink } from "../ui";

type Snapshot = {
  destination: { name: string; domain: string; url: string; permission: string };
  adapter: { key: string; name: string; type: string };
  score: number;
  values: Record<string, string | null>;
  assets: { id: string; type: string; title: string | null; body: string; fact_check?: { passed?: boolean; claims?: { text: string; kind: string; supported: boolean }[] } }[];
  outreach: { to: string | null; contact_source_url: string | null; subject: string | null; body: string | null } | null;
  why_approval: string[];
};

const SHOWN = ["business_name", "target_url", "anchor_text", "email", "category", "country", "short_description"];

export default async function ApprovalsPage({ params }: PageProps<"/w/[slug]/websites/[websiteId]/backlinks/approvals">) {
  const { slug, websiteId } = await params;
  const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
  const rows = await listApprovals(db(), actor, access, websiteId);
  const canApprove = can(access.role, "work.approve");

  if (rows.length === 0)
    return (
      <EmptyState icon={<CheckCircle2 className="size-5" />} title="Nothing waiting for approval">
        Submissions and outreach messages appear here exactly as they would be sent.
      </EmptyState>
    );

  return (
    <div className="flex flex-col gap-6">
      {!canApprove && <Alert tone="info">You can review these. Approving needs an owner, admin or manager.</Alert>}
      {rows.map((r) => {
        const s = r.snapshot as Snapshot;
        return (
          <Card key={r.id}>
            <CardHeader
              title={s.destination.name}
              description={
                <>
                  <SafeLink href={s.destination.url} /> · {s.adapter.name} · score {s.score} · requested {fmtWhen(r.requested_at)}
                </>
              }
              actions={<Badge tone="neutral">permission: {s.destination.permission.replace(/_/g, " ")}</Badge>}
            />
            <p className="mb-3 text-sm text-muted">Why approval is needed: {s.why_approval.join("; ")}.</p>
            <dl className="mb-4 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
              {SHOWN.filter((k) => s.values?.[k]).map((k) => (
                <div key={k} className="flex gap-2">
                  <dt className="w-36 shrink-0 text-muted">{k.replace(/_/g, " ")}</dt>
                  <dd className="min-w-0 break-words">{s.values[k]}</dd>
                </div>
              ))}
            </dl>
            {s.outreach && (
              <div className="mb-4 rounded-lg border border-border bg-surface-2 p-3 text-sm">
                <div className="mb-1 text-muted">
                  To {s.outreach.to ?? "no public email found (use their contact form)"}
                  {s.outreach.contact_source_url && (
                    <>
                      {" "}
                      · found on <SafeLink href={s.outreach.contact_source_url} />
                    </>
                  )}
                </div>
                <div className="font-medium">{s.outreach.subject}</div>
                <pre className="mt-1 whitespace-pre-wrap font-sans">{s.outreach.body}</pre>
              </div>
            )}
            <div className="flex flex-col gap-3">
              {s.assets.map((a) => (
                <details key={a.id} className="rounded-lg border border-border p-3 text-sm">
                  <summary className="cursor-pointer">
                    <span className="font-medium">{a.type.replace(/_/g, " ")}</span>{" "}
                    {a.fact_check?.passed === false ? <Badge tone="danger">unverified claims</Badge> : <Badge tone="success">fact-checked</Badge>}
                  </summary>
                  {a.title && <div className="mt-2 font-medium">{a.title}</div>}
                  <pre className="mt-1 whitespace-pre-wrap font-sans text-muted">{a.body}</pre>
                  {a.fact_check?.claims?.some((c) => !c.supported) && (
                    <p className="mt-2 text-xs text-danger">
                      Not in the approved profile: {a.fact_check.claims.filter((c) => !c.supported).map((c) => `"${c.text}" (${c.kind})`).join(", ")}
                    </p>
                  )}
                </details>
              ))}
            </div>
            {canApprove && (
              <div className="mt-4 flex flex-wrap items-end gap-3">
                <ActionForm action={decideApprovalAction.bind(null, slug, websiteId, r.id, "approved")} className="flex flex-wrap items-end gap-2">
                  <Input name="note" placeholder="Note (optional)" aria-label="Approval note" className="w-64" />
                  <SubmitButton pending="Approving…">Approve and queue</SubmitButton>
                </ActionForm>
                <ActionForm action={decideApprovalAction.bind(null, slug, websiteId, r.id, "rejected")} confirm="Reject this submission?">
                  <SubmitButton variant="secondary">Reject</SubmitButton>
                </ActionForm>
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}
