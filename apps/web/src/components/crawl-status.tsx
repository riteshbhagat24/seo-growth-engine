const LABEL: Record<string, string> = {
  queued: "Queued",
  running: "Crawling…",
  completed: "Completed",
  cancelled: "Cancelled",
  failed: "Failed",
  limit_reached: "Plan limit reached"
};

export function CrawlStatus({ status }: { status: string }) {
  const tone =
    status === "completed"
      ? "border-success/30 bg-success/5 text-success"
      : status === "failed" || status === "limit_reached"
        ? "border-danger/30 bg-danger/5 text-danger"
        : status === "running" || status === "queued"
          ? "border-brand/30 bg-brand/5 text-brand"
          : "border-border bg-background text-muted";
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${tone}`}>{LABEL[status] ?? status}</span>;
}
