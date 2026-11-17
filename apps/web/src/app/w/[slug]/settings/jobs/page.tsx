import { notFound } from "next/navigation";
import { can, JOB_LABEL, listWorkspaceJobs } from "@sge/core";
import { Card, PageHeader } from "@/components/ui";
import { db } from "@/lib/db";
import { currentActor, requireWorkspace } from "@/lib/session";

const fmt = (d: Date | null) => (d ? d.toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" }) : "—");

export default async function JobsPage({ params }: PageProps<"/w/[slug]/settings/jobs">) {
  const { slug } = await params;
  const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
  if (!can(access.role, "work.run")) notFound();
  const rows = await listWorkspaceJobs(db(), actor, access, 100);

  return (
    <>
      <PageHeader title="Background jobs" description="The last 100 background tasks in this workspace, such as crawls, audits and Core Web Vitals tests." />
      <Card className="p-0 sm:p-0">
        {rows.length === 0 ? (
          <p className="p-6 text-sm text-muted">No background jobs yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border text-xs uppercase tracking-wider text-muted">
                <tr>
                  <th className="px-6 py-3 font-medium">Task</th>
                  <th className="px-6 py-3 font-medium">Status</th>
                  <th className="px-6 py-3 font-medium">Created</th>
                  <th className="px-6 py-3 font-medium">Finished</th>
                  <th className="px-6 py-3 font-medium">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((j) => (
                  <tr key={j.id}>
                    <td className="px-6 py-3">{JOB_LABEL[j.type] ?? j.type}</td>
                    <td className="px-6 py-3 capitalize">{j.status}</td>
                    <td className="px-6 py-3 text-muted">{fmt(j.createdAt)}</td>
                    <td className="px-6 py-3 text-muted">{fmt(j.finishedAt)}</td>
                    <td className="max-w-[360px] truncate px-6 py-3 text-muted" title={j.lastError ?? undefined}>
                      {j.lastError ?? (j.attempts > 1 ? `${j.attempts} attempts` : "")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
