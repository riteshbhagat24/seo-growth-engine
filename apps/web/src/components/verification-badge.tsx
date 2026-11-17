import { Badge } from "./ui";

export function VerificationBadge({ status }: { status: "verified" | "unverified" }) {
  return status === "verified" ? <Badge tone="success">✓ Verified</Badge> : <Badge>Not verified</Badge>;
}
