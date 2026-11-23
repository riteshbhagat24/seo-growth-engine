/**
 * Backlink Verification Engine + Lost Backlink Recovery Engine.
 *
 * verifyLink() crawls the source page with the SSRF-safe client (robots.txt respected, bounded concurrency,
 * per-host rate limits) and checks: page availability, HTTP status, redirects, link existence, anchor text,
 * rel=nofollow/sponsored/ugc, redirect-wrapped links and noindex.
 * Only a crawler-confirmed link moves a submission to VERIFIED. Two consecutive misses mark it LOST and
 * open a recovery campaign with a diagnosis and an approval-gated recovery email.
 */
import { tenant, type SqlTx as Tx } from "../sql";
import { extractPage } from "../net/html";
import type { Fetcher } from "../net/fetcher";
import { PolicyBlockedError } from "../net/policy";
import { domainOf, tryParseUrl } from "../net/url";
import { recoveryEmail, type BusinessProfile } from "../assets/generator";
import { getAdapter } from "../adapters/registry";
import { transition, recordEvent } from "../submissions/state";
import { BACKLINK_JOBS, enqueueJob, type EngineJobContext } from "../jobs";
import { createTask, SOURCE_JSON } from "../pipeline/common";
import { sourceCredentials } from "../pipeline/executor";

export interface VerificationResult {
  result: "link_found" | "link_missing" | "page_unavailable" | "blocked_by_robots" | "blocked_by_policy" | "error";
  http_status: number | null;
  final_url: string | null;
  redirect_chain: { url: string; status: number }[];
  link_href: string | null;
  anchor_text: string | null;
  rel: string[];
  is_nofollow: boolean | null;
  is_sponsored: boolean | null;
  is_ugc: boolean | null;
  page_noindex: boolean | null;
  via_redirect: boolean;
  error: string | null;
}

function pathOf(u: string): string {
  try {
    return new URL(u).pathname.replace(/\/+$/, "") || "/";
  } catch {
    return "/";
  }
}

/** A link matches when it points at the target's site and (for deep targets) the same path. */
export function linkMatchesTarget(href: string, target: string): "direct" | "redirect" | null {
  try {
    if (domainOf(href) === domainOf(target)) {
      const tp = pathOf(target);
      return tp === "/" || pathOf(href).startsWith(tp) ? "direct" : null;
    }
    const u = new URL(href);
    for (const v of u.searchParams.values()) {
      const inner = tryParseUrl(decodeURIComponent(v));
      if (inner && /^https?:$/.test(inner.protocol) && v.includes(".") && domainOf(inner.toString()) === domainOf(target)) return "redirect";
    }
  } catch {
    /* ignore malformed */
  }
  return null;
}

export async function verifyLink(fetcher: Fetcher, sourceUrl: string, targetUrl: string): Promise<VerificationResult> {
  const base: VerificationResult = {
    result: "error",
    http_status: null,
    final_url: null,
    redirect_chain: [],
    link_href: null,
    anchor_text: null,
    rel: [],
    is_nofollow: null,
    is_sponsored: null,
    is_ugc: null,
    page_noindex: null,
    via_redirect: false,
    error: null
  };
  let res;
  try {
    res = await fetcher.fetch(sourceUrl);
  } catch (err) {
    if (err instanceof PolicyBlockedError) {
      if (err.code === "robots") return { ...base, result: "blocked_by_robots", error: err.message };
      if (["timeout", "dns_failure", "network"].includes(err.code)) return { ...base, result: "page_unavailable", error: err.message };
      return { ...base, result: "blocked_by_policy", error: `${err.code}: ${err.message}` };
    }
    return { ...base, result: "page_unavailable", error: (err as Error).message };
  }
  base.http_status = res.status;
  base.final_url = res.url;
  base.redirect_chain = res.redirects;
  if (res.status >= 400) return { ...base, result: "page_unavailable", error: `HTTP ${res.status}` };
  const page = extractPage(res.text, res.url, res.headers as Record<string, unknown>);
  base.page_noindex = page.noindex;
  let best: { l: (typeof page.links)[number]; kind: "direct" | "redirect" } | null = null;
  for (const l of page.links) {
    const kind = linkMatchesTarget(l.href, targetUrl);
    if (kind === "direct") {
      best = { l, kind };
      break;
    }
    if (kind === "redirect" && !best) best = { l, kind };
  }
  if (!best) return { ...base, result: "link_missing" };
  const rel = best.l.rel;
  return {
    ...base,
    result: "link_found",
    link_href: best.l.href,
    anchor_text: best.l.text,
    rel,
    is_nofollow: rel.includes("nofollow") || page.nofollowAll,
    is_sponsored: rel.includes("sponsored"),
    is_ugc: rel.includes("ugc"),
    via_redirect: best.kind === "redirect"
  };
}

const PENDING_SCHEDULE_SECONDS = [3600, 6 * 3600, 24 * 3600, 3 * 86400, 7 * 86400, 14 * 86400];
const LOST_AFTER_MISSES = 2;
const PENDING_GIVE_UP_DAYS = 60;

async function scheduleVerify(
  tx: Tx,
  s: { id: string; organization_id: string; website_id: string; campaign_id: string },
  seconds: number,
  tag: string
) {
  await enqueueJob(tx, {
    organizationId: s.organization_id,
    websiteId: s.website_id,
    campaignId: s.campaign_id,
    jobType: BACKLINK_JOBS.verify,
    payload: { submission_id: s.id },
    runAt: new Date(Date.now() + seconds * 1000),
    idempotencyKey: `verify:${s.id}:${tag}`
  });
}

export function diagnose(v: VerificationResult): "link_removed" | "page_gone" | "page_noindexed" | "redirected" | "unknown" {
  if (v.result === "page_unavailable") return "page_gone";
  if (v.result === "link_missing" && v.redirect_chain.length) return "redirected";
  if (v.result === "link_missing") return "link_removed";
  if (v.page_noindex) return "page_noindexed";
  return "unknown";
}

async function openRecovery(tx: Tx, s: any, v: VerificationResult) {
  const diagnosis = diagnose(v);
  const rc = await tx.maybe<{ id: string }>(
    `insert into backlink_recovery_campaigns (organization_id, website_id, submission_id, diagnosis, details)
     values ($1,$2,$3,$4,$5) on conflict do nothing returning id`,
    [s.organization_id, s.website_id, s.id, diagnosis, JSON.stringify({ last_check: v, live_url: s.live_url })]
  );
  if (!rc) return;
  const profile = await tx.maybe<BusinessProfile>(`select * from business_profiles where website_id = $1`, [s.website_id]);
  const opp = await tx.maybe<{ discovery_evidence: any }>(`select discovery_evidence from backlink_opportunities where id = $1`, [s.opportunity_id]);
  const contact = (opp?.discovery_evidence?.qualification?.public_contacts ?? [])[0] ?? null;
  if (profile) {
    const email = recoveryEmail(profile, {
      name: s.destination_domain,
      domain: s.destination_domain,
      type: "recovery",
      sourceUrl: s.live_url,
      targetUrl: s.target_url,
      diagnosis
    });
    const outreach = await tx.maybe<{ id: string }>(
      `insert into backlink_outreach (organization_id, website_id, campaign_id, opportunity_id, submission_id, outreach_type, contact_email, contact_source_url, status, subject, body)
       values ($1,$2,$3,$4,$5,'recovery',$6,$7,'awaiting_approval',$8,$9) on conflict do nothing returning id`,
      [
        s.organization_id,
        s.website_id,
        s.campaign_id,
        s.opportunity_id,
        s.id,
        contact?.email ?? null,
        contact?.source_url ?? null,
        email.title,
        email.body
      ]
    );
    await tx.exec(`update backlink_recovery_campaigns set status = 'outreach_drafted', outreach_id = $2 where id = $1`, [
      rc.id,
      outreach?.id ?? null
    ]);
  }
  await createTask(tx, {
    organizationId: s.organization_id,
    websiteId: s.website_id,
    campaignId: s.campaign_id,
    submissionId: s.id,
    type: "recovery",
    title: `Backlink lost on ${s.destination_domain} (${diagnosis.replace("_", " ")})`,
    instructions: `The link on ${s.live_url} to ${s.target_url} was not found in ${LOST_AFTER_MISSES} consecutive checks. A recovery email has been drafted for your approval. The link keeps being re-checked weekly and is restored automatically if it reappears.`,
    payload: { diagnosis, verification: v }
  });
}

export async function verifySubmissionJob(ctx: EngineJobContext): Promise<unknown> {
  const { submission_id: submissionId, recheck_seconds: recheckOverride } = ctx.job.payload as { submission_id: string; recheck_seconds?: number };
  const orgId = ctx.job.organization_id;
  const s = await tenant(ctx.db, orgId, async (tx) => {
    const row = await tx.maybe<any>(
      `select s.*, ${SOURCE_JSON} as source from backlink_submissions s
         left join backlink_sources src on src.id = s.source_id where s.id = $1`,
      [submissionId]
    );
    if (!row) return { status: "MISSING" };
    if (row.status === "SUBMITTED")
      await transition(tx, row.id, "PENDING_VERIFICATION", { actorType: "worker", actorId: ctx.workerId, message: "Verification started" });
    return { ...row, status: row.status === "SUBMITTED" ? "PENDING_VERIFICATION" : row.status };
  });
  if (!["PENDING_VERIFICATION", "PUBLISHED", "VERIFIED", "LOST"].includes(s.status)) return { skipped: s.status };

  let liveUrl: string | null = s.live_url;
  if (!liveUrl && s.response?.external_id) {
    const adapter = getAdapter(s.adapter_key);
    if (adapter.checkStatus) {
      try {
        const credentials = await tenant(ctx.db, orgId, (tx) => sourceCredentials(tx, orgId, s.source, ctx.rt.encryptionKey));
        const st = await adapter.checkStatus(
          { submission: s, source: s.source, opportunity: { url: "", opportunity_type: "" }, credentials, rt: ctx.rt, db: ctx.db } as any,
          s.response.external_id
        );
        liveUrl = st.liveUrl ?? null;
        if (liveUrl) await tenant(ctx.db, orgId, (tx) => tx.exec(`update backlink_submissions set live_url = $2 where id = $1`, [s.id, liveUrl]));
      } catch (err) {
        await ctx.log("warn", `checkStatus failed: ${(err as Error).message}`);
      }
    }
  }
  if (!liveUrl) {
    return tenant(ctx.db, orgId, async (tx) => {
      const checks = await tx.one<{ n: number }>(
        `select count(*) as n from backlink_submission_events where submission_id = $1 and message like 'No published URL known%'`,
        [s.id]
      );
      await recordEvent(tx, s.id, { actorType: "worker", actorId: ctx.workerId, message: "No published URL known yet" });
      if (checks.n >= 2) {
        await createTask(tx, {
          organizationId: orgId,
          websiteId: s.website_id,
          campaignId: s.campaign_id,
          submissionId: s.id,
          type: "manual_review",
          title: `Report the published URL for ${s.destination_domain}`,
          instructions: "Once the destination publishes the listing/article, enter its URL so the crawler can verify the backlink."
        });
      }
      await scheduleVerify(tx, s, PENDING_SCHEDULE_SECONDS[Math.min(checks.n + 1, PENDING_SCHEDULE_SECONDS.length - 1)]!, `nourl:${checks.n + 1}`);
      return { status: s.status, waiting_for: "published URL" };
    });
  }

  const v = await verifyLink(ctx.rt.fetcher, liveUrl, s.target_url);

  return tenant(ctx.db, orgId, async (tx) => {
    await tx.exec(
      `insert into backlink_verifications (organization_id, website_id, submission_id, source_url, target_url, result, http_status, final_url, redirect_chain,
                                           link_href, anchor_text, rel, is_nofollow, is_sponsored, is_ugc, page_noindex, error)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [
        orgId,
        s.website_id,
        s.id,
        liveUrl,
        s.target_url,
        v.result,
        v.http_status,
        v.final_url,
        JSON.stringify(v.redirect_chain),
        v.link_href,
        v.anchor_text,
        v.rel,
        v.is_nofollow,
        v.is_sponsored,
        v.is_ugc,
        v.page_noindex,
        v.error
      ]
    );
    const attrs = {
      rel: v.rel,
      nofollow: v.is_nofollow,
      sponsored: v.is_sponsored,
      ugc: v.is_ugc,
      anchor_text: v.anchor_text,
      via_redirect: v.via_redirect,
      page_noindex: v.page_noindex,
      href: v.link_href
    };
    const cur = await tx.one<{
      status: string;
      first_detected_at: Date | null;
      consecutive_misses: number;
      submitted_at: Date | null;
      link_attributes: any;
    }>(`select status, first_detected_at, consecutive_misses, submitted_at, link_attributes from backlink_submissions where id = $1`, [s.id]);
    const now = new Date();

    if (v.result === "link_found") {
      const patch = {
        last_verified_at: now,
        verified_at: now,
        link_attributes: attrs,
        consecutive_misses: 0,
        first_detected_at: cur.first_detected_at ?? now
      };
      if (cur.status === "PENDING_VERIFICATION") {
        await transition(tx, s.id, "PUBLISHED", {
          actorType: "worker",
          actorId: ctx.workerId,
          message: `Publication observed at ${liveUrl}`,
          patch: { published_at: now }
        });
        await transition(tx, s.id, "VERIFIED", {
          actorType: "worker",
          actorId: ctx.workerId,
          message: `Backlink verified (anchor "${v.anchor_text}", rel=[${v.rel.join(" ") || "none"}])`,
          patch,
          data: attrs
        });
      } else if (cur.status === "PUBLISHED") {
        await transition(tx, s.id, "VERIFIED", { actorType: "worker", actorId: ctx.workerId, message: "Backlink verified", patch, data: attrs });
      } else if (cur.status === "LOST") {
        await transition(tx, s.id, "VERIFIED", {
          actorType: "worker",
          actorId: ctx.workerId,
          message: "Lost backlink is live again — recovered",
          patch,
          data: attrs
        });
        await tx.exec(
          `update backlink_recovery_campaigns set status = 'recovered', recovered_at = now() where submission_id = $1 and status in ('open','outreach_drafted','in_progress')`,
          [s.id]
        );
      } else {
        const prev = cur.link_attributes ?? {};
        const changed = prev.nofollow !== attrs.nofollow || prev.sponsored !== attrs.sponsored || prev.ugc !== attrs.ugc;
        await tx.exec(`update backlink_submissions set last_verified_at = $2, link_attributes = $3, consecutive_misses = 0 where id = $1`, [
          s.id,
          now,
          JSON.stringify(attrs)
        ]);
        await recordEvent(tx, s.id, {
          actorType: "worker",
          actorId: ctx.workerId,
          message: changed ? `Re-verified; link attributes changed (rel=[${v.rel.join(" ")}])` : "Re-verified",
          data: attrs
        });
      }
      await scheduleVerify(tx, s, recheckOverride ?? 7 * 86400, `weekly:${now.toISOString().slice(0, 10)}`);
      return { result: v.result, status: "VERIFIED", attrs };
    }

    if (v.result === "blocked_by_robots" || v.result === "blocked_by_policy") {
      await recordEvent(tx, s.id, { actorType: "worker", actorId: ctx.workerId, message: `Cannot verify automatically: ${v.error}` });
      await createTask(tx, {
        organizationId: orgId,
        websiteId: s.website_id,
        campaignId: s.campaign_id,
        submissionId: s.id,
        type: "manual_review",
        title: `Verify ${s.destination_domain} manually`,
        instructions: `The crawler is not permitted to fetch ${liveUrl} (${v.error}). It is not counted as verified.`
      });
      return { result: v.result };
    }

    // missing / unavailable
    if (cur.status === "PENDING_VERIFICATION") {
      const ageDays = cur.submitted_at ? (Date.now() - new Date(cur.submitted_at).getTime()) / 86400000 : 0;
      if (ageDays > PENDING_GIVE_UP_DAYS) {
        await transition(tx, s.id, "FAILED", {
          actorType: "worker",
          message: `Not published within ${PENDING_GIVE_UP_DAYS} days`,
          patch: { error_message: "not published" }
        });
        return { result: v.result, status: "FAILED" };
      }
      const n = Number(ctx.job.payload.check ?? 1);
      await recordEvent(tx, s.id, { actorType: "worker", actorId: ctx.workerId, message: `Not published yet (${v.result})`, data: { check: n } });
      const delay = recheckOverride ?? PENDING_SCHEDULE_SECONDS[Math.min(n, PENDING_SCHEDULE_SECONDS.length - 1)]!;
      await enqueueJob(tx, {
        organizationId: orgId,
        websiteId: s.website_id,
        campaignId: s.campaign_id,
        jobType: BACKLINK_JOBS.verify,
        payload: { submission_id: s.id, check: n + 1, recheck_seconds: recheckOverride },
        runAt: new Date(Date.now() + delay * 1000),
        idempotencyKey: `verify:${s.id}:${n + 1}`
      });
      return { result: v.result, status: "PENDING_VERIFICATION" };
    }
    if (cur.status === "VERIFIED" || cur.status === "PUBLISHED") {
      const misses = cur.consecutive_misses + 1;
      if (misses >= LOST_AFTER_MISSES) {
        await transition(tx, s.id, "LOST", {
          actorType: "worker",
          actorId: ctx.workerId,
          message: `Backlink lost: ${diagnose(v)} (${misses} consecutive misses)`,
          patch: { lost_at: now, consecutive_misses: misses, last_verified_at: now },
          data: { verification: v }
        });
        await openRecovery(tx, { ...s, live_url: liveUrl }, v);
        await scheduleVerify(tx, s, recheckOverride ?? 7 * 86400, `lost:${now.toISOString().slice(0, 10)}`);
        return { result: v.result, status: "LOST", diagnosis: diagnose(v) };
      }
      await tx.exec(`update backlink_submissions set consecutive_misses = $2, last_verified_at = $3 where id = $1`, [s.id, misses, now]);
      await recordEvent(tx, s.id, {
        actorType: "worker",
        actorId: ctx.workerId,
        message: `Link not found (${v.result}); re-checking before marking lost`,
        data: { misses }
      });
      await scheduleVerify(tx, s, recheckOverride ?? 3600, `miss:${misses}:${now.getTime()}`);
      return { result: v.result, status: cur.status, misses };
    }
    await recordEvent(tx, s.id, { actorType: "worker", actorId: ctx.workerId, message: `Still lost (${v.result})` });
    await scheduleVerify(tx, s, recheckOverride ?? 7 * 86400, `lost:${now.toISOString().slice(0, 10)}`);
    return { result: v.result, status: cur.status };
  });
}
