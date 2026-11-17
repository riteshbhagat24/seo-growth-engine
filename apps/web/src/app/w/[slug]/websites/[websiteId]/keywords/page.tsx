import Link from "next/link";
import { KeyRound, Plus, Upload } from "lucide-react";
import { can, getWebsite, INTENTS, keywordSuggestions, listKeywords, usageSummary } from "@sge/core";
import { ActionForm, SubmitButton } from "@/components/form";
import { Badge, Card, CardHeader, EmptyState, Field, fmtDate, fmtInt, fmtPct, fmtPos, Input, Select, Textarea } from "@/components/ui";
import { db } from "@/lib/db";
import { currentActor, requireWorkspace } from "@/lib/session";
import { addKeywordsAction, deleteKeywordsAction, importKeywordsAction, trackKeywordAction } from "./actions";

const INTENT_TONE: Record<string, "brand" | "neutral" | "success" | "warning"> = {
  informational: "neutral",
  navigational: "neutral",
  commercial: "brand",
  transactional: "success"
};

function PositionChange({ now, before }: { now: number | null; before: number | null }) {
  if (now === null || before === null) return null;
  const d = before - now; // positive = moved up
  if (Math.abs(d) < 0.1) return <span className="text-xs text-subtle">±0</span>;
  return (
    <span className={`text-xs font-medium ${d > 0 ? "text-success" : "text-danger"}`}>
      <span aria-hidden>{d > 0 ? "↑" : "↓"}</span>
      <span className="sr-only">{d > 0 ? "up" : "down"}</span>
      {Math.abs(d).toFixed(1)}
    </span>
  );
}

const path = (u: string) => {
  try {
    return new URL(u).pathname;
  } catch {
    return u;
  }
};

export default async function KeywordsPage({ params, searchParams }: PageProps<"/w/[slug]/websites/[websiteId]/keywords">) {
  const { slug, websiteId } = await params;
  const sp = await searchParams;
  const group = typeof sp.group === "string" && sp.group ? sp.group : null;
  const q = typeof sp.q === "string" && sp.q.trim() ? sp.q.trim().slice(0, 100) : null;
  const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
  const { website: w } = await getWebsite(db(), actor, access, websiteId);
  const canEdit = can(access.role, "work.run");
  const [list, suggestions, usage] = await Promise.all([
    listKeywords(db(), actor, access, w.id, { group, q }),
    keywordSuggestions(db(), actor, access, w.id, 25),
    can(access.role, "plan.view") ? usageSummary(db(), actor, access) : Promise.resolve(null)
  ]);
  const base = `/w/${slug}/websites/${w.id}/keywords`;
  const kwLimit = usage?.lines.find((l) => l.key === "keywords");
  const filtered = Boolean(group || q);

  const addForms = canEdit && (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader icon={<Plus className="size-4" />} title="Add keywords" description="One per line. Already-tracked keywords are skipped." />
        <ActionForm action={addKeywordsAction.bind(null, slug, w.id)} className="flex flex-col gap-3">
          <Field label="Keywords" htmlFor="keywords">
            <Textarea id="keywords" name="keywords" rows={4} required placeholder={"seo agency pune\nlocal seo services"} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Group" htmlFor="group">
              <Input id="group" name="group" maxLength={80} placeholder="Services" list="kw-groups" />
            </Field>
            <Field label="Tags" htmlFor="tags">
              <Input id="tags" name="tags" maxLength={200} placeholder="priority, brand" />
            </Field>
            <Field label="Intent" htmlFor="intent">
              <Select id="intent" name="intent" defaultValue="" className="w-full">
                <option value="">Not set</option>
                {INTENTS.map((i) => (
                  <option key={i} value={i} className="capitalize">
                    {i}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <datalist id="kw-groups">
            {list.groups.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
          <div>
            <SubmitButton pending="Adding…">Add keywords</SubmitButton>
          </div>
        </ActionForm>
      </Card>
      <Card>
        <CardHeader
          icon={<Upload className="size-4" />}
          title="Import CSV"
          description="Exports from Ahrefs, Semrush, Search Console, Keyword Planner, or a plain list. Columns are detected automatically."
        />
        <ActionForm action={importKeywordsAction.bind(null, slug, w.id)} className="flex flex-col gap-3">
          <Field label="CSV file" htmlFor="file" hint="Keyword, Group / Parent topic, Tags, URL, Intent, Volume, KD. Max 5,000 rows.">
            <Input id="file" name="file" type="file" accept=".csv,text/csv,text/plain" required className="py-1.5" />
          </Field>
          <Field label="Source of volume / difficulty" htmlFor="source" hint="Required if the file has volume or difficulty; shown next to those numbers.">
            <Input id="source" name="source" maxLength={60} placeholder="e.g. Ahrefs export, Nov 2026" />
          </Field>
          <div>
            <SubmitButton variant="secondary" pending="Importing…">
              Import
            </SubmitButton>
          </div>
        </ActionForm>
      </Card>
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      {list.rows.length === 0 && !filtered ? (
        <EmptyState icon={<KeyRound className="size-5" />} title="Track the keywords that matter">
          Add the searches you want to rank for. Clicks, impressions and average position come from Google Search Console; volume and difficulty only appear if
          you import them, labelled with their source.
        </EmptyState>
      ) : (
        <Card className="p-0 sm:p-0">
          <div className="flex flex-wrap items-end justify-between gap-3 p-5 pb-4 sm:p-6 sm:pb-4">
            <div>
              <h2 className="font-semibold">
                Tracked keywords <span className="font-normal text-muted">({list.rows.length}{kwLimit && kwLimit.limit > 0 ? ` of ${fmtInt(kwLimit.limit)} on your plan` : ""})</span>
              </h2>
              <p className="mt-1 text-sm text-muted">
                {list.period ? `Search Console, ${fmtDate(list.period.start)} – ${fmtDate(list.period.end)} vs the 28 days before.` : "Link Search Console in Settings to see positions and clicks."}
              </p>
            </div>
            <form className="flex flex-wrap items-end gap-2" role="search">
              <label className="sr-only" htmlFor="kw-q">
                Search keywords
              </label>
              <Input id="kw-q" name="q" defaultValue={q ?? ""} placeholder="Search…" className="w-44" />
              {list.groups.length > 0 && (
                <>
                  <label className="sr-only" htmlFor="kw-group">
                    Group
                  </label>
                  <Select id="kw-group" name="group" defaultValue={group ?? ""}>
                    <option value="">All groups</option>
                    {list.groups.map((g) => (
                      <option key={g} value={g}>
                        {g}
                      </option>
                    ))}
                  </Select>
                </>
              )}
              <button type="submit" className="h-9 rounded-lg border border-border-strong bg-surface px-3 text-sm shadow-card hover:bg-surface-2">
                Filter
              </button>
              {filtered && (
                <Link href={base} className="px-2 pb-2 text-sm text-muted hover:text-foreground">
                  Clear
                </Link>
              )}
            </form>
          </div>
          <ActionForm action={deleteKeywordsAction.bind(null, slug, w.id)} confirm="Stop tracking the selected keywords?">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-y border-border bg-surface-2 text-xs text-muted">
                  <tr>
                    {canEdit && (
                      <th className="w-10 py-2.5 pl-6">
                        <span className="sr-only">Select</span>
                      </th>
                    )}
                    <th className="px-4 py-2.5 font-medium">Keyword</th>
                    <th className="px-4 py-2.5 text-right font-medium">Position</th>
                    <th className="px-4 py-2.5 text-right font-medium">Clicks</th>
                    <th className="px-4 py-2.5 text-right font-medium">Impressions</th>
                    <th className="px-4 py-2.5 text-right font-medium">CTR</th>
                    <th className="px-4 py-2.5 font-medium">Ranking page</th>
                    <th className="px-4 py-2.5 text-right font-medium">Volume</th>
                    <th className="px-6 py-2.5 text-right font-medium">KD</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {list.rows.map((k) => (
                    <tr key={k.id} className="hover:bg-surface-2">
                      {canEdit && (
                        <td className="py-2 pl-6">
                          <input type="checkbox" name="id" value={k.id} aria-label={`Select ${k.keyword}`} className="size-4 accent-[var(--brand)]" />
                        </td>
                      )}
                      <td className="max-w-[300px] px-4 py-2">
                        <Link href={`${base}/${k.id}`} className="font-medium hover:text-brand hover:underline">
                          {k.keyword}
                        </Link>
                        <div className="mt-0.5 flex flex-wrap gap-1">
                          {k.groupName && <Badge>{k.groupName}</Badge>}
                          {k.intent && <Badge tone={INTENT_TONE[k.intent]}>{k.intent}</Badge>}
                          {k.tags.map((t) => (
                            <span key={t} className="text-xs text-subtle">
                              #{t}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        <span className="font-medium">{fmtPos(k.position)}</span> <PositionChange now={k.position} before={k.prevPosition} />
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">{fmtInt(k.clicks)}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-muted">{fmtInt(k.impressions)}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-muted">{k.impressions ? fmtPct(k.ctr) : "–"}</td>
                      <td className="max-w-[200px] truncate px-4 py-2 text-muted" title={k.rankingPage ?? undefined}>
                        {k.rankingPage ? path(k.rankingPage) : "–"}
                        {k.targetUrl && k.rankingPage && k.rankingPage !== k.targetUrl && (
                          <span className="ml-1 text-xs text-warning" title={`Target: ${k.targetUrl}`}>
                            ≠ target
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-muted" title={k.volumeSource ? `Source: ${k.volumeSource}` : undefined}>
                        {k.volume !== null ? fmtInt(k.volume) : "–"}
                      </td>
                      <td className="px-6 py-2 text-right tabular-nums text-muted" title={k.difficultySource ? `Source: ${k.difficultySource}` : undefined}>
                        {k.difficulty ?? "–"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {list.rows.length === 0 && <p className="p-6 text-sm text-subtle">No keywords match this filter.</p>}
            </div>
            {canEdit && list.rows.length > 0 && (
              <div className="border-t border-border px-6 py-3">
                <SubmitButton variant="ghost" size="sm" pending="Removing…">
                  Remove selected
                </SubmitButton>
              </div>
            )}
          </ActionForm>
        </Card>
      )}

      {suggestions.length > 0 && (
        <Card className="p-0 sm:p-0">
          <div className="p-5 pb-3 sm:p-6 sm:pb-3">
            <CardHeader title="Suggestions from Search Console" description="Queries you already appear for (last 28 days) that aren't tracked yet." />
          </div>
          <table className="w-full text-left text-sm">
            <thead className="border-y border-border bg-surface-2 text-xs text-muted">
              <tr>
                <th className="px-6 py-2.5 font-medium">Query</th>
                <th className="px-4 py-2.5 text-right font-medium">Impressions</th>
                <th className="px-4 py-2.5 text-right font-medium">Clicks</th>
                <th className="px-4 py-2.5 text-right font-medium">Position</th>
                {canEdit && <th className="px-6 py-2.5"><span className="sr-only">Track</span></th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {suggestions.map((s) => (
                <tr key={s.query} className="hover:bg-surface-2">
                  <td className="max-w-[360px] truncate px-6 py-2">{s.query}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{fmtInt(s.impressions)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-muted">{fmtInt(s.clicks)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-muted">{fmtPos(s.position)}</td>
                  {canEdit && (
                    <td className="px-6 py-1.5 text-right">
                      <ActionForm compact action={trackKeywordAction.bind(null, slug, w.id, s.query)}>
                        <SubmitButton size="sm" variant="secondary" pending="…">
                          Track
                        </SubmitButton>
                      </ActionForm>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {addForms}
    </div>
  );
}
