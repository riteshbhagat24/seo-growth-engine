import { Badge } from "@/components/ui";

const TONE: Record<string, "neutral" | "success" | "warning" | "danger" | "brand"> = {
  VERIFIED: "success",
  PUBLISHED: "success",
  SUBMITTED: "brand",
  PENDING_VERIFICATION: "brand",
  SUBMISSION_QUEUED: "brand",
  SUBMITTING: "brand",
  APPROVED: "brand",
  AWAITING_APPROVAL: "warning",
  MANUAL_ACTION_REQUIRED: "warning",
  LOST: "danger",
  FAILED: "danger",
  REJECTED: "danger",
  QUALIFIED: "success",
  active: "success",
  paused: "warning",
  completed: "neutral",
  approved: "success",
  draft: "warning"
};

const LABEL: Record<string, string> = {
  PENDING_VERIFICATION: "Awaiting publication",
  MANUAL_ACTION_REQUIRED: "Needs a person",
  AWAITING_APPROVAL: "Awaiting approval",
  SUBMISSION_QUEUED: "Queued",
  CONTENT_READY: "Content ready"
};

/** Submission / campaign / opportunity status. Only VERIFIED is shown as an acquired link. */
export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={TONE[status] ?? "neutral"}>{LABEL[status] ?? status.charAt(0) + status.slice(1).toLowerCase().replace(/_/g, " ")}</Badge>;
}

export const fmtWhen = (d: Date | string | null | undefined) =>
  d ? new Date(d).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "—";

/** Untrusted URLs from crawled pages: link only http(s), never pass a referrer. */
export function SafeLink({ href, children }: { href: string | null | undefined; children?: React.ReactNode }) {
  if (!href) return <span className="text-subtle">—</span>;
  if (!/^https?:\/\//i.test(href)) return <span className="break-all">{href}</span>;
  return (
    <a href={href} target="_blank" rel="noreferrer noopener nofollow" className="break-all text-brand hover:underline">
      {children ?? href}
    </a>
  );
}
