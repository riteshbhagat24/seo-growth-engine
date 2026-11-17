import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, can, INTENTS, isUuidLike, keywordHistory } from "@sge/core";
import { TimeSeriesChart } from "@/components/charts";
import { BarList } from "@/components/data-ui";
import { ActionForm, SubmitButton } from "@/components/form";
import { Badge, Card, CardHeader, Field, fmtInt, Input, Kpi, Select, Textarea } from "@/components/ui";
import { db } from "@/lib/db";
import { currentActor, requireWorkspace } from "@/lib/session";
import { deleteOneKeywordAction, updateKeywordAction } from "../actions";

export default async function KeywordPage({ params }: PageProps<"/w/[slug]/websites/[websiteId]/keywords/[keywordId]">) {
  const { slug, websiteId, keywordId } = await params;
  if (!isUuidLike(keywordId)) notFound();
  const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
  const h = await keywordHistory(db(), actor, access, keywordId).catch((e) => {
    if (e instanceof AppError && e.code === "not_found") notFound();
    throw e;
  });
  const k = h.keyword;
  if (k.websiteId !== websiteId) notFound();
  const canEdit = can(access.role, "work.run");
  const recent = h.weeks.slice(-13);
  const sum = (xs: typeof recent, f: "clicks" | "impressions") => xs.reduce((n, x) => n + x[f], 0);
  const imp = sum(recent, "impressions");
  const pos = imp ? recent.reduce((n, x) => n + (x.position ?? 0) * x.impressions, 0) / imp : null;
  const best = h.weeks.filter((x) => x.position !== null).reduce<number | null>((m, x) => (m === null || x.position! < m ? x.position : m), null);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href={`/w/${slug}/websites/${websiteId}/keywords`} className="text-sm text-muted hover:text-foreground">
          ← All keywords
        </Link>
        <h2 className="mt-2 text-xl font-semibold">“{k.keyword}”</h2>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {k.groupName && <Badge>{k.groupName}</Badge>}
          {k.intent && <Badge tone="brand">{k.intent}</Badge>}
          {k.volume !== null && <Badge>Volume {fmtInt(k.volume)}{k.volumeSource ? ` · ${k.volumeSource}` : ""}</Badge>}
          {k.difficulty !== null && <Badge>KD {k.difficulty}{k.difficultySource ? ` · ${k.difficultySource}` : ""}</Badge>}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Kpi label="Avg position (last 13 weeks)" value={pos ? pos.toFixed(1) : "–"} foot="Search Console average; lower is better" />
        <Kpi label="Clicks (last 13 weeks)" value={fmtInt(sum(recent, "clicks"))} />
        <Kpi label="Best weekly position" value={best ? best.toFixed(1) : "–"} />
      </div>

      {h.weeks.length > 1 ? (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader title="Average position by week" description="Top of the chart = better ranking." />
            <TimeSeriesChart data={h.weeks.map((x) => ({ x: x.week, y: x.position }))} label="Average position" format="pos" invert area={false} zeroBased={false} />
          </Card>
          <Card>
            <CardHeader title="Clicks by week" />
            <TimeSeriesChart data={h.weeks.map((x) => ({ x: x.week, y: x.clicks }))} label="Clicks" />
          </Card>
        </div>
      ) : (
        <Card>
          <p className="text-sm text-muted">No Search Console data for this keyword yet. It appears once Google shows your site for this search.</p>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Pages ranking for it" description="Last 90 days of data." />
          <BarList valueLabel="Clicks" rows={h.pages.map((p) => ({ key: p.page, label: new URL(p.page).pathname, title: p.page, value: p.clicks }))} />
          {k.targetUrl && <p className="mt-3 text-xs text-muted">Target page: {k.targetUrl}</p>}
        </Card>
        {canEdit && (
          <Card>
            <CardHeader title="Details" />
            <ActionForm action={updateKeywordAction.bind(null, slug, websiteId, k.id)} className="flex flex-col gap-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Group" htmlFor="group">
                  <Input id="group" name="group" defaultValue={k.groupName ?? ""} maxLength={80} />
                </Field>
                <Field label="Intent" htmlFor="intent">
                  <Select id="intent" name="intent" defaultValue={k.intent ?? ""} className="w-full">
                    <option value="">Not set</option>
                    {INTENTS.map((i) => (
                      <option key={i} value={i}>
                        {i}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <Field label="Tags" htmlFor="tags" hint="Comma-separated">
                <Input id="tags" name="tags" defaultValue={k.tags.join(", ")} maxLength={200} />
              </Field>
              <Field label="Target page" htmlFor="targetUrl" hint="The page you want to rank (path or full URL on this site)">
                <Input id="targetUrl" name="targetUrl" defaultValue={k.targetUrl ?? ""} maxLength={2000} />
              </Field>
              <Field label="Notes" htmlFor="notes">
                <Textarea id="notes" name="notes" defaultValue={k.notes ?? ""} rows={3} maxLength={2000} />
              </Field>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <SubmitButton pending="Saving…">Save</SubmitButton>
              </div>
            </ActionForm>
            <ActionForm action={deleteOneKeywordAction.bind(null, slug, websiteId, k.id)} confirm={`Stop tracking “${k.keyword}”?`} className="mt-3">
              <SubmitButton variant="ghost" size="sm">
                Stop tracking
              </SubmitButton>
            </ActionForm>
          </Card>
        )}
      </div>
    </div>
  );
}
