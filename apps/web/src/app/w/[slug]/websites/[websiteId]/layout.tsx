import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { AppError, can, getWebsite, isUuidLike } from "@sge/core";
import { TabNav } from "@/components/tab-nav";
import { VerificationBadge } from "@/components/verification-badge";
import { db } from "@/lib/db";
import { currentActor, requireWorkspace } from "@/lib/session";

export default async function WebsiteLayout({ children, params }: LayoutProps<"/w/[slug]/websites/[websiteId]">) {
  const { slug, websiteId } = await params;
  if (!isUuidLike(websiteId)) notFound();
  const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
  const { website: w, client } = await getWebsite(db(), actor, access, websiteId).catch((e) => {
    if (e instanceof AppError && e.code === "not_found") notFound();
    throw e;
  });
  const base = `/w/${slug}/websites/${w.id}`;
  const tabs = [
    { href: base, label: "Overview", exact: true },
    { href: `${base}/audits`, label: "Site audit" },
    { href: `${base}/keywords`, label: "Keywords" },
    { href: `${base}/search`, label: "Search performance" },
    { href: `${base}/traffic`, label: "Traffic" },
    { href: `${base}/onpage`, label: "On-page" },
    ...(can(access.role, "websites.manage") ? [{ href: `${base}/settings`, label: "Settings" }] : [])
  ];

  return (
    <div>
      <div className="mb-1 text-sm">
        <Link href={`/w/${slug}/websites`} className="text-muted hover:text-foreground">
          Websites
        </Link>
        <span className="mx-1.5 text-subtle">/</span>
        <span className="text-foreground">{w.domain}</span>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-border bg-surface text-base font-semibold text-brand shadow-card" aria-hidden>
          {w.domain.slice(0, 1).toUpperCase()}
        </span>
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-tight">{w.displayName ?? w.domain}</h1>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
            <a href={`${w.url}/`} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 hover:text-foreground">
              {w.url.replace(/^https?:\/\//, "")}
              <ExternalLink className="size-3.5" aria-hidden />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
            {client && <span>· {client.name}</span>}
            <VerificationBadge status={w.verificationStatus} />
          </div>
        </div>
      </div>
      <div className="mt-5 mb-6 border-b border-border">
        <TabNav items={tabs} label="Website sections" />
      </div>
      {children}
    </div>
  );
}
