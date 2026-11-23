/**
 * Submission state machine. Every status change goes through transition(), which locks the row,
 * validates the edge and appends to backlink_submission_events (full history).
 *
 * Counting rules: only VERIFIED means "acquired". SUBMITTED = the destination accepted our submission;
 * PUBLISHED = publication observed/claimed; VERIFIED = our crawler found the live link.
 */
import type { SqlTx as Tx } from "../sql";

export const SUBMISSION_STATES = [
  "DISCOVERED",
  "QUALIFIED",
  "CONTENT_READY",
  "AWAITING_APPROVAL",
  "APPROVED",
  "SUBMISSION_QUEUED",
  "SUBMITTING",
  "SUBMITTED",
  "PENDING_VERIFICATION",
  "PUBLISHED",
  "VERIFIED",
  "REJECTED",
  "FAILED",
  "MANUAL_ACTION_REQUIRED",
  "CANCELLED",
  "LOST"
] as const;
export type SubmissionState = (typeof SUBMISSION_STATES)[number];

export const TRANSITIONS: Record<SubmissionState, SubmissionState[]> = {
  DISCOVERED: ["QUALIFIED", "REJECTED", "CANCELLED"],
  QUALIFIED: ["CONTENT_READY", "REJECTED", "CANCELLED", "MANUAL_ACTION_REQUIRED"],
  CONTENT_READY: ["AWAITING_APPROVAL", "APPROVED", "MANUAL_ACTION_REQUIRED", "CANCELLED"],
  AWAITING_APPROVAL: ["APPROVED", "REJECTED", "CANCELLED", "CONTENT_READY"],
  APPROVED: ["SUBMISSION_QUEUED", "MANUAL_ACTION_REQUIRED", "CANCELLED"],
  SUBMISSION_QUEUED: ["SUBMITTING", "MANUAL_ACTION_REQUIRED", "CANCELLED", "FAILED"],
  SUBMITTING: ["SUBMITTED", "FAILED", "REJECTED", "MANUAL_ACTION_REQUIRED", "SUBMISSION_QUEUED"],
  SUBMITTED: ["PENDING_VERIFICATION", "PUBLISHED", "REJECTED"],
  PENDING_VERIFICATION: ["PUBLISHED", "VERIFIED", "REJECTED", "FAILED"],
  PUBLISHED: ["VERIFIED", "LOST", "PENDING_VERIFICATION"],
  VERIFIED: ["LOST"],
  LOST: ["VERIFIED", "CANCELLED"],
  MANUAL_ACTION_REQUIRED: ["SUBMISSION_QUEUED", "SUBMITTED", "PENDING_VERIFICATION", "CANCELLED", "FAILED", "APPROVED"],
  FAILED: ["SUBMISSION_QUEUED", "CANCELLED"],
  REJECTED: [],
  CANCELLED: []
};

export const COUNTED_AS_ACQUIRED: SubmissionState[] = ["VERIFIED"];

export class InvalidTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`Invalid submission transition ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function canTransition(from: SubmissionState, to: SubmissionState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

const PATCHABLE = new Set([
  "submission_url",
  "anchor_text",
  "asset_ids",
  "payload",
  "submitted_at",
  "response",
  "confirmation_text",
  "error_message",
  "live_url",
  "published_at",
  "first_detected_at",
  "last_verified_at",
  "verified_at",
  "lost_at",
  "link_attributes",
  "consecutive_misses",
  "attempt_count"
]);

export interface TransitionOptions {
  actorType: "user" | "system" | "worker" | "cron";
  actorId?: string | null;
  message?: string;
  data?: Record<string, unknown>;
  patch?: Record<string, unknown>;
  /** Only transition if currently in one of these states (guard against concurrent workers). */
  expectFrom?: SubmissionState[];
}

export async function transition(
  tx: Tx,
  submissionId: string,
  to: SubmissionState,
  opts: TransitionOptions
): Promise<{ from: SubmissionState; to: SubmissionState }> {
  const cur = await tx.one<{ status: SubmissionState }>(`select status from backlink_submissions where id = $1 for update`, [submissionId]);
  if (opts.expectFrom && !opts.expectFrom.includes(cur.status)) throw new InvalidTransitionError(cur.status, to);
  if (!canTransition(cur.status, to)) throw new InvalidTransitionError(cur.status, to);
  const sets = ["status = $2"];
  const params: unknown[] = [submissionId, to];
  for (const [k, v] of Object.entries(opts.patch ?? {})) {
    if (!PATCHABLE.has(k)) throw new Error(`Column ${k} is not patchable`);
    const isJson = v !== null && typeof v === "object" && !(v instanceof Date) && !Array.isArray(v);
    params.push(isJson ? JSON.stringify(v) : v);
    sets.push(`${k} = $${params.length}`);
  }
  await tx.exec(`update backlink_submissions set ${sets.join(", ")} where id = $1`, params);
  await tx.exec(
    `insert into backlink_submission_events (organization_id, submission_id, from_status, to_status, actor_type, actor_id, message, data)
     select organization_id, id, $2, $3, $4, $5, $6, $7 from backlink_submissions where id = $1`,
    [submissionId, cur.status, to, opts.actorType, opts.actorId ?? null, opts.message ?? null, JSON.stringify(opts.data ?? {})]
  );
  return { from: cur.status, to };
}

/** Record a non-transition event (e.g. a re-verification) in the same history. */
export async function recordEvent(tx: Tx, submissionId: string, opts: Omit<TransitionOptions, "patch" | "expectFrom">): Promise<void> {
  await tx.exec(
    `insert into backlink_submission_events (organization_id, submission_id, from_status, to_status, actor_type, actor_id, message, data)
     select organization_id, id, status, status, $2, $3, $4, $5 from backlink_submissions where id = $1`,
    [submissionId, opts.actorType, opts.actorId ?? null, opts.message ?? null, JSON.stringify(opts.data ?? {})]
  );
}
