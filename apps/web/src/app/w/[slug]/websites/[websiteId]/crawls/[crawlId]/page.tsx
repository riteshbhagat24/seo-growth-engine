import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, can, getCrawl, isUuidLike } from "@sge/core";
import type { CrawlPage } from "@sge/db/schema";
import { CrawlStatus } from "@/components/crawl-status";
import { ActionForm, SubmitButton } from "@/components/form";
import { LiveCrawl } from "@/components/live-crawl";
import { Alert, Card, PageHeader } from "@/components/ui";
import { db } from "@/lib/db";
import { currentActor, requireWorkspace } from "@/lib/session";
import { cancelCrawlAction } from "../actions";

export const maxDuration = 60;

const FILTERS: { key: CrawlPage["status"] | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "fetched", label: "Fetched" },
  { key: "error", label: "Errors" },
  { key: "skipped", label: "Skipped" },
  { key: "queued", label: "Queued" }
];

export default async function CrawlPage({ params, searchParams }: PageProps<"/w/[slug]/websites/[websiteId]/crawls/[crawlId]">) {
  const { slug, websiteId, crawlId } = await params;
  const sp = await searchParams;
  if (!isUuidLike(websiteId) || !isUuidLike(crawlId)) notFound();
  const filter = FILTERS.find((f) => f.key === sp.status)?.key ?? "all";
  const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
  const d = await getCrawl(db(), actor, access, crawlId, { status: filter === "all" ? undefined : filter, limit: 500 }).catch((e) => {
    if (e instanceof AppError && e.code === "not_found") notFound();
    throw e;
  });
  const { crawl: c, counts, pages } = d;
  if (c.websiteId !== websiteId) notFound();
  const active = c.status === "queued" || c.status === "running";
  const done = counts.fetched + counts.error + counts.skipped;
  const total = Math.max(1, done + counts.queued);
  const pct = c.status === "completed" ? 100 : Math.round((done / total) * 100);
  const base = `/w/${slug}/websites/${websiteId}/crawls/${crawlId}`;

  return (
    <>
      <LiveCrawl url={`/api/w/${slug}/crawls/${crawlId}`} active={active} />
      <Link href={`/w/${slug}/websites/${websiteId}/audits`} className="text-sm text-muted hover:text-foreground">
        ← Site audit
      </Link>
      <div className="mt-3">
        <PageHeader
          title={`Crawl of ${new URL(c.startUrl).hostname}`}
          description={`Started ${c.createdAt.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })} · up to ${c.maxPages} pages`}
          actions={<CrawlStatus status={c.status} />}
        />
      </div>

      <div className="flex flex-col gap-6">
        {c.error && <Alert tone="error">{c.error}</Alert>}
        {c.maxPages <= 25 && <Alert>This website isn't verified yet, so crawls are limited to {c.maxPages} pages. Verify ownership to crawl up to 500.</Alert>}

        <Card>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm sm:grid-cols-4">
              {[
                ["Fetched", counts.fetched],
                ["Errors", counts.error],
                ["Skipped", counts.skipped],
                ["Waiting", counts.queued]
              ].map(([k, v]) => (
                <div key={k}>
                  <dt className="text-muted">{k}</dt>
                  <dd className="text-2xl font-semibold">{v}</dd>
                </div>
              ))}
            </dl>
            {active && can(access.role, "work.run") && (
              <ActionForm action={cancelCrawlAction.bind(null, slug, websiteId, crawlId)} confirm="Stop this crawl?">
                <SubmitButton variant="secondary">Stop crawl</SubmitButton>
              </ActionForm>
            )}
          </div>
          <div className="mt-5 h-2 overflow-hidden rounded-full bg-background" role="progressbar" aria-label="Crawl progress" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${pct}%` }} />
          </div>
          <p className="mt-3 text-xs text-muted">
            robots.txt: {c.robotsStatus === null ? "not checked yet" : c.robotsStatus === 200 ? "found and respected" : c.robotsStatus === 404 ? "none (everything allowed)" : `HTTP ${c.robotsStatus}`}
            {c.sitemapUrls > 0 && ` · ${c.sitemapUrls} URLs listed in sitemaps`} · at least {c.crawlDelayMs / 1000}s between requests
            {active && " · this page updates automatically"}
          </p>
        </Card>

        <Card className="p-0 sm:p-0">
          <nav className="flex flex-wrap gap-1 border-b border-border px-4 py-3 text-sm" aria-label="Filter pages">
            {FILTERS.map((f) => (
              <Link
                key={f.key}
                href={f.key === "all" ? base : `${base}?status=${f.key}`}
                aria-current={filter === f.key ? "page" : undefined}
                className="rounded-lg px-3 py-1.5 text-muted hover:bg-surface-2 hover:text-foreground aria-[current=page]:bg-surface-2 aria-[current=page]:font-medium aria-[current=page]:text-foreground"
              >
                {f.label}
              </Link>
            ))}
          </nav>
          {pages.length === 0 ? (
            <p className="p-6 text-sm text-muted">No pages here yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-border text-xs uppercase tracking-wider text-muted">
                  <tr>
                    <th className="px-6 py-3 font-medium">Page</th>
                    <th className="px-6 py-3 font-medium">Status</th>
                    <th className="px-6 py-3 font-medium">Depth</th>
                    <th className="px-6 py-3 font-medium">Time</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {pages.map((p) => (
                    <tr key={p.id}>
                      <td className="max-w-[520px] px-6 py-2">
                        <div className="truncate font-medium">{p.title ?? new URL(p.url).pathname}</div>
                        <div className="truncate text-xs text-muted">{p.url}</div>
                        {p.finalUrl && <div className="truncate text-xs text-muted">→ {p.finalUrl}</div>}
                      </td>
                      <td className="px-6 py-2">
                        {p.status === "fetched" ? (
                          <span className={p.httpStatus && p.httpStatus >= 400 ? "text-danger" : ""}>{p.httpStatus}</span>
                        ) : p.status === "error" ? (
                          <span className="text-danger">{p.error}</span>
                        ) : p.status === "skipped" ? (
                          <span className="text-muted">{p.skipReason}</span>
                        ) : (
                          <span className="text-muted">Waiting</span>
                        )}
                      </td>
                      <td className="px-6 py-2 text-muted">{p.depth}</td>
                      <td className="px-6 py-2 text-muted">{p.durationMs != null ? `${p.durationMs} ms` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
