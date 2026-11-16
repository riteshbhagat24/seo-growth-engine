import { notFound } from "next/navigation";
import { can, listMembers, listWorkspaceAudit } from "@sge/core";
import { Card, PageHeader } from "@/components/ui";
import { db } from "@/lib/db";
import { currentActor, requireWorkspace } from "@/lib/session";

const LABELS: Record<string, string> = {
  "workspace.created": "Created the workspace",
  "workspace.updated": "Updated workspace settings",
  "member.invited": "Invited a member",
  "invitation.revoked": "Revoked an invitation",
  "invitation.accepted": "Joined via invitation",
  "member.role_changed": "Changed a member's role",
  "member.removed": "Removed a member",
  "member.left": "Left the workspace",
  "ownership.transferred": "Transferred ownership"
};

function detail(action: string, m: Record<string, unknown>): string {
  if (action === "member.invited") return `${m.email} as ${m.role}`;
  if (action === "member.role_changed") return `${m.from} → ${m.to}`;
  if (action === "invitation.revoked") return String(m.email ?? "");
  if (action === "invitation.accepted") return `as ${m.role}`;
  if (action === "workspace.updated") {
    const b = m.before as { name?: string } | undefined;
    const a = m.after as { name?: string } | undefined;
    return b?.name !== a?.name ? `name: ${b?.name} → ${a?.name}` : "branding";
  }
  return "";
}

export default async function AuditPage({ params }: PageProps<"/w/[slug]/settings/audit">) {
  const { slug } = await params;
  const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
  if (!can(access.role, "audit.view")) notFound();
  const [entries, members] = await Promise.all([listWorkspaceAudit(db(), actor, access, 200), listMembers(db(), actor, access)]);
  const names = new Map(members.map((m) => [m.userId, m.name]));

  return (
    <>
      <PageHeader title="Audit log" description="The last 200 security-relevant events in this workspace. Entries can't be edited or deleted." />
      <Card className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border text-xs uppercase tracking-wider text-muted">
              <tr>
                <th className="px-6 py-3 font-medium">When (UTC)</th>
                <th className="px-6 py-3 font-medium">Who</th>
                <th className="px-6 py-3 font-medium">What</th>
                <th className="px-6 py-3 font-medium">Details</th>
                <th className="px-6 py-3 font-medium">IP</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {entries.map((e) => (
                <tr key={e.id}>
                  <td className="whitespace-nowrap px-6 py-3 text-muted">{e.createdAt.toISOString().replace("T", " ").slice(0, 16)}</td>
                  <td className="px-6 py-3">{e.actorUserId ? (names.get(e.actorUserId) ?? "Former member") : "System"}</td>
                  <td className="px-6 py-3">{LABELS[e.action] ?? e.action}</td>
                  <td className="px-6 py-3 text-muted">{detail(e.action, e.metadata)}</td>
                  <td className="px-6 py-3 font-mono text-xs text-muted">{e.ip ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
