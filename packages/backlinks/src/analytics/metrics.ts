/**
 * Acquisition Analytics Engine. Strictly separates attempted / submitted / published / verified.
 * Only VERIFIED counts as an acquired backlink. No ranking or traffic promises; referral data comes only from the
 * website's own GA4 sync (ga4_daily, medium "referral"), never estimated.
 */
import type { SqlTx as Tx } from "../sql";

export interface AcquisitionMetrics {
  scope: { websiteId: string | null; campaignId: string | null; from: string | null; to: string | null };
  funnel: {
    opportunities_discovered: number;
    opportunities_qualified: number;
    opportunities_rejected: number;
    submission_attempts: number;
    successful_submissions: number;
    published: number;
    verified_ever: number;
    verified_live_now: number;
    lost: number;
    manual_action_required: number;
    awaiting_approval: number;
  };
  new_referring_domains: number;
  link_attributes: { dofollow: number; nofollow: number; sponsored: number; ugc: number };
  rates: { acceptance_rate: number | null; verification_success_rate: number | null; qualification_rate: number | null };
  avg_days_to_publication: number | null;
  referral: { sessions: number; conversions: number; connected: boolean; source: string };
  costs: { recorded_total: number; currency: string; cost_per_verified_link: number | null };
  disclaimer: string;
}

export async function acquisitionMetrics(
  tx: Tx,
  scope: { websiteId?: string | null; campaignId?: string | null; from?: Date | null; to?: Date | null }
): Promise<AcquisitionMetrics> {
  const p = [scope.websiteId ?? null, scope.campaignId ?? null, scope.from ?? null, scope.to ?? null];
  const where = `($1::uuid is null or website_id = $1) and ($2::uuid is null or campaign_id = $2)`;
  const opp = await tx.one<any>(
    `select count(*) as discovered,
            count(*) filter (where qualified_at is not null and status in ('QUALIFIED','IN_PIPELINE','DONE')) as qualified,
            count(*) filter (where status = 'REJECTED') as rejected
       from backlink_opportunities where ${where}
        and ($3::timestamptz is null or discovered_at >= $3) and ($4::timestamptz is null or discovered_at < $4)`,
    p
  );
  const sub = await tx.one<any>(
    `with s as (select * from backlink_submissions where ${where}
                  and ($3::timestamptz is null or created_at >= $3) and ($4::timestamptz is null or created_at < $4)),
          ev as (select e.submission_id, e.to_status from backlink_submission_events e join s on s.id = e.submission_id)
     select
       (select count(distinct submission_id) from ev where to_status = 'SUBMITTING') as attempts,
       (select count(distinct submission_id) from ev where to_status = 'SUBMITTED') as submitted,
       (select count(distinct submission_id) from ev where to_status = 'PUBLISHED') as published,
       (select count(*) from s where first_detected_at is not null) as verified_ever,
       (select count(*) from s where status = 'VERIFIED') as verified_now,
       (select count(*) from s where status = 'LOST') as lost,
       (select count(*) from s where status = 'MANUAL_ACTION_REQUIRED') as manual,
       (select count(*) from s where status = 'AWAITING_APPROVAL') as awaiting,
       (select count(*) from s where status = 'VERIFIED' and coalesce((link_attributes->>'nofollow')::boolean, false) = false
                                  and coalesce((link_attributes->>'sponsored')::boolean, false) = false
                                  and coalesce((link_attributes->>'ugc')::boolean, false) = false) as dofollow,
       (select count(*) from s where status = 'VERIFIED' and (link_attributes->>'nofollow')::boolean) as nofollow,
       (select count(*) from s where status = 'VERIFIED' and (link_attributes->>'sponsored')::boolean) as sponsored,
       (select count(*) from s where status = 'VERIFIED' and (link_attributes->>'ugc')::boolean) as ugc,
       (select avg(extract(epoch from (first_detected_at - submitted_at)) / 86400) from s where first_detected_at is not null and submitted_at is not null) as avg_days,
       (select count(distinct destination_domain) from s where first_detected_at is not null
          and not exists (select 1 from backlink_submissions older where older.website_id = s.website_id and older.destination_domain = s.destination_domain
                            and older.first_detected_at is not null and older.first_detected_at < s.first_detected_at)) as new_ref_domains,
       (select count(distinct submission_id) from backlink_verifications v where v.submission_id in (select id from s)) as verification_attempted`,
    p
  );
  const ref = await tx.one<any>(
    `with verified as (select distinct destination_domain d from backlink_submissions where ${where} and first_detected_at is not null)
     select coalesce(sum(g.sessions),0)::bigint as sessions, coalesce(sum(g.key_events),0)::float8 as conversions,
            (select count(*) from ga4_daily x where ($1::uuid is null or x.website_id = $1)) as rows
       from ga4_daily g
      where ($1::uuid is null or g.website_id = $1) and g.medium = 'referral'
        and exists (select 1 from verified v where lower(regexp_replace(g.source, '^www\\.', '')) = v.d or lower(g.source) like '%.' || v.d)
        and ($3::timestamptz is null or g.date >= $3::date) and ($4::timestamptz is null or g.date < $4::date)`,
    p
  );
  const cost = await tx.one<any>(
    `select coalesce(sum(amount),0) as total, coalesce(min(currency),'USD') as currency from backlink_costs
      where ($2::uuid is null or campaign_id = $2) and ($1::uuid is null or campaign_id in (select id from backlink_campaigns where website_id = $1))`,
    [p[0], p[1]]
  );
  const ratio = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 1000 : null);
  return {
    scope: {
      websiteId: scope.websiteId ?? null,
      campaignId: scope.campaignId ?? null,
      from: scope.from?.toISOString() ?? null,
      to: scope.to?.toISOString() ?? null
    },
    funnel: {
      opportunities_discovered: opp.discovered,
      opportunities_qualified: opp.qualified,
      opportunities_rejected: opp.rejected,
      submission_attempts: sub.attempts,
      successful_submissions: sub.submitted,
      published: sub.published,
      verified_ever: sub.verified_ever,
      verified_live_now: sub.verified_now,
      lost: sub.lost,
      manual_action_required: sub.manual,
      awaiting_approval: sub.awaiting
    },
    new_referring_domains: sub.new_ref_domains,
    link_attributes: { dofollow: sub.dofollow, nofollow: sub.nofollow, sponsored: sub.sponsored, ugc: sub.ugc },
    rates: {
      acceptance_rate: ratio(sub.verified_ever, sub.submitted),
      verification_success_rate: ratio(sub.verified_ever, sub.verification_attempted),
      qualification_rate: ratio(opp.qualified, opp.discovered)
    },
    avg_days_to_publication: sub.avg_days == null ? null : Math.round(Number(sub.avg_days) * 100) / 100,
    referral: {
      sessions: Number(ref.sessions),
      conversions: Number(ref.conversions),
      connected: ref.rows > 0,
      source:
        ref.rows > 0
          ? "Google Analytics 4 (referral sessions from verified linking domains)"
          : "not connected: link a GA4 property in the website settings"
    },
    costs: {
      recorded_total: Number(cost.total),
      currency: cost.currency,
      cost_per_verified_link: sub.verified_ever && Number(cost.total) > 0 ? Math.round((Number(cost.total) / sub.verified_ever) * 100) / 100 : null
    },
    disclaimer: "Verified backlinks are links confirmed live by our crawler. Backlinks do not guarantee rankings or traffic."
  };
}
