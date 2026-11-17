import Link from "next/link";
import { Globe, Plus, Rocket, Users } from "lucide-react";
import { can, keywordCounts, latestAuditScores, listWebsites, ROLE_LABEL, workspaceSearchSummary } from "@sge/core";
import { scoreTone } from "@/components/audit-ui";
import { Step } from "@/components/data-ui";
import { Badge, Card, CardHeader, Change, EmptyState, fmtCompact, fmtInt, Kpi, LinkButton, PageHeader } from "@/components/ui";
import { VerificationBadge } from "@/components/verification-badge";
import { db } from "@/lib/db";
import { currentActor, requireWorkspace } from "@/lib/session";

export default async function WorkspaceOverview({ params }: PageProps<"/w/[slug]">) {
  const { slug } = await params;
  const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
  const { workspace: ws, role } = access;
  const isAgency = ws.type === "agency";
  const [sites, scores, search, kws] = await Promise.all([
    listWebsites(db(), actor, access),
    latestAuditScores(db(), actor, access),
    workspaceSearchSummary(db(), actor, access),
    keywordCounts(db(), actor, access)
  ]);
  const verified = sites.filter((s) => s.website.verificationStatus === "verified").length;
  const healthValues = [...scores.values()].map((s) => s.healthScore).filter((v): v is number => v !== null);
  const avgHealth = healthValues.length ? Math.round(healthValues.reduce((a, b) => a + b, 0) / healthValues.length) : null;
  const clicks = [...search.values()].reduce((n, s) => n + s.clicks, 0);
  const prevClicks = [...search.values()].reduce((n, s) => n + s.prevClicks, 0);
  const keywordsTracked = [...kws.values()].reduce((a, b) => a + b, 0);
  const manage = can(role, "websites.manage");
  const first = sites[0]?.website;

  const steps = [
    { done: sites.length > 0, title: "Add your first website", href: `/w/${slug}/websites`, body: "Start with the site you want to grow." },
    { done: verified > 0, title: "Verify ownership", href: first ? `/w/${slug}/websites/${first.id}/settings#verification` : null, body: "DNS, meta tag, file, or Search Console." },
    { done: scores.size > 0, title: "Run a technical SEO audit", href: first ? `/w/${slug}/websites/${first.id}/audits` : null, body: "Find what's holding the site back." },
    { done: search.size > 0, title: "Connect Google Search Console", href: first ? `/w/${slug}/websites/${first.id}/settings#google` : null, body: "Clicks, queries and positions, free." },
    { done: keywordsTracked > 0, title: "Track keywords", href: first ? `/w/${slug}/websites/${first.id}/keywords` : null, body: "Follow the searches that matter." }
  ];
  const remaining = steps.filter((s) => !s.done).length;

  return (
    <>
      <PageHeader
        title={ws.name}
        description={isAgency ? "Agency workspace" : "Personal workspace"}
        actions={
          <>
            <Badge>{ROLE_LABEL[role]}</Badge>
            {isAgency && can(role, "members.manage") && (
              <LinkButton href={`/w/${slug}/settings/members`} variant="secondary">
                <Users className="size-4" aria-hidden /> Invite
              </LinkButton>
            )}
            {manage && sites.length > 0 && (
              <LinkButton href={`/w/${slug}/websites`}>
                <Plus className="size-4" aria-hidden /> Add website
              </LinkButton>
            )}
          </>
        }
      />

      <div className="flex flex-col gap-6">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Kpi label="Websites" value={sites.length} foot={`${verified} verified`} href={`/w/${slug}/websites`} />
          <Kpi label="Average health" value={<span className={scoreTone(avgHealth)}>{avgHealth ?? "–"}</span>} foot={`${scores.size} audited`} />
          <Kpi
            label="Clicks from Google · 28 days"
            value={search.size ? fmtCompact(clicks) : "–"}
            change={search.size ? <Change current={clicks} previous={prevClicks} /> : undefined}
            foot={search.size ? `${search.size} site${search.size === 1 ? "" : "s"} with Search Console` : "Connect Search Console"}
          />
          <Kpi label="Keywords tracked" value={fmtInt(keywordsTracked)} />
        </div>

        {remaining > 0 && (
          <Card>
            <CardHeader icon={<Rocket className="size-4" />} title="Getting started" description={`${steps.length - remaining} of ${steps.length} done`} />
            <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden>
              <div className="h-full rounded-full bg-success" style={{ width: `${((steps.length - remaining) / steps.length) * 100}%` }} />
            </div>
            <ol className="divide-y divide-border">
              {steps.map((s) => (
                <Step
                  key={s.title}
                  done={s.done}
                  title={s.title}
                  action={
                    s.href ? (
                      <Link href={s.href} className="text-sm font-medium text-brand hover:underline" aria-label={s.title}>
                        Start
                      </Link>
                    ) : null
                  }
                >
                  {s.body}
                </Step>
              ))}
            </ol>
          </Card>
        )}

        {sites.length === 0 ? (
          <EmptyState icon={<Globe className="size-5" />} title="No websites yet">
            {manage ? "Add a website to audit it, track keywords and connect Google data." : "No websites have been shared with you yet."}
          </EmptyState>
        ) : (
          <section aria-labelledby="sites-heading">
            <h2 id="sites-heading" className="mb-3 font-semibold">
              Site health
            </h2>
            <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {sites.map(({ website: w, clientName }) => {
                const sc = scores.get(w.id);
                const se = search.get(w.id);
                return (
                  <li key={w.id}>
                    <Link
                      href={`/w/${slug}/websites/${w.id}`}
                      className="block h-full rounded-xl border border-border bg-surface p-4 shadow-card transition hover:border-border-strong hover:bg-surface-2"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate font-medium">{w.displayName ?? w.domain}</div>
                          <div className="truncate text-xs text-subtle">{clientName ?? w.domain}</div>
                        </div>
                        <VerificationBadge status={w.verificationStatus} />
                      </div>
                      <dl className="mt-4 grid grid-cols-3 gap-2 text-sm">
                        <div>
                          <dt className="text-xs text-muted">Health</dt>
                          <dd className={`text-lg font-semibold tabular-nums ${scoreTone(sc?.healthScore ?? null)}`}>{sc?.healthScore ?? "–"}</dd>
                        </div>
                        <div>
                          <dt className="text-xs text-muted">Clicks 28d</dt>
                          <dd className="text-lg font-semibold tabular-nums">{se ? fmtCompact(se.clicks) : "–"}</dd>
                          {se && (
                            <dd className="-mt-0.5">
                              <Change current={se.clicks} previous={se.prevClicks} />
                            </dd>
                          )}
                        </div>
                        <div>
                          <dt className="text-xs text-muted">Keywords</dt>
                          <dd className="text-lg font-semibold tabular-nums">{kws.get(w.id) ?? 0}</dd>
                        </div>
                      </dl>
                      {sc && sc.critical > 0 && (
                        <p className="mt-2 text-xs text-danger">
                          {sc.critical} critical issue{sc.critical === 1 ? "" : "s"}
                        </p>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {!isAgency && (
          <Card className="bg-surface-2">
            <CardHeader
              icon={<Users className="size-4" />}
              title="Working with a team or clients?"
              description="Personal workspaces are just for you. An agency workspace adds teammates, roles and client-scoped access."
              actions={
                <LinkButton href="/workspaces/new" variant="secondary">
                  New agency workspace
                </LinkButton>
              }
            />
          </Card>
        )}
      </div>
    </>
  );
}
