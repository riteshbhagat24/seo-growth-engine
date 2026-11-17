import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { AppError, getAuditIssues, isUuidLike } from "@sge/core";
import { CATEGORY_LABEL, RULES } from "@sge/seo-rules";
import { SeverityBadge } from "@/components/audit-ui";
import { Card, PageHeader } from "@/components/ui";
import { db } from "@/lib/db";
import { currentActor, requireWorkspace } from "@/lib/session";

const PAGE = 100;

const path = (u: string) => {
  try {
    const x = new URL(u);
    return `${x.pathname}${x.search}`;
  } catch {
    return u;
  }
};

function UrlList({ label, urls }: { label: string; urls: unknown }) {
  if (!Array.isArray(urls) || urls.length === 0) return null;
  return (
    <div>
      <span className="text-muted">{label}: </span>
      {urls.map((u, i) => {
        const url = typeof u === "string" ? u : String((u as { url?: string }).url ?? "");
        const status = typeof u === "object" && u && "status" in u ? (u as { status: number | null }).status : null;
        return (
          <span key={i}>
            {i > 0 && ", "}
            {/^https?:\/\//i.test(url) ? (
              <a href={url} target="_blank" rel="noreferrer noopener nofollow" className="break-all font-mono text-xs text-brand hover:underline">
                {url.length > 80 ? `${url.slice(0, 77)}…` : url}
              </a>
            ) : (
              // Only http(s) URLs become links (crawled pages can contain anything).
              <span className="break-all font-mono text-xs">{url.slice(0, 80)}</span>
            )}
            {status !== null && <span className="text-muted"> ({status})</span>}
          </span>
        );
      })}
    </div>
  );
}

/** Human-readable details for an issue's `details` object. */
function Details({ d }: { d: Record<string, unknown> | null }) {
  if (!d) return null;
  const parts: ReactNode[] = [];
  const kv = (label: string, v: unknown, unit = "") => v !== undefined && v !== null && parts.push(<div key={label}><span className="text-muted">{label}: </span>{String(v)}{unit}</div>);
  kv("HTTP status", d.status);
  kv("Error", d.error);
  kv("Title", d.title);
  kv("Length", d.length, " characters");
  kv("Words", d.words);
  kv("Response time", d.ms, " ms");
  if (typeof d.bytes === "number") kv("Size", `${Math.round(d.bytes / 1024)} KB`);
  kv("Clicks from homepage", d.clicks);
  kv("Canonical", d.canonical);
  kv("Redirects to", d.redirectsTo ?? d.to);
  if (typeof d.count === "number" && (d.targets || d.examples || d.resources)) kv("Count", d.count);
  if (typeof d.total === "number") kv("Images on page", d.total);
  if (Array.isArray(d.missing)) kv("Missing", d.missing.join(", "));
  if (Array.isArray(d.codes)) kv("Codes", d.codes.join(", "));
  if (Array.isArray(d.headings)) kv("H1s", d.headings.join(" | "));
  if (Array.isArray(d.chain)) kv("Chain", (d.chain as string[]).map(path).join(" → "));
  parts.push(<UrlList key="targets" label="Links to" urls={d.targets} />);
  parts.push(<UrlList key="linkedFrom" label="Linked from" urls={d.linkedFrom} />);
  parts.push(<UrlList key="others" label="Same as" urls={d.others} />);
  parts.push(<UrlList key="examples" label="Images" urls={d.examples} />);
  parts.push(<UrlList key="resources" label="Insecure resources" urls={d.resources} />);
  parts.push(<UrlList key="alternates" label="Alternates without a return link" urls={d.alternates} />);
  return <div className="mt-1 flex flex-col gap-0.5 text-xs">{parts}</div>;
}

export default async function IssuePage({ params, searchParams }: PageProps<"/w/[slug]/websites/[websiteId]/audits/[auditId]/issues/[rule]">) {
  const { slug, websiteId, auditId, rule: code } = await params;
  const sp = await searchParams;
  const rule = RULES[code];
  if (!isUuidLike(websiteId) || !isUuidLike(auditId) || !rule) notFound();
  const offset = Math.max(0, Number.parseInt(String(sp.offset ?? "0"), 10) || 0);
  const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
  const issues = await getAuditIssues(db(), actor, access, auditId, code, { limit: PAGE + 1, offset }).catch((e) => {
    if (e instanceof AppError && e.code === "not_found") notFound();
    throw e;
  });
  const more = issues.length > PAGE;
  const base = `/w/${slug}/websites/${websiteId}/audits/${auditId}`;

  return (
    <>
      <Link href={base} className="text-sm text-muted hover:text-foreground">
        ← Audit
      </Link>
      <div className="mt-3">
        <PageHeader title={rule.title} description={CATEGORY_LABEL[rule.category]} actions={<SeverityBadge severity={rule.severity} />} />
      </div>
      <div className="flex flex-col gap-6">
        <Card>
          <div className="grid gap-6 text-sm md:grid-cols-2">
            <div>
              <h2 className="font-semibold">Why it matters</h2>
              <p className="mt-1 text-muted">{rule.explanation}</p>
            </div>
            <div>
              <h2 className="font-semibold">How to fix it</h2>
              <p className="mt-1 text-muted">{rule.howToFix}</p>
            </div>
          </div>
        </Card>
        <Card className="p-0">
          {issues.length === 0 ? (
            <p className="p-6 text-sm text-muted">No pages are affected in this audit.</p>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {issues.slice(0, PAGE).map((i) => (
                <li key={i.id} className="px-6 py-3">
                  {i.url ? (
                    <a href={i.url} target="_blank" rel="noreferrer noopener nofollow" className="break-all font-medium hover:text-brand hover:underline">
                      {i.url}
                    </a>
                  ) : (
                    <span className="font-medium">Site-wide</span>
                  )}
                  <Details d={i.details} />
                </li>
              ))}
            </ul>
          )}
          {(offset > 0 || more) && (
            <div className="flex justify-between border-t border-border px-6 py-3 text-sm">
              {offset > 0 ? <Link href={`?offset=${Math.max(0, offset - PAGE)}`} className="text-brand hover:underline">← Previous</Link> : <span />}
              {more && <Link href={`?offset=${offset + PAGE}`} className="text-brand hover:underline">Next →</Link>}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
