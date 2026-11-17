import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, can, getWebsite, isUuidLike, listOnpage } from "@sge/core";
import { scoreTone } from "@/components/audit-ui";
import { ActionForm, SubmitButton } from "@/components/form";
import { Card, Field, Input, PageHeader } from "@/components/ui";
import { db } from "@/lib/db";
import { currentActor, requireWorkspace } from "@/lib/session";
import { analyzePageAction } from "../audits/actions";

export const maxDuration = 60;

export default async function OnPageIndex({ params, searchParams }: PageProps<"/w/[slug]/websites/[websiteId]/onpage">) {
  const { slug, websiteId } = await params;
  const sp = await searchParams;
  if (!isUuidLike(websiteId)) notFound();
  const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
  const { website: w } = await getWebsite(db(), actor, access, websiteId).catch((e) => {
    if (e instanceof AppError && e.code === "not_found") notFound();
    throw e;
  });
  const history = await listOnpage(db(), actor, access, websiteId, 30);
  const canRun = can(access.role, "work.run");

  return (
    <>
      <Link href={`/w/${slug}/websites/${websiteId}`} className="text-sm text-muted hover:text-foreground">
        ← {w.displayName ?? w.domain}
      </Link>
      <div className="mt-3">
        <PageHeader
          title="On-page analysis"
          description="Score one page against the keyword it should rank for: placement, content, meta tags, links and technical basics. Runs on our own engine; no external APIs."
        />
      </div>
      <div className="flex flex-col gap-6">
        {canRun && (
          <Card>
            <ActionForm action={analyzePageAction.bind(null, slug, websiteId)} className="grid gap-4 sm:grid-cols-[1.4fr_1fr_auto] sm:items-end">
              <Field label="Page" htmlFor="page" hint={`A path like /services or a full URL on ${w.domain}`}>
                <Input id="page" name="page" defaultValue={typeof sp.page === "string" ? sp.page : "/"} required maxLength={2000} />
              </Field>
              <Field label="Target keyword" htmlFor="keyword" hint="The search phrase this page should rank for">
                <Input id="keyword" name="keyword" required minLength={2} maxLength={80} placeholder="e.g. seo agency in pune" defaultValue={typeof sp.keyword === "string" ? sp.keyword : ""} />
              </Field>
              <SubmitButton pending="Analysing…">Analyse page</SubmitButton>
            </ActionForm>
          </Card>
        )}
        <Card className="p-0">
          <h2 className="border-b border-border px-6 py-4 font-semibold">Recent analyses</h2>
          {history.length === 0 ? (
            <p className="p-6 text-sm text-muted">No analyses yet.</p>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {history.map((h) => (
                <li key={h.id}>
                  <Link href={`/w/${slug}/websites/${websiteId}/onpage/${h.id}`} className="flex items-center gap-4 px-6 py-3 hover:bg-background">
                    <span className={`w-10 text-right text-lg font-semibold tabular-nums ${scoreTone(h.score)}`}>{h.score}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{new URL(h.url).pathname}</span>
                      <span className="block truncate text-xs text-muted">“{h.keyword}”</span>
                    </span>
                    <span className="text-xs text-muted">{h.createdAt.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
