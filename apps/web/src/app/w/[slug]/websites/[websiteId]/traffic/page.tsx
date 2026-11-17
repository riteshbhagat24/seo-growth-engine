import { LineChart } from "lucide-react";
import { can, getWebsite, getWebsiteGoogle, parseRange, trafficOverview } from "@sge/core";
import { TimeSeriesChart } from "@/components/charts";
import { BarList } from "@/components/data-ui";
import { Card, CardHeader, Change, EmptyState, fmtCompact, fmtDate, fmtPct, Kpi, LinkButton, Segmented } from "@/components/ui";
import { db } from "@/lib/db";
import { currentActor, requireWorkspace } from "@/lib/session";

const RANGES = { "7d": "7 days", "28d": "28 days", "3m": "90 days" } as const;

export default async function TrafficPage({ params, searchParams }: PageProps<"/w/[slug]/websites/[websiteId]/traffic">) {
  const { slug, websiteId } = await params;
  const sp = await searchParams;
  const range = parseRange(typeof sp.range === "string" && sp.range in RANGES ? sp.range : "28d");
  const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
  const { website: w } = await getWebsite(db(), actor, access, websiteId);
  const [linked, t] = await Promise.all([getWebsiteGoogle(db(), actor, access, w.id), trafficOverview(db(), actor, access, w.id, range)]);
  const base = `/w/${slug}/websites/${w.id}`;

  if (!t.hasData)
    return (
      <EmptyState
        icon={<LineChart className="size-5" />}
        title={linked?.ga4Property ? "Importing Analytics data…" : "Connect Google Analytics 4"}
        action={
          can(access.role, "websites.manage") && !linked?.ga4Property ? <LinkButton href={`${base}/settings#google`}>Link Analytics 4</LinkButton> : undefined
        }
      >
        {linked?.ga4Property
          ? "Recent days arrive first, then 90 days of history. Refresh this page shortly."
          : "See sessions, engagement and key events by source and landing page, including referral traffic from sites that link to you."}
        {linked?.ga4Error && <span className="mt-2 block text-danger">{linked.ga4Error}</span>}
      </EmptyState>
    );

  const cur = t.totals;
  const prev = t.previous;
  const rate = (x: { sessions: number; engagedSessions: number }) => (x.sessions ? x.engagedSessions / x.sessions : 0);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          Google Analytics 4{linked?.ga4PropertyName ? ` · ${linked.ga4PropertyName}` : ""} · {fmtDate(t.range.start)} – {fmtDate(t.range.end)}
        </p>
        <Segmented label="Date range" current={range} items={Object.entries(RANGES).map(([k, label]) => ({ key: k, label, href: `${base}/traffic?range=${k}` }))} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label="Sessions" value={fmtCompact(cur.sessions)} change={<Change current={cur.sessions} previous={prev?.sessions} />} />
        <Kpi label="Engaged sessions" value={fmtCompact(cur.engagedSessions)} change={<Change current={cur.engagedSessions} previous={prev?.engagedSessions} />} />
        <Kpi label="Engagement rate" value={fmtPct(rate(cur))} change={prev ? <Change current={rate(cur)} previous={rate(prev)} /> : undefined} />
        <Kpi label="Key events" value={fmtCompact(cur.keyEvents)} change={<Change current={cur.keyEvents} previous={prev?.keyEvents} />} foot="Conversions you marked in GA4" />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Sessions" />
          <TimeSeriesChart data={t.series.map((d) => ({ x: d.date, y: d.sessions }))} label="Sessions" />
        </Card>
        <Card>
          <CardHeader title="Key events" />
          <TimeSeriesChart data={t.series.map((d) => ({ x: d.date, y: d.keyEvents }))} label="Key events" format="dec" />
        </Card>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Source / medium" />
          <BarList
            valueLabel="Sessions"
            rows={t.channels.map((c) => ({ key: c.key, label: c.key, value: c.sessions }))}
            extra={[{ label: "Key ev.", render: (k) => fmtCompact(t.channels.find((c) => c.key === k)?.keyEvents ?? 0) }]}
          />
        </Card>
        <Card>
          <CardHeader title="Landing pages" />
          <BarList
            valueLabel="Sessions"
            rows={t.landingPages.map((c) => ({ key: c.key, label: c.key, title: c.key, value: c.sessions }))}
            extra={[{ label: "Eng. rate", render: (k) => fmtPct(rate(t.landingPages.find((c) => c.key === k) ?? { sessions: 0, engagedSessions: 0 })) }]}
          />
        </Card>
      </div>
      <Card>
        <CardHeader title="Referral traffic" description="Sessions from other websites linking to you. Backlink monitoring will tie these to verified links." />
        <BarList valueLabel="Sessions" rows={t.referrers.map((c) => ({ key: c.key, label: c.key, value: c.sessions }))} />
      </Card>
      <p className="text-xs text-subtle">Source: Google Analytics 4 Data API. The last 3 days are refreshed on every sync while GA4 finishes processing.</p>
    </div>
  );
}
