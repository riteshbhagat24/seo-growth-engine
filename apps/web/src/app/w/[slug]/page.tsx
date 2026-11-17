import Link from "next/link";
import { ROLE_LABEL, can, listWebsites } from "@sge/core";
import { Badge, Card, LinkButton, PageHeader } from "@/components/ui";
import { db } from "@/lib/db";
import { currentActor, requireWorkspace } from "@/lib/session";

export default async function WorkspaceOverview({ params }: PageProps<"/w/[slug]">) {
  const { slug } = await params;
  const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
  const { workspace: ws, role } = access;
  const isAgency = ws.type === "agency";
  const sites = await listWebsites(db(), actor, access);
  const verified = sites.filter((s) => s.website.verificationStatus === "verified").length;

  const steps = [
    { done: true, label: "Create your workspace" },
    { done: sites.length > 0, label: "Add your first website", href: `/w/${slug}/websites` },
    { done: verified > 0, label: "Verify ownership of a website", href: sites[0] ? `/w/${slug}/websites/${sites[0].website.id}` : `/w/${slug}/websites` },
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
                  {"href" in s && s.href && !s.done ? (
                    <Link href={s.href} className="text-brand hover:underline">
                      {s.label}
                    </Link>
                  ) : (
                    <span className={s.done ? "text-muted line-through" : ""}>{s.label}</span>
                  )}
                  {"note" in s && s.note && <span className="ml-2 text-xs text-muted">({s.note})</span>}
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
