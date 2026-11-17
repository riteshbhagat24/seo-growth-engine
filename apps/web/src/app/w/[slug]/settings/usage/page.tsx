import { notFound } from "next/navigation";
import { can, UNLIMITED, usageSummary } from "@sge/core";
import { Badge, Card, PageHeader } from "@/components/ui";
import { db } from "@/lib/db";
import { currentActor, requireWorkspace } from "@/lib/session";

const fmt = (n: number) => n.toLocaleString("en-IN");

export default async function UsagePage({ params }: PageProps<"/w/[slug]/settings/usage">) {
  const { slug } = await params;
  const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
  if (!can(access.role, "plan.view")) notFound();
  const summary = await usageSummary(db(), actor, access);

  return (
    <>
      <PageHeader
        title="Plan & usage"
        description="Limits for this workspace. Billing isn't enabled yet; plan changes are made by the platform team."
        actions={<Badge>{summary.planName}</Badge>}
      />
      <Card className="max-w-3xl">
        <ul className="flex flex-col gap-5">
          {summary.lines.map((l) => {
            const unlimited = l.limit === UNLIMITED;
            const pct = unlimited || l.limit === 0 ? 0 : Math.min(100, Math.round((l.used / l.limit) * 100));
            const tone = pct >= 100 ? "bg-danger" : pct >= 80 ? "bg-accent" : "bg-brand";
            return (
              <li key={l.key}>
                <div className="flex justify-between text-sm">
                  <span className="font-medium">
                    {l.label}
                    {l.metered && <span className="ml-2 text-xs font-normal text-muted">resets monthly</span>}
                  </span>
                  <span className="text-muted">
                    {fmt(l.used)} / {unlimited ? "Unlimited" : l.limit === 0 ? "Not included" : fmt(l.limit)}
                  </span>
                </div>
                <div
                  className="mt-2 h-2 overflow-hidden rounded-full bg-background"
                  role="progressbar"
                  aria-label={l.label}
                  aria-valuenow={pct}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
                </div>
              </li>
            );
          })}
        </ul>
      </Card>
    </>
  );
}
