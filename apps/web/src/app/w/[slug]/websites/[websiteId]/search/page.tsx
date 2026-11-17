import { Search } from "lucide-react";
import { can, getWebsite, getWebsiteGoogle, parseRange, RANGES, searchPerformance } from "@sge/core";
import { TimeSeriesChart } from "@/components/charts";
import { BarList } from "@/components/data-ui";
import { ActionForm, SubmitButton } from "@/components/form";
import { Card, CardHeader, Change, EmptyState, fmtCompact, fmtDate, fmtInt, fmtPct, fmtPos, Kpi, LinkButton, Segmented } from "@/components/ui";
import { db } from "@/lib/db";
import { currentActor, requireWorkspace } from "@/lib/session";
import { trackKeywordAction } from "../keywords/actions";

const RANGE_LABELS: Record<string, string> = { "7d": "7 days", "28d": "28 days", "3m": "3 months", "6m": "6 months", "12m": "12 months", "16m": "16 months" };

const pagePath = (u: string) => {
  try {
    const x = new URL(u);
    return `${x.pathname}${x.search}` || "/";
  } catch {
    return u;
  }
};

export default async function SearchPage({ params, searchParams }: PageProps<"/w/[slug]/websites/[websiteId]/search">) {
  const { slug, websiteId } = await params;
  const sp = await searchParams;
  const range = parseRange(sp.range);
  const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
  const { website: w } = await getWebsite(db(), actor, access, websiteId);
  const [linked, p] = await Promise.all([getWebsiteGoogle(db(), actor, access, w.id), searchPerformance(db(), actor, access, w.id, range)]);
  const base = `/w/${slug}/websites/${w.id}`;
  const canTrack = can(access.role, "work.run");

  if (!p.hasData)
    return (
      <EmptyState
        icon={<Search className="size-5" />}
        title={linked?.gscProperty ? "Importing Search Console data…" : "Connect Google Search Console"}
        action={
          can(access.role, "websites.manage") && !linked?.gscProperty ? (
            <LinkButton href={`${base}/settings#google`}>Link Search Console</LinkButton>
          ) : undefined
        }
      >
        {linked?.gscProperty
          ? "The last 28 days arrive first, usually within a minute or two; up to 16 months of history follows. Refresh this page shortly."
          : "See the clicks, impressions, queries and average positions Google reports for this website. Free and read-only."}
        {linked?.gscError && <span className="mt-2 block text-danger">{linked.gscError}</span>}
      </EmptyState>
    );

  const t = p.totals;
  const prev = p.previous;
  const series = (k: "clicks" | "impressions" | "ctr" | "position") => p.series.map((d) => ({ x: d.date, y: k === "position" && d.impressions === 0 ? null : d[k] }));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          Google Search · {fmtDate(p.range.start)} – {fmtDate(p.range.end)}
          {prev && <span className="text-subtle"> · compared with the previous {RANGE_LABELS[range]}</span>}
        </p>
        <Segmented
          label="Date range"
          current={range}
          items={(Object.keys(RANGES) as (keyof typeof RANGES)[]).map((k) => ({ key: k, label: RANGE_LABELS[k]!, href: `${base}/search?range=${k}` }))}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label="Clicks" value={fmtCompact(t.clicks)} change={<Change current={t.clicks} previous={prev?.clicks} />} />
        <Kpi label="Impressions" value={fmtCompact(t.impressions)} change={<Change current={t.impressions} previous={prev?.impressions} />} />
        <Kpi label="Average CTR" value={fmtPct(t.ctr)} change={<Change current={t.ctr} previous={prev?.ctr} />} />
        <Kpi
          label="Average position"
          value={fmtPos(t.position)}
          change={prev ? <Change current={t.position} previous={prev.position} invert format="abs" /> : undefined}
          foot="Lower is better"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Clicks" />
          <TimeSeriesChart data={series("clicks")} label="Clicks" />
        </Card>
        <Card>
          <CardHeader title="Impressions" />
          <TimeSeriesChart data={series("impressions")} label="Impressions" />
        </Card>
        <Card>
          <CardHeader title="Click-through rate" />
          <TimeSeriesChart data={series("ctr")} label="CTR" format="pct" />
        </Card>
        <Card>
          <CardHeader title="Average position" description="Top of the chart = better ranking." />
          <TimeSeriesChart data={series("position")} label="Average position" format="pos" invert area={false} zeroBased={false} />
        </Card>
      </div>

      <Card className="p-0 sm:p-0">
        <div className="p-5 pb-3 sm:p-6 sm:pb-3">
          <CardHeader title="Top queries" description="What people searched before seeing or clicking your site. Track a query to follow it in Keywords." />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-y border-border bg-surface-2 text-xs text-muted">
              <tr>
                <th className="px-6 py-2.5 font-medium">Query</th>
                <th className="px-4 py-2.5 text-right font-medium">Clicks</th>
                <th className="px-4 py-2.5 text-right font-medium">Impressions</th>
                <th className="px-4 py-2.5 text-right font-medium">CTR</th>
                <th className="px-4 py-2.5 text-right font-medium">Position</th>
                {canTrack && <th className="px-6 py-2.5 font-medium"><span className="sr-only">Track</span></th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {p.queries.slice(0, 50).map((q) => (
                <tr key={q.key} className="hover:bg-surface-2">
                  <td className="max-w-[360px] truncate px-6 py-2" title={q.key}>
                    {q.key}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{fmtInt(q.clicks)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-muted">{fmtInt(q.impressions)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-muted">{fmtPct(q.ctr)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{fmtPos(q.position)}</td>
                  {canTrack && (
                    <td className="px-6 py-1.5 text-right">
                      <ActionForm compact action={trackKeywordAction.bind(null, slug, w.id, q.key)}>
                        <SubmitButton size="sm" variant="ghost" pending="…">
                          Track
                        </SubmitButton>
                      </ActionForm>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {p.queries.length === 0 && <p className="p-6 text-sm text-subtle">No query data in this period (Google hides rare and personal queries).</p>}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Top pages" />
          <BarList
            valueLabel="Clicks"
            rows={p.pages.slice(0, 15).map((x) => ({ key: x.key, label: pagePath(x.key), title: x.key, value: x.clicks }))}
            extra={[{ label: "Impr.", render: (k) => fmtCompact(p.pages.find((x) => x.key === k)?.impressions ?? 0) }]}
          />
        </Card>
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader title="Devices" />
            <BarList
              valueLabel="Clicks"
              rows={p.devices.map((d) => ({ key: d.key, label: <span className="capitalize">{d.key}</span>, value: d.clicks }))}
              extra={[{ label: "CTR", render: (k) => fmtPct(p.devices.find((d) => d.key === k)?.ctr ?? 0) }]}
            />
          </Card>
          <Card>
            <CardHeader title="Countries" />
            <BarList
              valueLabel="Clicks"
              rows={p.countries.map((c) => ({ key: c.key, label: c.key.toUpperCase(), value: c.clicks }))}
              extra={[{ label: "Impr.", render: (k) => fmtCompact(p.countries.find((c) => c.key === k)?.impressions ?? 0) }]}
            />
          </Card>
        </div>
      </div>
      <p className="text-xs text-subtle">
        Source: Google Search Console (final data, ~3 days delay). Totals include anonymised queries; query and page tables show the top rows only.
      </p>
    </div>
  );
}
