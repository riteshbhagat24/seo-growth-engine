import Link from "next/link";
import type { CSSProperties } from "react";
import { can, getProductSettings, listMyWorkspaces, ROLE_LABEL } from "@sge/core";
import { db } from "@/lib/db";
import { requireUser, requireWorkspace } from "@/lib/session";
import { SignOutButton } from "@/components/sign-out-button";

export default async function WorkspaceLayout({ children, params }: LayoutProps<"/w/[slug]">) {
  const { slug } = await params;
  const user = await requireUser(`/w/${slug}`);
  const access = await requireWorkspace(slug);
  const [workspaces, product] = await Promise.all([listMyWorkspaces(db(), user.id), getProductSettings(db())]);
  const ws = access.workspace;
  const theme = {
    "--brand": ws.branding.primary ?? product.primary,
    "--accent": ws.branding.accent ?? product.accent
  } as CSSProperties;

  const nav = [
    { href: `/w/${slug}`, label: "Overview", show: true },
    { href: `/w/${slug}/websites`, label: "Websites", show: true },
    { href: `/w/${slug}/clients`, label: "Clients", show: ws.type === "agency" },
    { href: `/w/${slug}/settings`, label: "Settings", show: can(access.role, "workspace.update") || can(access.role, "branding.manage") },
    { href: `/w/${slug}/settings/members`, label: "Members", show: can(access.role, "members.view") },
    { href: `/w/${slug}/settings/jobs`, label: "Jobs", show: can(access.role, "work.run") },
    { href: `/w/${slug}/settings/usage`, label: "Plan & usage", show: can(access.role, "plan.view") },
    { href: `/w/${slug}/settings/audit`, label: "Audit log", show: can(access.role, "audit.view") }
  ].filter((n) => n.show);

  return (
    <div style={theme} className="flex min-h-full flex-1 flex-col">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3 sm:px-6">
          <Link href={`/w/${slug}`} className="flex items-center gap-2 font-semibold">
            {ws.branding.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- arbitrary https logo URLs
              <img src={ws.branding.logoUrl} alt="" className="h-7 w-auto max-w-[120px] object-contain" />
            ) : (
              <span className="grid size-7 place-items-center rounded-md bg-brand text-xs font-bold text-brand-contrast">
                {ws.name.slice(0, 1).toUpperCase()}
              </span>
            )}
            <span className="hidden sm:inline">{product.name}</span>
          </Link>

          <details className="relative">
            <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-background">
              <span className="max-w-[180px] truncate font-medium">{ws.name}</span>
              <span className="text-xs text-muted">{ws.type === "agency" ? "Agency" : "Personal"}</span>
              <span aria-hidden>▾</span>
            </summary>
            <div className="absolute left-0 z-20 mt-2 w-72 rounded-xl border border-border bg-surface p-2 shadow-lg">
              <p className="px-2 py-1 text-xs font-medium uppercase tracking-wider text-muted">Your workspaces</p>
              {workspaces.map((w) => (
                <Link
                  key={w.id}
                  href={`/w/${w.slug}`}
                  aria-current={w.id === ws.id ? "page" : undefined}
                  className="flex items-center justify-between rounded-lg px-2 py-2 text-sm hover:bg-background aria-[current=page]:bg-background"
                >
                  <span className="truncate">{w.name}</span>
                  <span className="ml-2 shrink-0 text-xs text-muted">{ROLE_LABEL[w.role]}</span>
                </Link>
              ))}
              <Link href="/workspaces/new" className="mt-1 block rounded-lg border-t border-border px-2 py-2 text-sm text-brand hover:bg-background">
                + New agency workspace
              </Link>
            </div>
          </details>

          <nav className="flex flex-1 flex-wrap gap-1 text-sm">
            {nav.map((n) => (
              <Link key={n.href} href={n.href} className="rounded-lg px-3 py-1.5 text-muted hover:bg-background hover:text-foreground">
                {n.label}
              </Link>
            ))}
          </nav>

          <div className="flex items-center gap-3 text-sm">
            <Link href="/account" className="max-w-[160px] truncate text-muted hover:text-foreground" title={user.email}>
              {user.name}
            </Link>
            <SignOutButton className="rounded-lg px-2 py-1.5 text-muted hover:bg-background hover:text-foreground" />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}
