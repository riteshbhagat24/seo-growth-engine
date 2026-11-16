import { ROLE_LABEL, can } from "@sge/core";
import { Badge, Card, LinkButton, PageHeader } from "@/components/ui";
import { requireWorkspace } from "@/lib/session";

export default async function WorkspaceOverview({ params }: PageProps<"/w/[slug]">) {
  const { slug } = await params;
  const { workspace: ws, role } = await requireWorkspace(slug);
  const isAgency = ws.type === "agency";

  const steps = [
    { done: true, label: "Create your workspace" },
    { done: false, label: "Add your first website and verify ownership", note: "Arrives in the next release (M2)" },
    { done: false, label: "Run a technical SEO audit", note: "M4" },
    { done: false, label: "Connect Google Search Console", note: "M5" }
  ];

  return (
    <>
      <PageHeader
        title={ws.name}
        description={isAgency ? "Agency workspace" : "Personal workspace"}
        actions={
          <div className="flex items-center gap-2">
            <Badge>{ROLE_LABEL[role]}</Badge>
            {isAgency && can(role, "members.manage") && (
              <LinkButton href={`/w/${slug}/settings/members`} variant="secondary">
                Invite teammates
              </LinkButton>
            )}
          </div>
        }
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <h2 className="font-semibold">Getting started</h2>
          <ol className="mt-4 flex flex-col gap-3">
            {steps.map((s) => (
              <li key={s.label} className="flex items-start gap-3 text-sm">
                <span
                  aria-hidden
                  className={`mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border text-[11px] ${
                    s.done ? "border-success bg-success text-white" : "border-border text-muted"
                  }`}
                >
                  {s.done ? "✓" : ""}
                </span>
                <span>
                  <span className={s.done ? "text-muted line-through" : ""}>{s.label}</span>
                  {s.note && <span className="ml-2 text-xs text-muted">({s.note})</span>}
                </span>
              </li>
            ))}
          </ol>
        </Card>
        <Card>
          <h2 className="font-semibold">{isAgency ? "Your agency" : "Working with a team?"}</h2>
          <p className="mt-2 text-sm text-muted">
            {isAgency
              ? "Invite teammates, set their roles, and soon add clients with their own read-only dashboards."
              : "Personal workspaces are just for you. Create an agency workspace to invite teammates and manage clients."}
          </p>
          {!isAgency && (
            <LinkButton href="/workspaces/new" variant="secondary" className="mt-4">
              New agency workspace
            </LinkButton>
          )}
        </Card>
      </div>
    </>
  );
}
