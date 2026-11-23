/**
 * 'backlinks.tick': the website's daily schedule (one `schedules` row per website, created with its first campaign).
 * Replaces the standalone's cross-tenant cron: everything here runs in the website's own workspace under RLS.
 *  - completes campaigns past their end date;
 *  - plans each active campaign once a day and re-discovers once a week (idempotent keys);
 *  - re-verifies live, published and lost links weekly (detects loss and recovery);
 *  - drafts at most one follow-up reminder per outreach thread (as a task, never sent).
 */
import { tenant } from "../sql";
import { BACKLINK_JOBS, enqueueJob, isoWeek, type EngineJobContext } from "../jobs";
import { draftDueFollowUps } from "../outreach/crm";
import { disableWebsiteSchedule } from "./campaigns";

export async function websiteTickJob(ctx: EngineJobContext) {
  const websiteId = (ctx.job.payload.website_id as string | undefined) ?? ctx.job.website_id;
  if (!websiteId) return { skipped: "no website" };
  const orgId = ctx.job.organization_id;
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  return tenant(ctx.db, orgId, async (tx) => {
    const completed = await tx.exec(
      `update backlink_campaigns set status = 'completed' where website_id = $1 and status = 'active' and ends_at is not null and ends_at < now()`,
      [websiteId]
    );
    const active = await tx.q<{ id: string }>(
      `select id from backlink_campaigns where website_id = $1 and status = 'active' and (starts_at is null or starts_at <= now())`,
      [websiteId]
    );
    for (const c of active) {
      await enqueueJob(tx, {
        organizationId: orgId,
        websiteId,
        campaignId: c.id,
        jobType: BACKLINK_JOBS.plan,
        payload: { campaign_id: c.id },
        idempotencyKey: `plan:${c.id}:daily:${day}`
      });
      await enqueueJob(tx, {
        organizationId: orgId,
        websiteId,
        campaignId: c.id,
        jobType: BACKLINK_JOBS.discover,
        payload: { campaign_id: c.id },
        idempotencyKey: `discover:${c.id}:weekly:${isoWeek(now)}`
      });
    }
    const due = await tx.q<{ id: string; campaign_id: string }>(
      `select id, campaign_id from backlink_submissions
        where website_id = $1 and status in ('VERIFIED', 'PUBLISHED', 'LOST') and (last_verified_at is null or last_verified_at < now() - interval '7 days')`,
      [websiteId]
    );
    for (const s of due) {
      await enqueueJob(tx, {
        organizationId: orgId,
        websiteId,
        campaignId: s.campaign_id,
        jobType: BACKLINK_JOBS.verify,
        payload: { submission_id: s.id },
        idempotencyKey: `verify:${s.id}:sweep:${day}`
      });
    }
    const followups = await draftDueFollowUps(tx, websiteId);
    // Nothing left to plan or monitor: stop the schedule (a new campaign turns it back on).
    const monitored = await tx.one<{ n: number }>(
      `select count(*) as n from backlink_submissions where website_id = $1 and status in ('SUBMITTED', 'PENDING_VERIFICATION', 'PUBLISHED', 'VERIFIED', 'LOST')`,
      [websiteId]
    );
    const openOutreach = await tx.one<{ n: number }>(`select count(*) as n from backlink_outreach where website_id = $1 and status = 'sent'`, [
      websiteId
    ]);
    if (!active.length && !monitored.n && !openOutreach.n) await disableWebsiteSchedule(tx, websiteId);
    return { plans: active.length, reverify: due.length, followups, completed };
  });
}
