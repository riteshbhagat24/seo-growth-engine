import { LogOut } from "lucide-react";
import type { CSSProperties } from "react";
import { can, getProductSettings, listMyWorkspaces, ROLE_LABEL } from "@sge/core";
import { AppShell, type ShellNavItem } from "@/components/app-shell";
import { SignOutButton } from "@/components/sign-out-button";
import { db } from "@/lib/db";
import { requireUser, requireWorkspace } from "@/lib/session";

export default async function WorkspaceLayout({ children, params }: LayoutProps<"/w/[slug]">) {
  const { slug } = await params;
  const user = await requireUser(`/w/${slug}`);
  const access = await requireWorkspace(slug);
  const [workspaces, product] = await Promise.all([listMyWorkspaces(db(), user.id), getProductSettings(db())]);
  const ws = access.workspace;
  const r = access.role;
  const base = `/w/${slug}`;
  const theme = { "--brand": ws.branding.primary ?? product.primary, "--accent": ws.branding.accent ?? product.accent } as CSSProperties;

  const main: (ShellNavItem & { show: boolean })[] = [
    { href: base, label: "Overview", icon: "overview", exact: true, show: true },
    { href: `${base}/websites`, label: "Websites", icon: "websites", show: true },
    { href: `${base}/clients`, label: "Clients", icon: "clients", show: ws.type === "agency" }
  ];
  const settings: (ShellNavItem & { show: boolean })[] = [
    { href: `${base}/settings`, label: "General", icon: "settings", exact: true, show: can(r, "workspace.update") || can(r, "branding.manage") },
    { href: `${base}/settings/members`, label: "Members", icon: "members", show: can(r, "members.view") },
    { href: `${base}/settings/integrations`, label: "Integrations", icon: "integrations", show: can(r, "integrations.manage") },
    { href: `${base}/settings/jobs`, label: "Background jobs", icon: "jobs", show: can(r, "work.run") },
    { href: `${base}/settings/usage`, label: "Plan & usage", icon: "usage", show: can(r, "plan.view") },
    { href: `${base}/settings/audit`, label: "Audit log", icon: "audit", show: can(r, "audit.view") }
  ];
  const visible = (xs: (ShellNavItem & { show: boolean })[]) => xs.filter((x) => x.show).map(({ show: _s, ...x }) => x);

  return (
    <AppShell
      theme={theme}
      product={product.name}
      logoUrl={ws.branding.logoUrl ?? null}
      workspace={{ name: ws.name, slug: ws.slug, type: ws.type, initial: ws.name.slice(0, 1).toUpperCase() }}
      workspaces={workspaces.map((w) => ({ slug: w.slug, name: w.name, role: ROLE_LABEL[w.role], current: w.id === ws.id }))}
      main={visible(main)}
      settings={visible(settings)}
      user={{ name: user.name, email: user.email }}
      signOut={
        <SignOutButton className="rounded-lg p-1.5 text-muted hover:bg-surface hover:text-foreground">
          <LogOut className="size-4" aria-hidden />
        </SignOutButton>
      }
    >
      {children}
    </AppShell>
  );
}
