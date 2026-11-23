/** Approval decisions and human-task resolution (resume / manual completion / dismissal). */
import { assertWithinLimit } from "@sge/core";
import { NotFoundError, type SqlTx as Tx } from "../sql";
import { transition } from "../submissions/state";
import { BACKLINK_JOBS, enqueueJob } from "../jobs";
import { PermanentError } from "../errors";
import { audit } from "./common";
import { queueExecution } from "./planner";

export { NotFoundError };

export async function decideApproval(
  tx: Tx,
  approvalId: string,
  userId: string,
  decision: "approved" | "rejected",
  note?: string
): Promise<{ submissionId: string; status: string }> {
  const a = await tx.maybe<{ id: string; organization_id: string; subject_type: string; subject_id: string; status: string }>(
    `select id, organization_id, subject_type, subject_id, status from backlink_approvals where id = $1 for update`,
    [approvalId]
  );
  if (!a) throw new NotFoundError("Approval not found");
  if (a.status !== "pending") throw new PermanentError(`This approval is already ${a.status}`);
  await tx.exec(`update backlink_approvals set status = $2, decided_by = $3, decided_at = now(), note = $4 where id = $1`, [
    approvalId,
    decision,
    userId,
    note ?? null
  ]);
  const s = await tx.one<{
    id: string;
    organization_id: string;
    website_id: string;
    campaign_id: string;
    adapter_key: string;
    asset_ids: string[];
    attempt_count: number;
    opportunity_id: string;
  }>(
    `select id, organization_id, website_id, campaign_id, adapter_key, asset_ids, attempt_count, opportunity_id from backlink_submissions where id = $1`,
    [a.subject_id]
  );
  if (decision === "rejected") {
    await transition(tx, s.id, "REJECTED", { actorType: "user", actorId: userId, message: `Rejected by approver${note ? `: ${note}` : ""}` });
    await tx.exec(`update backlink_opportunities set status = 'DONE' where id = $1`, [s.opportunity_id]);
    await tx.exec(`update backlink_outreach set status = 'closed' where submission_id = $1`, [s.id]);
    await tx.exec(`update backlink_assets set status = 'rejected' where id = any($1::uuid[])`, [s.asset_ids]);
    await audit(tx, a.organization_id, "user", userId, "approval.rejected", "submission", s.id, { approval_id: approvalId, note });
    return { submissionId: s.id, status: "REJECTED" };
  }
  await transition(tx, s.id, "APPROVED", {
    actorType: "user",
    actorId: userId,
    message: `Approved by user${note ? `: ${note}` : ""}`,
    data: { approval_id: approvalId }
  });
  await tx.exec(
    `update backlink_assets set status = 'approved', approved_by = $2, approved_at = now() where id = any($1::uuid[]) and status = 'draft'`,
    [s.asset_ids, userId]
  );
  await tx.exec(
    `update backlink_outreach set status = 'approved', approved_by = $2, approved_at = now() where submission_id = $1 and status = 'awaiting_approval'`,
    [s.id, userId]
  );
  await queueExecution(tx, s);
  await audit(tx, a.organization_id, "user", userId, "approval.approved", "submission", s.id, { approval_id: approvalId, note });
  return { submissionId: s.id, status: "SUBMISSION_QUEUED" };
}

export type TaskResolution =
  | { action: "submitted_manually"; live_url?: string | null; note?: string }
  | { action: "resume"; note?: string }
  | { action: "mark_sent"; note?: string }
  | { action: "dismiss"; note?: string };

export async function resolveTask(tx: Tx, taskId: string, userId: string, r: TaskResolution): Promise<{ submissionStatus: string | null }> {
  const t = await tx.maybe<{ id: string; organization_id: string; submission_id: string | null; status: string; task_type: string }>(
    `select id, organization_id, submission_id, status, task_type from backlink_tasks where id = $1 for update`,
    [taskId]
  );
  if (!t) throw new NotFoundError("Task not found");
  if (!["open", "in_progress"].includes(t.status)) throw new PermanentError(`This task is already ${t.status}`);
  if (r.action === "submitted_manually" && r.live_url && !/^https?:\/\/[^\s]+$/i.test(r.live_url))
    throw new PermanentError("Enter the published page as an http(s) URL");
  await tx.exec(`update backlink_tasks set status = $2, completed_at = now(), resolution = $3 where id = $1`, [
    taskId,
    r.action === "dismiss" ? "dismissed" : "done",
    JSON.stringify({ ...r, by: userId })
  ]);
  let status: string | null = null;
  if (t.submission_id) {
    const s = await tx.one<{
      id: string;
      status: string;
      organization_id: string;
      website_id: string;
      campaign_id: string;
      adapter_key: string;
      attempt_count: number;
    }>(`select id, status, organization_id, website_id, campaign_id, adapter_key, attempt_count from backlink_submissions where id = $1`, [
      t.submission_id
    ]);
    if (r.action === "submitted_manually" || r.action === "mark_sent") {
      if (s.status === "MANUAL_ACTION_REQUIRED") {
        // A reported link is monitored from now on: it counts against the plan's monitored-links allowance.
        await assertWithinLimit(tx.tx, t.organization_id, "backlinks_monitored", 1);
        await transition(tx, s.id, "SUBMITTED", {
          actorType: "user",
          actorId: userId,
          message: r.action === "mark_sent" ? "User reported the outreach message as sent" : "User reported a manual submission",
          patch: {
            submitted_at: new Date(),
            confirmation_text: r.note ?? "Reported by user",
            live_url: r.action === "submitted_manually" ? (r.live_url ?? null) : null
          }
        });
        await transition(tx, s.id, "PENDING_VERIFICATION", {
          actorType: "system",
          message: r.action === "submitted_manually" && r.live_url ? "Will verify the reported URL" : "Awaiting a published URL to verify"
        });
        if (r.action === "mark_sent")
          await tx.exec(
            `update backlink_outreach set status = 'sent', sent_at = now(), next_followup_at = now() + interval '7 days' where submission_id = $1`,
            [s.id]
          );
        await enqueueJob(tx, {
          organizationId: s.organization_id,
          websiteId: s.website_id,
          campaignId: s.campaign_id,
          jobType: BACKLINK_JOBS.verify,
          payload: { submission_id: s.id },
          idempotencyKey: `verify:${s.id}:manual:${Date.now()}`
        });
        status = "PENDING_VERIFICATION";
      }
    } else if (r.action === "resume") {
      if (s.status === "MANUAL_ACTION_REQUIRED" || s.status === "FAILED") {
        // Resuming requires a prior approval or autopilot decision; the executor re-checks this gate.
        await queueExecution(tx, s, `:resume:${Date.now()}`);
        status = "SUBMISSION_QUEUED";
      }
    } else if (r.action === "dismiss") {
      if (["MANUAL_ACTION_REQUIRED", "FAILED", "AWAITING_APPROVAL", "CONTENT_READY"].includes(s.status)) {
        await transition(tx, s.id, "CANCELLED", { actorType: "user", actorId: userId, message: `Task dismissed${r.note ? `: ${r.note}` : ""}` });
        status = "CANCELLED";
      }
    }
  }
  await audit(tx, t.organization_id, "user", userId, `task.${r.action}`, "task", taskId, r);
  return { submissionStatus: status };
}
