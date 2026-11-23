import { Mail } from "lucide-react";
import { listOutreach } from "@sge/backlinks";
import { can } from "@sge/core";
import { ActionForm, SubmitButton } from "@/components/form";
import { Alert, Badge, Card, CardHeader, EmptyState, Input, Select } from "@/components/ui";
import { db } from "@/lib/db";
import { currentActor, requireWorkspace } from "@/lib/session";
import { outreachAction } from "../actions";
import { fmtWhen, SafeLink } from "../ui";

export default async function OutreachPage({ params }: PageProps<"/w/[slug]/websites/[websiteId]/backlinks/outreach">) {
  const { slug, websiteId } = await params;
  const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
  const rows = await listOutreach(db(), actor, access, websiteId);
  const canRun = can(access.role, "work.run");
  const canApprove = can(access.role, "work.approve");
  const act = (id: string) => outreachAction.bind(null, slug, websiteId, id);

  return (
    <div className="flex flex-col gap-4">
      <Alert tone="info">
        One message per publicly listed business contact, never bulk. Pitches for new links are approved on the Approvals tab; recovery emails and the single
        follow-up are reviewed here and sent from your own mailbox. Anyone who opts out is suppressed across the workspace.
      </Alert>
      {rows.length === 0 ? (
        <EmptyState icon={<Mail className="size-5" />} title="No outreach yet" />
      ) : (
        rows.map((o) => (
          <Card key={o.id}>
            <CardHeader
              title={o.subject ?? "(no subject)"}
              description={
                <>
                  {o.contact_email ?? "no public email"} {o.contact_source_url && <>· found on <SafeLink href={o.contact_source_url} /></>} · {fmtWhen(o.created_at)}
                </>
              }
              actions={
                <>
                  <Badge>{String(o.outreach_type).replace(/_/g, " ")}</Badge>
                  <Badge tone={o.status === "opted_out" ? "danger" : o.status === "sent" ? "brand" : "neutral"}>{String(o.status).replace(/_/g, " ")}</Badge>
                </>
              }
            />
            {o.body && (
              <details className="text-sm">
                <summary className="cursor-pointer text-brand">Message</summary>
                <pre className="mt-2 whitespace-pre-wrap font-sans text-muted">{o.body}</pre>
              </details>
            )}
            <div className="mt-3 flex flex-wrap items-end gap-3">
              {canApprove && (o.status === "follow_up_due" || (o.outreach_type === "recovery" && ["awaiting_approval", "approved"].includes(o.status))) && (
                <ActionForm compact action={act(o.id)}>
                  <input type="hidden" name="op" value="sent" />
                  <SubmitButton size="sm">I reviewed and sent it</SubmitButton>
                </ActionForm>
              )}
              {canRun && ["sent", "follow_up_due", "replied"].includes(o.status) && (
                <ActionForm action={act(o.id)} className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="op" value="reply" />
                  <Input name="text" placeholder="Paste their reply" aria-label="Reply text" className="w-72" required />
                  <Select name="decision" aria-label="Decision" defaultValue="">
                    <option value="">No decision yet</option>
                    <option value="accepted">Accepted</option>
                    <option value="revisions_requested">Revisions requested</option>
                    <option value="rejected">Declined</option>
                  </Select>
                  <SubmitButton size="sm" variant="secondary">
                    Record reply
                  </SubmitButton>
                </ActionForm>
              )}
              {canRun && o.submission_id && ["sent", "replied", "accepted"].includes(o.status) && (
                <ActionForm action={act(o.id)} className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="op" value="published" />
                  <Input name="url" type="url" placeholder="Published article URL" aria-label="Published URL" className="w-72" required />
                  <SubmitButton size="sm" variant="secondary">
                    Verify publication
                  </SubmitButton>
                </ActionForm>
              )}
              {canRun && o.contact_email && !["opted_out", "closed"].includes(o.status) && (
                <ActionForm compact action={act(o.id)}>
                  <input type="hidden" name="op" value="opt_out" />
                  <SubmitButton size="sm" variant="ghost">
                    They opted out
                  </SubmitButton>
                </ActionForm>
              )}
            </div>
          </Card>
        ))
      )}
    </div>
  );
}
