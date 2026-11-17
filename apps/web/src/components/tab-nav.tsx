"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** Section tabs that highlight from the URL (exact for the first tab, prefix for the rest). */
export function TabNav({ items, label }: { items: { href: string; label: string; exact?: boolean }[]; label: string }) {
  const path = usePathname();
  return (
    <nav className="-mb-px flex gap-1 overflow-x-auto" aria-label={label}>
      {items.map((t) => {
        const active = t.exact ? path === t.href : path === t.href || path.startsWith(`${t.href}/`);
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className="whitespace-nowrap border-b-2 border-transparent px-3 py-2.5 text-sm text-muted transition hover:text-foreground aria-[current=page]:border-brand aria-[current=page]:font-medium aria-[current=page]:text-foreground"
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
