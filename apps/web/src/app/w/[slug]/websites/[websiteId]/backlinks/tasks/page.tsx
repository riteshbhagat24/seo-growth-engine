import Link from "next/link";
import { ListChecks } from "lucide-react";
import { listBacklinkTasks } from "@sge/backlinks";
import { can } from "@sge/core";
import { ActionForm, SubmitButton } from "@/components/form";
import { Badge, Card, CardHeader, EmptyState, Field, Input, Select } from "@/components/ui";
import { db } from "@/lib/db";
import { currentActor, requireWorkspace } from "@/lib/session";
import { resolveTaskAction } from "../actions";
import { fmtWhen } from "../ui";

/** Which resolutions make sense for each task type. */
const OPTIONS: Record<string, [string, string][]> = {
  manual_submission: [["submitted_manually", "I submitted it (add the listing URL if published)"], ["dismiss", "Skip this destination"]],
  captcha_required: [["submitted_manually", "I submitted it myself"], ["dismiss", "Skip this destination"]],
  email_verification: [["resume", "I verified the email"], ["submitted_manually", "Submitted; add the listing URL"], ["dismiss", "Skip"]],
  login_required: [["submitted_manually", "I submitted it with my own account"], ["dismiss", "Skip"]],
  manual_review: [["resume", "Checked: safe to try again"], ["submitted_manually", "It was submitted; add the URL"], ["dismiss", "Skip"]],
  adapter_error: [["resume", "Fixed: try again"], ["dismiss", "Give up on this destination"]],
  outreach_send: [["mark_sent", "I sent the approved message"], ["dismiss", "Don't send"]],
  outreach_reply: [["dismiss", "Done"]],
  recovery: [["dismiss", "Done"]],
  profile_incomplete: [["dismiss", "Done"]]
};

export default async function TasksPage({ params }: PageProps<"/w/[slug]/websites/[websiteId]/backlinks/tasks">) {
  const { slug, websiteId } = await params;
  const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
  const tasks = await listBacklinkTasks(db(), actor, access, websiteId);
  const canRun = can(access.role, "work.run");
  const base = `/w/${slug}/websites/${websiteId}/backlinks`;

  if (tasks.length === 0)
    return (
      <EmptyState icon={<ListChecks className="size-5" />} title="No open tasks">
        CAPTCHAs, logins, email verification and manual-only destinations become tasks here, with everything prepared.
      </EmptyState>
    );

  return (
    <div className="flex flex-col gap-4">
      {tasks.map((t) => {
        const prepared = (t.payload?.prepared_values ?? t.payload?.values) as Record<string, string | null> | undefined;
        const assets = t.payload?.assets as { type: string; title: string | null; body: string }[] | undefined;
        return (
          <Card key={t.id}>
            <CardHeader
              title={t.title}
              description={`Opened ${fmtWhen(t.created_at)}${t.due_at ? ` · due ${fmtWhen(t.due_at)}` : ""}`}
              actions={<Badge tone="warning">{t.task_type.replace(/_/g, " ")}</Badge>}
            />
            <p className="whitespace-pre-line text-sm">{t.instructions}</p>
            {t.submission_id && (
              <Link href={`${base}/submissions/${t.submission_id}`} className="mt-1 inline-block text-sm text-brand hover:underline">
                Submission history
              </Link>
            )}
            {prepared && (
              <details className="mt-3 text-sm">
                <summary className="cursor-pointer text-brand">Prepared values (copy and paste)</summary>
                <dl className="mt-2 grid gap-1">
                  {Object.entries(prepared)
                    .filter(([, v]) => v)
                    .map(([k, v]) => (
                      <div key={k} className="flex gap-2">
                        <dt className="w-40 shrink-0 text-muted">{k.replace(/_/g, " ")}</dt>
                        <dd className="min-w-0 whitespace-pre-wrap break-words">{v}</dd>
                      </div>
                    ))}
                </dl>
              </details>
            )}
            {assets && assets.length > 0 && (
              <details className="mt-2 text-sm">
                <summary className="cursor-pointer text-brand">Prepared content</summary>
                {assets.map((a) => (
                  <div key={a.type} className="mt-2">
                    <div className="font-medium">{a.type.replace(/_/g, " ")}</div>
                    <pre className="whitespace-pre-wrap font-sans text-muted">{a.body}</pre>
                  </div>
                ))}
              </details>
            )}
            {canRun && (
              <ActionForm action={resolveTaskAction.bind(null, slug, websiteId, t.id)} className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                <Field label="What happened" htmlFor={`action-${t.id}`}>
                  <Select id={`action-${t.id}`} name="action" defaultValue={(OPTIONS[t.task_type] ?? [["dismiss", "Done"]])[0]![0]}>
                    {(OPTIONS[t.task_type] ?? [["dismiss", "Done"]]).map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Published URL (if any)" htmlFor={`url-${t.id}`}>
                  <Input id={`url-${t.id}`} name="live_url" type="url" placeholder="https://…" />
                </Field>
                <SubmitButton>Save</SubmitButton>
              </ActionForm>
            )}
          </Card>
        );
      })}
    </div>
  );
}
