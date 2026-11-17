export function VerificationBadge({ status }: { status: "verified" | "unverified" }) {
  return status === "verified" ? (
    <span className="inline-flex items-center gap-1 rounded-full border border-success/30 bg-success/5 px-2 py-0.5 text-xs font-medium text-success">
      ✓ Verified
    </span>
  ) : (
    <span className="inline-flex items-center rounded-full border border-border bg-background px-2 py-0.5 text-xs font-medium text-muted">
      Not verified
    </span>
  );
}
