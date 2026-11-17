import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { twMerge } from "tailwind-merge";

/** Joins classes; later Tailwind utilities override earlier conflicting ones (e.g. p-0 over p-6). */
export const cx = (...c: (string | false | null | undefined)[]) => twMerge(c.filter(Boolean).join(" "));

type Variant = "primary" | "secondary" | "danger" | "ghost";
const variants: Record<Variant, string> = {
  primary: "bg-brand text-brand-contrast shadow-card hover:opacity-90",
  secondary: "border border-border-strong bg-surface text-foreground shadow-card hover:bg-surface-2",
  danger: "border border-danger/30 bg-surface text-danger hover:bg-danger/5",
  ghost: "text-muted hover:text-foreground hover:bg-surface-2"
};
export const buttonClass = (v: Variant = "primary", extra?: string) =>
  cx(
    "inline-flex h-9 items-center justify-center gap-2 whitespace-nowrap rounded-lg px-3.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50",
    variants[v],
    extra
  );

export function Button({ variant = "primary", className, ...p }: ComponentProps<"button"> & { variant?: Variant }) {
  return <button className={buttonClass(variant, className)} {...p} />;
}

export function LinkButton({ variant = "primary", className, ...p }: ComponentProps<typeof Link> & { variant?: Variant }) {
  return <Link className={buttonClass(variant, className)} {...p} />;
}

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: string; children: ReactNode; htmlFor: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </div>
  );
}

const control =
  "rounded-lg border border-border-strong bg-surface text-sm shadow-card placeholder:text-subtle focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/15";

export function Input({ className, ...p }: ComponentProps<"input">) {
  return <input className={cx("h-9 w-full px-3", control, className)} {...p} />;
}

export function Textarea({ className, ...p }: ComponentProps<"textarea">) {
  return <textarea className={cx("w-full px-3 py-2", control, className)} {...p} />;
}

export function Select({ className, ...p }: ComponentProps<"select">) {
  return <select className={cx("h-9 px-3", control, className)} {...p} />;
}

export function Card({ className, children, id }: { className?: string; children: ReactNode; id?: string }) {
  return (
    <section id={id} className={cx("rounded-xl border border-border bg-surface p-5 shadow-card sm:p-6", className)}>
      {children}
    </section>
  );
}

/** Card heading row: title (+ optional description) and actions on the right. */
export function CardHeader({ title, description, actions, icon }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 items-start gap-3">
        {icon && <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-brand/10 text-brand">{icon}</span>}
        <div className="min-w-0">
          <h2 className="font-semibold leading-tight">{title}</h2>
          {description && <p className="mt-1 text-sm text-muted">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Alert({ tone = "info", children }: { tone?: "info" | "error" | "success" | "warning"; children: ReactNode }) {
  const tones = {
    info: "border-border bg-surface-2 text-foreground",
    error: "border-danger/30 bg-danger/5 text-danger",
    success: "border-success/30 bg-success/5 text-success",
    warning: "border-warning/30 bg-warning/5 text-warning"
  };
  return (
    <div role={tone === "error" ? "alert" : "status"} className={cx("rounded-lg border px-4 py-3 text-sm", tones[tone])}>
      {children}
    </div>
  );
}

export function PageHeader({ title, description, actions, eyebrow }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && <div className="mb-1 text-sm text-muted">{eyebrow}</div>}
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "success" | "warning" | "danger" | "brand" }) {
  const tones = {
    neutral: "border-border bg-surface-2 text-muted",
    success: "border-success/25 bg-success/10 text-success",
    warning: "border-warning/25 bg-warning/10 text-warning",
    danger: "border-danger/25 bg-danger/10 text-danger",
    brand: "border-brand/25 bg-brand/10 text-brand"
  };
  return <span className={cx("inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium", tones[tone])}>{children}</span>;
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed border-border-strong bg-surface-2 px-6 py-10 text-center">
      {icon && <div className="mb-3 grid size-11 place-items-center rounded-full bg-brand/10 text-brand">{icon}</div>}
      <h3 className="font-semibold">{title}</h3>
      {children && <div className="mt-1 max-w-md text-sm text-muted">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** "+12%" style change indicator: arrow + text, never colour alone. */
export function Change({ current, previous, invert = false, format = "pct" }: { current: number; previous: number | null | undefined; invert?: boolean; format?: "pct" | "abs" }) {
  if (previous === null || previous === undefined) return null;
  if (format === "pct" && previous === 0) return <span className="text-xs text-subtle">{current === 0 ? "no change" : "new"}</span>;
  const value = format === "pct" ? ((current - previous) / Math.abs(previous)) * 100 : current - previous;
  if (Math.abs(value) < 0.05) return <span className="text-xs text-subtle">no change</span>;
  const good = invert ? value < 0 : value > 0;
  const n = Math.abs(value);
  const text = format === "pct" ? `${n >= 10 ? n.toFixed(0) : n.toFixed(1)}%` : n.toFixed(1);
  return (
    <span className={cx("inline-flex items-center gap-0.5 text-xs font-medium", good ? "text-success" : "text-danger")}>
      <span aria-hidden>{value > 0 ? "↑" : "↓"}</span>
      <span className="sr-only">{value > 0 ? "up" : "down"}</span>
      {text}
    </span>
  );
}

/** KPI tile: label, big value, change vs the previous period, optional footnote. */
export function Kpi({ label, value, change, foot, href }: { label: string; value: ReactNode; change?: ReactNode; foot?: ReactNode; href?: string }) {
  const body = (
    <>
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-2">
        <span className="text-2xl font-semibold tracking-tight tabular-nums">{value}</span>
        {change}
      </div>
      {foot && <div className="mt-1 text-xs text-subtle">{foot}</div>}
    </>
  );
  const cls = "block rounded-xl border border-border bg-surface p-4 shadow-card";
  return href ? (
    <Link href={href} className={cx(cls, "transition hover:border-border-strong hover:bg-surface-2")}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

/** Segmented link control (e.g. date ranges). */
export function Segmented({ items, current, label }: { items: { key: string; label: string; href: string }[]; current: string; label: string }) {
  return (
    <nav className="inline-flex rounded-lg border border-border-strong bg-surface p-0.5 text-sm shadow-card" aria-label={label}>
      {items.map((i) => (
        <Link
          key={i.key}
          href={i.href}
          aria-current={i.key === current ? "page" : undefined}
          className="rounded-md px-2.5 py-1 text-muted hover:text-foreground aria-[current=page]:bg-brand aria-[current=page]:text-brand-contrast"
        >
          {i.label}
        </Link>
      ))}
    </nav>
  );
}

export const fmtInt = (n: number) => Math.round(n).toLocaleString("en-IN");
export const fmtCompact = (n: number) => (Math.abs(n) >= 10_000 ? new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n) : fmtInt(n));
export const fmtPct = (n: number) => `${(n * 100).toFixed(n < 0.1 ? 2 : 1)}%`;
export const fmtPos = (n: number | null | undefined) => (n === null || n === undefined || n === 0 ? "–" : n.toFixed(1));
export const fmtDate = (d: string | Date) =>
  (typeof d === "string" ? new Date(`${d}T00:00:00Z`) : d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
