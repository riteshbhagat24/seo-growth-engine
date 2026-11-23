/**
 * Outreach Management Engine (guest post / partnership CRM). One-to-one, approval-gated, opt-out aware.
 * No bulk sends: each message is tied to one opportunity and one publicly listed business contact.
 */
import type { SqlTx as Tx } from "../sql";
import { BACKLINK_JOBS, enqueueJob } from "../jobs";
import { PermanentError } from "../errors";
import { InvalidTransitionError, transition } from "../submissions/state";
import { audit, createTask } from "../pipeline/common";

const OPT_OUT_RE = /\b(unsubscribe|stop|remove me|opt[- ]?out|do not contact|don'?t contact)\b/i;
const MAX_FOLLOWUPS = 1;

export async function optOut(tx: Tx, orgId: string, outreachId: string, actorId: string | null, reason = "recipient opted out") {
  const o = await tx.one<{ contact_email: string | null; website_id: string }>(
    `select contact_email, website_id from backlink_outreach where id = $1`,
    [outreachId]
  );
  if (o.contact_email) {
    await tx.exec(
      `insert into backlink_exclusions (organization_id, kind, value, reason) values ($1, 'email', lower($2), $3) on conflict do nothing`,
      [orgId, o.contact_email, reason]
    );
    // Close every open thread to this address across all websites of the organisation.
    const threads = await tx.q<{ id: string; submission_id: string | null }>(
      `update backlink_outreach set status = 'opted_out', next_followup_at = null
        where lower(contact_email) = lower($1) and status not in ('closed', 'opted_out', 'published') returning id, submission_id`,
      [o.contact_email]
    );
    for (const t of threads) {
      if (!t.submission_id) continue;
      const s = await tx.one<{ status: string }>(`select status from backlink_submissions where id = $1`, [t.submission_id]);
      if (["AWAITING_APPROVAL", "APPROVED", "SUBMISSION_QUEUED", "MANUAL_ACTION_REQUIRED"].includes(s.status)) {
        await transition(tx, t.submission_id, "CANCELLED", {
          actorType: actorId ? "user" : "system",
          actorId,
          message: "Recipient opted out of contact"
        });
      }
    }
  }
  await audit(tx, orgId, actorId ? "user" : "system", actorId, "outreach.opt_out", "outreach", outreachId, { reason });
}

export async function recordReply(
  tx: Tx,
  orgId: string,
  outreachId: string,
  userId: string,
  reply: { text: string; decision?: "accepted" | "rejected" | "revisions_requested" | "pending" }
) {
  if (OPT_OUT_RE.test(reply.text)) {
    await optOut(tx, orgId, outreachId, userId, "replied with an opt-out request");
    return { status: "opted_out" };
  }
  const status = reply.decision === "accepted" ? "accepted" : reply.decision === "rejected" ? "declined" : "replied";
  await tx.exec(
    `update backlink_outreach set status = $2, last_reply_at = now(), next_followup_at = null, editorial_decision = coalesce($3, editorial_decision),
            notes = notes || jsonb_build_array(jsonb_build_object('at', now(), 'by', $4::text, 'reply', $5::text))
      where id = $1`,
    [outreachId, status, reply.decision ?? null, userId, reply.text.slice(0, 5000)]
  );
  await audit(tx, orgId, "user", userId, "outreach.reply", "outreach", outreachId, { status });
  return { status };
}

/** Publisher published the article/link: record the URL and hand it to the verifier. Never counted until verified. */
export async function recordPublication(tx: Tx, orgId: string, outreachId: string, userId: string, articleUrl: string) {
  if (!/^https?:\/\/[^\s]+$/i.test(articleUrl)) throw new PermanentError("Enter the published article as an http(s) URL");
  const o = await tx.one<{ submission_id: string | null; website_id: string; campaign_id: string | null }>(
    `update backlink_outreach set status = 'published', article_url = $2, editorial_decision = 'accepted' where id = $1 returning submission_id, website_id, campaign_id`,
    [outreachId, articleUrl]
  );
  if (o.submission_id) {
    const s = await tx.one<{ status: string }>(`select status from backlink_submissions where id = $1`, [o.submission_id]);
    if (s.status === "MANUAL_ACTION_REQUIRED") {
      // Pitch was sent by hand (no SMTP) and the publisher has now published.
      await transition(tx, o.submission_id, "SUBMITTED", {
        actorType: "user",
        actorId: userId,
        message: "Pitch sent manually; publisher reported publication",
        patch: { submitted_at: new Date() }
      });
      await transition(tx, o.submission_id, "PENDING_VERIFICATION", {
        actorType: "user",
        actorId: userId,
        message: "Publisher reported the article as published"
      });
    } else if (s.status === "SUBMITTED") {
      await transition(tx, o.submission_id, "PENDING_VERIFICATION", {
        actorType: "user",
        actorId: userId,
        message: "Publisher reported the article as published"
      });
    } else if (s.status !== "PENDING_VERIFICATION") {
      throw new InvalidTransitionError(s.status, "PENDING_VERIFICATION");
    }
    await tx.exec(`update backlink_submissions set live_url = $2 where id = $1`, [o.submission_id, articleUrl]);
    await enqueueJob(tx, {
      organizationId: orgId,
      websiteId: o.website_id,
      campaignId: o.campaign_id,
      jobType: BACKLINK_JOBS.verify,
      payload: { submission_id: o.submission_id },
      idempotencyKey: `verify:${o.submission_id}:published`
    });
  }
  await audit(tx, orgId, "user", userId, "outreach.published", "outreach", outreachId, { articleUrl });
}

/** Daily schedule: at most one polite follow-up, drafted as a task (never auto-sent). */
export async function draftDueFollowUps(tx: Tx, websiteId: string): Promise<number> {
  const due = await tx.q<{
    id: string;
    organization_id: string;
    website_id: string;
    campaign_id: string | null;
    submission_id: string | null;
    contact_email: string;
    subject: string | null;
  }>(
    `select id, organization_id, website_id, campaign_id, submission_id, contact_email, subject from backlink_outreach
      where website_id = $2 and status = 'sent' and next_followup_at <= now() and followup_count < $1 and last_reply_at is null`,
    [MAX_FOLLOWUPS, websiteId]
  );
  for (const o of due) {
    await tx.exec(
      `update backlink_outreach set status = 'follow_up_due', followup_count = followup_count + 1, next_followup_at = null where id = $1`,
      [o.id]
    );
    await createTask(tx, {
      organizationId: o.organization_id,
      websiteId: o.website_id,
      campaignId: o.campaign_id,
      type: "outreach_reply",
      title: `Optional follow-up to ${o.contact_email}`,
      instructions: `No reply after 7 days. If appropriate, send ONE short follow-up ("Re: ${o.subject ?? ""}") — or close the thread. No further follow-ups will be suggested.`,
      payload: { outreach_id: o.id }
    });
  }
  return due.length;
}

/**
 * A person approved a standalone message (recovery email or the single follow-up) and sent it from their own
 * mailbox. Pitches for NEW links are approved on the Approvals page instead (they are tied to a submission).
 */
export async function markOutreachSent(tx: Tx, orgId: string, outreachId: string, userId: string) {
  const o = await tx.one<{ status: string; outreach_type: string; contact_email: string | null }>(
    `select status, outreach_type, contact_email from backlink_outreach where id = $1 for update`,
    [outreachId]
  );
  const allowed = o.status === "follow_up_due" || (o.outreach_type === "recovery" && ["awaiting_approval", "approved"].includes(o.status));
  if (!allowed) throw new InvalidTransitionError(o.status, "sent");
  if (o.contact_email) {
    const suppressed = await tx.maybe(`select 1 from backlink_exclusions where kind = 'email' and lower(value) = lower($1)`, [o.contact_email]);
    if (suppressed) throw new PermanentError("This recipient has opted out; the message must not be sent");
  }
  await tx.exec(
    `update backlink_outreach set status = 'sent', approved_by = coalesce(approved_by, $2), approved_at = coalesce(approved_at, now()),
            sent_at = now(), next_followup_at = case when followup_count = 0 then now() + interval '7 days' else null end
      where id = $1`,
    [outreachId, userId]
  );
  await tx.exec(`update backlink_recovery_campaigns set status = 'in_progress' where outreach_id = $1 and status in ('open', 'outreach_drafted')`, [
    outreachId
  ]);
  await audit(tx, orgId, "user", userId, "outreach.sent_manually", "outreach", outreachId, { type: o.outreach_type });
  return { status: "sent" };
}
