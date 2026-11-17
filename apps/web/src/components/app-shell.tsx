"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type CSSProperties, type ReactNode } from "react";
import {
  Activity,
  Building2,
  Check,
  ChevronsUpDown,
  CreditCard,
  Globe,
  LayoutDashboard,
  Menu,
  Plug,
  ScrollText,
  Settings,
  Users,
  X
} from "lucide-react";

const ICONS = { overview: LayoutDashboard, websites: Globe, clients: Building2, settings: Settings, members: Users, jobs: Activity, integrations: Plug, usage: CreditCard, audit: ScrollText };
export type NavIcon = keyof typeof ICONS;

export interface ShellNavItem {
  href: string;
  label: string;
  icon: NavIcon;
  /** Match only the exact path (for "Overview"). */
  exact?: boolean;
}

export interface ShellProps {
  theme: CSSProperties;
  product: string;
  logoUrl: string | null;
  workspace: { name: string; slug: string; type: string; initial: string };
  workspaces: { slug: string; name: string; role: string; current: boolean }[];
  main: ShellNavItem[];
  settings: ShellNavItem[];
  user: { name: string; email: string };
  signOut: ReactNode;
  children: ReactNode;
}

function NavLink({ item, onNavigate }: { item: ShellNavItem; onNavigate: () => void }) {
  const path = usePathname();
  const active = item.exact ? path === item.href : path === item.href || path.startsWith(`${item.href}/`);
  const Icon = ICONS[item.icon];
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm text-muted transition hover:bg-surface-2 hover:text-foreground aria-[current=page]:bg-brand/10 aria-[current=page]:font-medium aria-[current=page]:text-brand"
    >
      <Icon className="size-4 shrink-0" aria-hidden strokeWidth={1.8} />
      {item.label}
    </Link>
  );
}

export function AppShell(p: ShellProps) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  const sidebar = (
    <div className="flex h-full flex-col gap-4 overflow-y-auto px-3 py-4">
      <Link href={`/w/${p.workspace.slug}`} className="flex items-center gap-2.5 px-2 font-semibold" onClick={close}>
        {p.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- arbitrary https logo URLs
          <img src={p.logoUrl} alt="" className="h-7 w-auto max-w-[120px] object-contain" />
        ) : (
          <span className="grid size-7 place-items-center rounded-lg bg-brand text-xs font-bold text-brand-contrast">{p.product.slice(0, 1)}</span>
        )}
        <span className="truncate">{p.product}</span>
      </Link>

      <details className="group relative">
        <summary className="flex cursor-pointer list-none items-center gap-2.5 rounded-lg border border-border bg-surface px-2.5 py-2 text-sm shadow-card hover:bg-surface-2">
          <span className="grid size-6 shrink-0 place-items-center rounded-md bg-accent/15 text-xs font-semibold text-foreground">{p.workspace.initial}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{p.workspace.name}</span>
            <span className="block text-xs text-subtle">{p.workspace.type === "agency" ? "Agency workspace" : "Personal workspace"}</span>
          </span>
          <ChevronsUpDown className="size-4 text-subtle" aria-hidden />
        </summary>
        <div className="absolute inset-x-0 z-30 mt-1 rounded-xl border border-border bg-surface p-1.5 shadow-pop">
          <p className="px-2 py-1 text-[11px] font-medium uppercase tracking-wider text-subtle">Switch workspace</p>
          {p.workspaces.map((w) => (
            <Link
              key={w.slug}
              href={`/w/${w.slug}`}
              onClick={close}
              aria-current={w.current ? "page" : undefined}
              className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-surface-2"
            >
              <span className="min-w-0 flex-1 truncate">{w.name}</span>
              <span className="text-xs text-subtle">{w.role}</span>
              {w.current && <Check className="size-4 text-brand" aria-hidden />}
            </Link>
          ))}
          <Link href="/workspaces/new" onClick={close} className="mt-1 block border-t border-border px-2 pt-2 pb-1 text-sm text-brand hover:underline">
            + New agency workspace
          </Link>
        </div>
      </details>

      <nav className="flex flex-col gap-0.5" aria-label="Main">
        {p.main.map((i) => (
          <NavLink key={i.href} item={i} onNavigate={close} />
        ))}
      </nav>
      {p.settings.length > 0 && (
        <nav className="flex flex-col gap-0.5" aria-label="Workspace settings">
          <p className="px-2.5 pb-1 text-[11px] font-medium uppercase tracking-wider text-subtle">Workspace</p>
          {p.settings.map((i) => (
            <NavLink key={i.href} item={i} onNavigate={close} />
          ))}
        </nav>
      )}

      <div className="mt-auto flex items-center gap-2.5 rounded-lg border border-border bg-surface-2 p-2">
        <Link href="/account" onClick={close} className="flex min-w-0 flex-1 items-center gap-2.5" title="Account settings">
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-brand text-xs font-semibold text-brand-contrast">
            {p.user.name.slice(0, 1).toUpperCase()}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{p.user.name}</span>
            <span className="block truncate text-xs text-subtle">{p.user.email}</span>
          </span>
        </Link>
        {p.signOut}
      </div>
    </div>
  );

  return (
    <div style={p.theme} className="flex min-h-full flex-1">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 border-r border-border bg-sidebar lg:block">{sidebar}</aside>

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <button type="button" className="absolute inset-0 bg-black/30" aria-label="Close navigation" onClick={close} />
          <aside className="absolute inset-y-0 left-0 w-72 border-r border-border bg-sidebar shadow-pop">
            <button type="button" onClick={close} className="absolute top-3 right-3 rounded-lg p-1.5 text-muted hover:bg-surface-2" aria-label="Close navigation">
              <X className="size-5" />
            </button>
            {sidebar}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-border bg-surface/90 px-4 py-2.5 backdrop-blur lg:hidden">
          <button type="button" onClick={() => setOpen(true)} className="rounded-lg p-1.5 text-muted hover:bg-surface-2" aria-label="Open navigation">
            <Menu className="size-5" />
          </button>
          <span className="truncate text-sm font-medium">{p.workspace.name}</span>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{p.children}</main>
      </div>
    </div>
  );
}
