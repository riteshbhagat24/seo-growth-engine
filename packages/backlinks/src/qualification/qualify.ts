/**
 * Qualification job: crawl a prospect politely (robots.txt, rate limits, SSRF-safe), extract signals,
 * expand the site for submission pages, score every opportunity and persist reasons.
 * Network work happens outside DB transactions.
 */
import type { Db } from "@sge/db";
import { consumeUsage } from "@sge/core";
import { tenant } from "../sql";
import { extractPage, type PageInfo } from "../net/html";
import type { Fetcher, SafeResponse } from "../net/fetcher";
import { PolicyBlockedError } from "../net/policy";
import { normalizeUrl } from "../net/url";
import { expansionCandidates, ingestCandidates, loadCampaignCtx, type OpportunityType } from "../discovery/discovery";
import { scoreOpportunity } from "../scoring/score";
import { pageSignals, type PageSignals } from "./signals";
import { BACKLINK_JOBS, enqueueJob, secondsToNextMonth, type EngineJobContext } from "../jobs";
import { DeferError, RetryableError } from "../errors";

interface OppRow {
  id: string;
  url: string;
  url_normalized: string;
  opportunity_type: OpportunityType;
  source_id: string | null;
  curation_status: string | null;
  automation_permission: string | null;
}

async function fetchPage(fetcher: Fetcher, url: string, onRequest: () => void): Promise<{ res: SafeResponse; page: PageInfo }> {
  onRequest();
  const res = await fetcher.fetch(url);
  return { res, page: extractPage(res.text, res.url, res.headers as Record<string, unknown>) };
}

/** Pages fetched from prospects count against the plan's monthly page-crawl allowance (best effort after the first). */
async function meter(db: Db, orgId: string, pages: number) {
  if (pages > 0) await tenant(db, orgId, (tx) => consumeUsage(tx.tx, orgId, "pages_crawled_month", pages)).catch(() => false);
}

export async function qualifyProspectJob(ctx: EngineJobContext): Promise<unknown> {
  const { prospect_id: prospectId, campaign_id: campaignId } = ctx.job.payload as { prospect_id: string; campaign_id: string };
  const orgId = ctx.job.organization_id;
  const fetcher = ctx.rt.fetcher;
  let requests = 0;
  const onRequest = () => void requests++;

  // The first page is metered up front: with no allowance left, wait for next month instead of crawling.
  const allowed = await tenant(ctx.db, orgId, (tx) => consumeUsage(tx.tx, orgId, "pages_crawled_month", 1));
  if (!allowed) throw new DeferError(secondsToNextMonth(), "This month's page-crawl allowance for your plan is used up");

  const { prospect, campaign } = await tenant(ctx.db, orgId, async (tx) => {
    const prospect = await tx.one<{ id: string; domain: string; homepage_url: string; status: string }>(
      `update backlink_prospects set status = case when status = 'excluded' then status else 'qualifying' end where id = $1
       returning id, domain, homepage_url, status`,
      [prospectId]
    );
    const campaign = await loadCampaignCtx(tx, campaignId);
    const c2 = await tx.one<{ min_quality_score: number; status: string }>(`select min_quality_score, status from backlink_campaigns where id = $1`, [
      campaignId
    ]);
    return { prospect, campaign: { ...campaign, ...c2 } };
  });
  if (prospect.status === "excluded") return { skipped: "excluded" };

  // ---- Homepage ---------------------------------------------------------------------------
  let home: { res: SafeResponse; page: PageInfo };
  try {
    home = await fetchPage(fetcher, prospect.homepage_url, onRequest);
  } catch (err) {
    if (err instanceof PolicyBlockedError && !["timeout", "dns_failure", "network"].includes(err.code)) {
      const reason =
        err.code === "robots"
          ? "robots.txt disallows our crawler — qualify manually if appropriate"
          : `blocked by crawler policy (${err.code}): ${err.message}`;
      await rejectAll(ctx.db, orgId, prospectId, campaignId, reason);
      return { rejected: true, reason };
    }
    if (ctx.job.attempts >= ctx.job.max_attempts) {
      await rejectAll(ctx.db, orgId, prospectId, campaignId, `unreachable after ${ctx.job.attempts} attempts: ${(err as Error).message}`, "error");
      return { rejected: true, reason: "unreachable" };
    }
    throw new RetryableError(`Homepage fetch failed: ${(err as Error).message}`);
  }

  // ---- Public contact route (one extra request at most) ----------------------------------
  if (!home.page.emails.length) {
    const contact = home.page.links.find((l) => l.internal && /contact/i.test(`${l.text} ${l.href}`));
    if (contact) {
      try {
        const c = await fetchPage(fetcher, contact.href, onRequest);
        home.page.emails = c.page.emails;
        (home.page as any).contactUrl = c.res.url;
      } catch {
        /* contact page optional */
      }
    }
  }

  // ---- Site expansion: submission/resource/contribution pages ----------------------------
  // Only when the prospect was discovered at homepage level. A specific deep URL (e.g. one list on a large
  // platform) must not be expanded into unrelated sections of that platform.
  const homeLevel = await tenant(ctx.db, orgId, (tx) =>
    tx.maybe(
      `select 1 from backlink_opportunities where prospect_id = $1 and campaign_id = $2 and status = 'DISCOVERED'
          and url_normalized = any($3::text[])`,
      [prospectId, campaignId, [normalizeUrl(prospect.homepage_url), normalizeUrl(home.res.url)]]
    )
  );
  const expansion = homeLevel ? expansionCandidates(home.page) : [];
  if (expansion.length) {
    await tenant(ctx.db, orgId, (tx) => ingestCandidates(tx, campaign, expansion));
  }

  const opps = await tenant(ctx.db, orgId, (tx) =>
    tx.q<OppRow>(
      `select o.id, o.url, o.url_normalized, o.opportunity_type, o.source_id, s.curation_status, s.automation_permission
         from backlink_opportunities o left join backlink_sources s on s.id = o.source_id
        where o.prospect_id = $1 and o.campaign_id = $2 and o.status = 'DISCOVERED'`,
      [prospectId, campaignId]
    )
  );

  const homeNorm = normalizeUrl(home.res.url);
  const results: { id: string; score: number; status: string }[] = [];
  let homeSignals: PageSignals | null = null;
  const updates: { id: string; score: number; breakdown: unknown; status: string; reasons: string[]; evidence: unknown }[] = [];

  for (const o of opps) {
    let subPage: PageInfo | null = null;
    let oppNoindex = false;
    let robotsOk = true;
    if (o.url_normalized === homeNorm || o.url_normalized === normalizeUrl(prospect.homepage_url)) {
      subPage = home.page;
    } else {
      try {
        const p = await fetchPage(fetcher, o.url, onRequest);
        subPage = p.res.status < 400 ? p.page : null;
        oppNoindex = p.page.noindex;
      } catch (err) {
        if (err instanceof PolicyBlockedError && err.code === "robots") robotsOk = false;
        subPage = null;
      }
    }
    const signals = pageSignals({
      page: home.page,
      rawHtml: home.res.text,
      httpStatus: home.res.status,
      finalUrl: home.res.url,
      requestedUrl: prospect.homepage_url,
      domain: prospect.domain,
      industry: campaign.industry,
      keywords: campaign.target_keywords,
      countries: campaign.target_countries,
      submissionPage: subPage
    });
    homeSignals = signals;
    const scored = scoreOpportunity({
      home: signals,
      opportunityType: o.opportunity_type,
      targetCountries: campaign.target_countries,
      keywords: campaign.target_keywords,
      curatedVerified: o.curation_status === "verified",
      sourceAutomation: o.automation_permission,
      opportunityPageNoindex: oppNoindex,
      robotsAllowsOpportunityPage: robotsOk
    });
    const reasons = scored.hardRejects.length
      ? scored.hardRejects
      : scored.score < campaign.min_quality_score
        ? [`Score ${scored.score} is below the campaign minimum of ${campaign.min_quality_score}`]
        : [];
    const status = reasons.length ? "REJECTED" : "QUALIFIED";
    updates.push({
      id: o.id,
      score: scored.score,
      breakdown: scored.breakdown,
      status,
      reasons,
      evidence: {
        public_contacts: signals.publicEmails.map((e) => ({ email: e, source_url: (home.page as any).contactUrl ?? home.res.url })),
        submission: signals.submission
      }
    });
    results.push({ id: o.id, score: scored.score, status });
  }

  await tenant(ctx.db, orgId, async (tx) => {
    for (const u of updates) {
      await tx.exec(
        `update backlink_opportunities set score = $2, score_breakdown = $3, status = $4, reject_reasons = $5, qualified_at = now(),
                discovery_evidence = discovery_evidence || jsonb_build_object('qualification', $6::jsonb)
          where id = $1`,
        [u.id, u.score, JSON.stringify(u.breakdown), u.status, u.reasons, JSON.stringify(u.evidence)]
      );
    }
    const best = Math.max(0, ...results.map((r) => r.score));
    const anyQualified = results.some((r) => r.status === "QUALIFIED");
    const sig = homeSignals ? { ...homeSignals } : {};
    await tx.exec(
      `update backlink_prospects set status = $2, score = $3, signals = $4, last_qualified_at = now(),
              reject_reasons = $5 where id = $1`,
      [
        prospectId,
        anyQualified ? "qualified" : "rejected",
        best,
        JSON.stringify(sig),
        anyQualified ? [] : [...new Set(updates.flatMap((u) => u.reasons))]
      ]
    );
    if (anyQualified && campaign.status === "active") {
      await enqueueJob(tx, {
        organizationId: orgId,
        websiteId: campaign.website_id,
        campaignId,
        jobType: BACKLINK_JOBS.plan,
        payload: { campaign_id: campaignId },
        idempotencyKey: `plan:${campaignId}:${prospectId}:${Date.now() >> 16}`,
        priority: 50
      });
    }
  });
  await meter(ctx.db, orgId, requests - 1);
  await ctx.log("info", `Qualified ${results.length} opportunity(ies) on ${prospect.domain}`, { results, requests });
  return { prospect: prospect.domain, results, requests };
}

async function rejectAll(
  db: Db,
  orgId: string,
  prospectId: string,
  campaignId: string,
  reason: string,
  prospectStatus: "rejected" | "error" = "rejected"
) {
  await tenant(db, orgId, async (tx) => {
    await tx.exec(`update backlink_prospects set status = $2, reject_reasons = $3, last_qualified_at = now() where id = $1`, [
      prospectId,
      prospectStatus,
      [reason]
    ]);
    await tx.exec(
      `update backlink_opportunities set status = 'REJECTED', reject_reasons = $3, qualified_at = now(), score = 0
        where prospect_id = $1 and campaign_id = $2 and status = 'DISCOVERED'`,
      [prospectId, campaignId, [reason]]
    );
  });
}
