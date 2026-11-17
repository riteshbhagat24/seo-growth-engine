import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, getOnpage, isUuidLike } from "@sge/core";
import type { OnPageCheck } from "@sge/seo-rules";
import { ScoreRing, Stat } from "@/components/audit-ui";
import { Card, LinkButton, PageHeader } from "@/components/ui";
import { db } from "@/lib/db";
import { currentActor, requireWorkspace } from "@/lib/session";

const ICON: Record<OnPageCheck["status"], { mark: string; cls: string; label: string }> = {
  pass: { mark: "✓", cls: "bg-success/10 text-success", label: "Pass" },
  warn: { mark: "!", cls: "bg-warning/10 text-warning", label: "Improve" },
  fail: { mark: "✕", cls: "bg-danger/10 text-danger", label: "Fix" },
  info: { mark: "i", cls: "bg-background text-muted", label: "Info" }
};
const GROUPS: OnPageCheck["group"][] = ["Keyword", "Content", "Meta", "Links", "Technical"];

export default async function OnPageResultPage({ params }: PageProps<"/w/[slug]/websites/[websiteId]/onpage/[analysisId]">) {
  const { slug, websiteId, analysisId } = await params;
  if (!isUuidLike(websiteId) || !isUuidLike(analysisId)) notFound();
  const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
  const a = await getOnpage(db(), actor, access, analysisId).catch((e) => {
    if (e instanceof AppError && e.code === "not_found") notFound();
    throw e;
  });
  if (a.websiteId !== websiteId) notFound();
  const r = a.result;
  const order = { fail: 0, warn: 1, pass: 2, info: 3 } as const;
  const again = `/w/${slug}/websites/${websiteId}/onpage?page=${encodeURIComponent(new URL(a.url).pathname)}&keyword=${encodeURIComponent(a.keyword)}`;

  return (
    <>
      <Link href={`/w/${slug}/websites/${websiteId}/onpage`} className="text-sm text-muted hover:text-foreground">
        ← On-page analysis
      </Link>
      <div className="mt-3">
        <PageHeader
          title={`“${a.keyword}”`}
          description={`${a.url}${a.finalUrl ? ` → ${a.finalUrl}` : ""} · ${a.createdAt.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}`}
          actions={<LinkButton variant="secondary" href={again}>Analyse again</LinkButton>}
        />
      </div>
      <div className="flex flex-col gap-6">
        <Card>
          <div className="flex flex-wrap items-center gap-8">
            <ScoreRing score={a.score} label="On-page score" />
            <dl className="grid flex-1 grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-4">
              <Stat label="Words">{r.stats.wordCount}</Stat>
              <Stat label="Keyword uses">
                {r.stats.keywordCount} <span className="text-sm font-normal text-muted">({r.stats.densityPct}%)</span>
              </Stat>
              <Stat label="Readability">
                {r.stats.readability ?? "–"} {r.stats.readabilityLabel && <span className="text-sm font-normal text-muted">{r.stats.readabilityLabel}</span>}
              </Stat>
              <Stat label="Links in / out">
                {r.stats.inlinks ?? "?"} / {r.stats.internalLinks + r.stats.externalLinks}
              </Stat>
            </dl>
          </div>
        </Card>

        <Card>
          <h2 className="font-semibold">Search result preview</h2>
          <p className="mt-1 text-xs text-muted">Approximate: Google rewrites snippets and measures titles in pixels.</p>
          <div className="mt-4 max-w-[600px] rounded-xl border border-border bg-surface p-4" style={{ fontFamily: "Arial, sans-serif" }}>
            <div className="truncate text-xs text-foreground">{r.serp.breadcrumb}</div>
            <div className="mt-1 text-xl leading-snug text-[#1a0dab]">{r.serp.title}</div>
            <div className="mt-1 text-sm leading-relaxed text-[#4d5156]">{r.serp.description}</div>
          </div>
          {(r.serp.titleTruncated || r.serp.descriptionTruncated) && (
            <p className="mt-2 text-xs text-warning">
              {r.serp.titleTruncated && "The title is likely cut off. "}
              {r.serp.descriptionTruncated && "The description is likely cut off."}
            </p>
          )}
        </Card>

        <div className="grid gap-6 lg:grid-cols-2">
          {GROUPS.map((g) => {
            const checks = r.checks.filter((c) => c.group === g).sort((x, y) => order[x.status] - order[y.status]);
            if (!checks.length) return null;
            return (
              <Card key={g}>
                <h2 className="font-semibold">{g}</h2>
                <ul className="mt-3 flex flex-col gap-3 text-sm">
                  {checks.map((c) => (
                    <li key={c.id} className="flex gap-3">
                      <span className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-bold ${ICON[c.status].cls}`} aria-label={ICON[c.status].label} role="img">
                        {ICON[c.status].mark}
                      </span>
                      <span>
                        <span className="font-medium">{c.label}</span>
                        <span className="block text-muted">{c.message}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>
            );
          })}
        </div>

        <Card>
          <h2 className="font-semibold">What we read</h2>
          <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
            <dt className="text-muted">Title</dt>
            <dd>{r.page.title ?? <em className="text-danger">missing</em>}</dd>
            <dt className="text-muted">Meta description</dt>
            <dd>{r.page.metaDescription ?? <em className="text-danger">missing</em>}</dd>
            <dt className="text-muted">H1</dt>
            <dd>{r.page.h1.length ? r.page.h1.join(" | ") : <em className="text-danger">missing</em>}</dd>
            <dt className="text-muted">H2s</dt>
            <dd>{r.page.h2.length ? r.page.h2.join(" | ") : "—"}</dd>
            <dt className="text-muted">Canonical</dt>
            <dd className="break-all">{r.page.canonical ?? "—"}</dd>
          </dl>
        </Card>
      </div>
    </>
  );
}
