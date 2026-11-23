/**
 * Campaign planner ('campaign.plan' job). Picks the best qualified opportunities within campaign limits,
 * prevents duplicates across campaigns, prepares content and routes each submission by automation mode:
 *   MANUAL      -> MANUAL_ACTION_REQUIRED + task with prepared assets
 *   SUPERVISED  -> AWAITING_APPROVAL with an approval snapshot (destination + exact content)
 *   AUTOPILOT   -> APPROVED -> SUBMISSION_QUEUED, only when autopilotDecision() allows it; otherwise supervised
 */
import { tenant, type SqlTx as Tx } from "../sql";
import { generateAssetsForOpportunity, type AssetType, type BusinessProfile } from "../assets/generator";
import { getAdapter } from "../adapters/registry";
import type { SourceInfo } from "../adapters/types";
import { transition } from "../submissions/state";
import { BACKLINK_JOBS, enqueueJob, type EngineJobContext } from "../jobs";
import { audit, autopilotDecision, buildSubmissionValues, chooseAnchor, chooseTarget, createTask, SOURCE_JSON, type Mode } from "./common";

interface CampaignRow {
  id: string;
  organization_id: string;
  website_id: string;
  status: string;
  starts_at: Date | null;
  ends_at: Date | null;
  min_quality_score: number;
  target_pages: string[];
  campaign_mode: Mode | null;
  website_mode: Mode;
  autopilot_source_ids: string[];
  max_daily_submissions: number;
  max_weekly_submissions: number;
  allowed_adapters: string[];
  approval_required: boolean;
}

export async function loadCampaign(tx: Tx, campaignId: string): Promise<CampaignRow> {
  return tx.one<CampaignRow>(
    `select c.id, c.organization_id, c.website_id, c.status, c.starts_at, c.ends_at, c.min_quality_score, c.target_pages,
            c.automation_mode as campaign_mode, coalesce(ws.automation_mode, 'supervised') as website_mode,
            coalesce(ws.autopilot_source_ids, '{}') as autopilot_source_ids,
            s.max_daily_submissions, s.max_weekly_submissions, s.allowed_adapters, s.approval_required
       from backlink_campaigns c
       join backlink_campaign_settings s on s.campaign_id = c.id
       left join backlink_website_settings ws on ws.website_id = c.website_id
      where c.id = $1`,
    [campaignId]
  );
}

export async function planCampaign(tx: Tx, campaignId: string, actor: { type: "worker" | "user" | "cron"; id: string | null }) {
  // Serialise planning per WEBSITE: concurrent plan jobs (same or different campaigns) must never both pick
  // the same destination for one website.
  const site = await tx.one<{ website_id: string }>(`select website_id from backlink_campaigns where id = $1`, [campaignId]);
  await tx.exec(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [`plan:${site.website_id}`]);
  const c = await loadCampaign(tx, campaignId);
  if (c.status !== "active") return { skipped: `campaign is ${c.status}` };
  if (c.starts_at && new Date(c.starts_at) > new Date()) return { skipped: "campaign has not started" };
  if (c.ends_at && new Date(c.ends_at) < new Date()) {
    await tx.exec(`update backlink_campaigns set status = 'completed' where id = $1`, [c.id]);
    return { skipped: "campaign ended" };
  }
  const profile = await tx.maybe<BusinessProfile>(`select * from business_profiles where website_id = $1`, [c.website_id]);
  if (!profile || profile.status !== "approved") {
    await createTask(tx, {
      organizationId: c.organization_id,
      websiteId: c.website_id,
      campaignId: c.id,
      type: "profile_incomplete",
      title: "Approve the business profile",
      instructions: "Submission content is generated only from an approved business profile. Review and approve it to continue."
    });
    return { skipped: "business profile not approved" };
  }
  const created = await tx.one<{ day: number; week: number }>(
    `select count(*) filter (where created_at >= date_trunc('day', now())) as day,
            count(*) filter (where created_at >= now() - interval '7 days') as week
       from backlink_submissions where campaign_id = $1`,
    [c.id]
  );
  const capacity = Math.min(c.max_daily_submissions - created.day, c.max_weekly_submissions - created.week);
  if (capacity <= 0) return { skipped: "campaign daily/weekly submission limits reached", created };

  const opps = await tx.q<{
    id: string;
    url: string;
    opportunity_type: string;
    adapter_key: string;
    prospect_domain: string;
    score: number;
    discovery_evidence: any;
    source: SourceInfo | null;
  }>(
    `select o.id, o.url, o.opportunity_type, o.adapter_key, p.domain as prospect_domain, o.score, o.discovery_evidence,
            ${SOURCE_JSON} as source
       from backlink_opportunities o
       join backlink_prospects p on p.id = o.prospect_id
       left join backlink_sources src on src.id = o.source_id
      where o.campaign_id = $1 and o.status = 'QUALIFIED' and o.score >= $2
        and (cardinality($3::text[]) = 0 or o.adapter_key = any($3::text[]))
      order by o.score desc, o.discovered_at
      limit $4`,
    [c.id, c.min_quality_score, c.allowed_adapters, capacity * 3]
  );

  const summary = { planned: 0, awaiting_approval: 0, autopilot_queued: 0, manual: 0, duplicates: 0, blocked: 0 };
  let seed = Date.now() % 997;
  for (const o of opps) {
    if (summary.planned >= capacity) break;
    // Duplicate prevention across ALL campaigns of this website (unique index is the final guard).
    const dup = await tx.maybe(
      `select 1 from backlink_submissions where website_id = $1 and destination_domain = $2 and status not in ('REJECTED', 'FAILED', 'CANCELLED') limit 1`,
      [c.website_id, o.prospect_domain]
    );
    if (dup) {
      await tx.exec(
        `update backlink_opportunities set status = 'DONE', reject_reasons = array_append(reject_reasons, 'already submitted for this website (another campaign or earlier)') where id = $1`,
        [o.id]
      );
      summary.duplicates++;
      continue;
    }
    const adapter = getAdapter(o.adapter_key);
    const anchor = chooseAnchor(profile, seed);
    const target = chooseTarget(profile, c.target_pages, seed++);
    await tx.exec("savepoint plan_one");
    let submissionId: string;
    try {
      const s = await tx.one<{ id: string }>(
        `insert into backlink_submissions (organization_id, website_id, campaign_id, opportunity_id, source_id, adapter_key, submission_method,
                                           status, destination_domain, submission_url, target_url, anchor_text)
         values ($1,$2,$3,$4,$5,$6,$7,'QUALIFIED',$8,$9,$10,$11) returning id`,
        [
          c.organization_id,
          c.website_id,
          c.id,
          o.id,
          o.source?.id ?? null,
          adapter.manifest.key,
          adapter.manifest.type,
          o.prospect_domain,
          o.source?.submission_url ?? o.url,
          target,
          anchor
        ]
      );
      submissionId = s.id;
      await tx.exec("release savepoint plan_one");
    } catch (err) {
      await tx.exec("rollback to savepoint plan_one");
      if ((err as any).code === "23505") {
        summary.duplicates++;
        continue;
      }
      throw err;
    }
    await tx.exec(
      `insert into backlink_submission_events (organization_id, submission_id, from_status, to_status, actor_type, actor_id, message, data)
       values ($1, $2, 'DISCOVERED', 'QUALIFIED', 'system', null, $3, $4)`,
      [c.organization_id, submissionId, `Qualified with score ${o.score}`, JSON.stringify({ opportunity_id: o.id, score: o.score })]
    );
    await tx.exec(`update backlink_opportunities set status = 'IN_PIPELINE' where id = $1`, [o.id]);

    const assets = await generateAssetsForOpportunity(tx, {
      organizationId: c.organization_id,
      websiteId: c.website_id,
      campaignId: c.id,
      opportunityId: o.id
    });
    const assetMap = Object.fromEntries(assets.map((a) => [a.asset_type, a])) as Partial<Record<AssetType, (typeof assets)[number]>>;
    const values = buildSubmissionValues(profile, assetMap, target, anchor);
    const factOk = assets.every((a) => a.fact_check?.passed !== false);
    await transition(tx, submissionId, "CONTENT_READY", {
      actorType: "system",
      message: `Prepared ${assets.length} asset(s)${factOk ? "" : " — fact-check flagged unverified claims"}`,
      patch: { asset_ids: assets.map((a) => a.id), payload: { values, prepared_at: new Date().toISOString() } },
      data: { assets: assets.map((a) => ({ id: a.id, type: a.asset_type, fact_check_passed: a.fact_check?.passed })) }
    });
    summary.planned++;

    const mode: Mode = c.campaign_mode ?? c.website_mode;
    const contacts = (o.discovery_evidence?.qualification?.public_contacts ?? []) as { email: string; source_url: string }[];

    if (mode === "manual" || adapter.manifest.type === "manual_editorial") {
      await transition(tx, submissionId, "MANUAL_ACTION_REQUIRED", {
        actorType: "system",
        message: mode === "manual" ? "Manual mode" : "Destination requires manual/editorial submission"
      });
      await createTask(tx, {
        organizationId: c.organization_id,
        websiteId: c.website_id,
        campaignId: c.id,
        submissionId,
        opportunityId: o.id,
        type: "manual_submission",
        title: `Submit to ${o.source?.name ?? o.prospect_domain}`,
        instructions: `Submit manually at ${o.source?.submission_url ?? o.url} using the prepared content, then mark this task done with the published URL so it can be verified.`,
        payload: {
          destination: o.source?.submission_url ?? o.url,
          values,
          assets: assets.map((a) => ({ type: a.asset_type, title: a.title, body: a.body }))
        },
        dueInHours: 72
      });
      summary.manual++;
      continue;
    }

    if (adapter.manifest.type === "outreach") {
      const pitch = assets.find((a) => ["guest_post_pitch", "resource_request", "partnership_pitch", "outreach_email"].includes(a.asset_type));
      const contact = contacts[0] ?? null;
      const outreach = await tx.maybe<{ id: string }>(
        `insert into backlink_outreach (organization_id, website_id, campaign_id, opportunity_id, submission_id, outreach_type, contact_email, contact_source_url, status, subject, body)
         values ($1,$2,$3,$4,$5,$6,$7,$8,'awaiting_approval',$9,$10)
         on conflict do nothing returning id`,
        [
          c.organization_id,
          c.website_id,
          c.id,
          o.id,
          submissionId,
          o.opportunity_type === "guest_post"
            ? "guest_post"
            : o.opportunity_type === "resource_page"
              ? "resource_page"
              : o.opportunity_type === "partner"
                ? "partnership"
                : "other",
          contact?.email ?? null,
          contact?.source_url ?? null,
          pitch?.title ?? null,
          pitch?.body ?? null
        ]
      );
      await requestApproval(
        tx,
        c,
        submissionId,
        adapter.manifest.key,
        o,
        values,
        assets,
        ["Outreach is always sent only after approval"],
        outreach
          ? { id: outreach.id, to: contact?.email ?? null, contact_source_url: contact?.source_url ?? null, subject: pitch?.title, body: pitch?.body }
          : null
      );
      summary.awaiting_approval++;
      continue;
    }

    const problems = adapter.validate({ source: o.source, values, assets: assetMap as any });
    if (problems.length) {
      await transition(tx, submissionId, "MANUAL_ACTION_REQUIRED", { actorType: "system", message: `Adapter not ready: ${problems.join("; ")}` });
      await createTask(tx, {
        organizationId: c.organization_id,
        websiteId: c.website_id,
        campaignId: c.id,
        submissionId,
        opportunityId: o.id,
        type: "adapter_error",
        title: `Configure ${adapter.manifest.name} for ${o.prospect_domain}`,
        instructions: problems.join("\n")
      });
      summary.blocked++;
      continue;
    }

    const decision = autopilotDecision({
      mode,
      approvalRequired: c.approval_required,
      adapter,
      source: o.source,
      websiteAutopilotSources: c.autopilot_source_ids,
      factCheckPassed: factOk
    });
    if (decision.eligible) {
      await transition(tx, submissionId, "APPROVED", {
        actorType: "system",
        message: "Approved by autopilot policy (source explicitly permits automation and is enabled for autopilot on this website)",
        data: { policy: "autopilot", source_permission: o.source!.automation_permission, permission_evidence: o.source!.permission_evidence }
      });
      await tx.exec(`update backlink_assets set status = 'approved', approved_at = now() where id = any($1::uuid[]) and status = 'draft'`, [
        assets.map((a) => a.id)
      ]);
      await queueExecution(tx, {
        id: submissionId,
        organization_id: c.organization_id,
        website_id: c.website_id,
        campaign_id: c.id,
        adapter_key: adapter.manifest.key,
        attempt_count: 0
      });
      summary.autopilot_queued++;
    } else {
      await requestApproval(tx, c, submissionId, adapter.manifest.key, o, values, assets, decision.reasons, null);
      summary.awaiting_approval++;
    }
  }
  await audit(tx, c.organization_id, actor.type === "user" ? "user" : "worker", actor.id, "campaign.plan", "campaign", c.id, summary);
  return summary;
}

async function requestApproval(
  tx: Tx,
  c: CampaignRow,
  submissionId: string,
  adapterKey: string,
  o: { id: string; url: string; prospect_domain: string; source: SourceInfo | null; score: number },
  values: unknown,
  assets: { id: string; asset_type: string; title: string | null; body: string; fact_check: any }[],
  whyApproval: string[],
  outreach: Record<string, unknown> | null
) {
  await transition(tx, submissionId, "AWAITING_APPROVAL", { actorType: "system", message: `Approval required: ${whyApproval.join("; ")}` });
  const adapter = getAdapter(adapterKey);
  await tx.exec(
    `insert into backlink_approvals (organization_id, website_id, campaign_id, subject_type, subject_id, snapshot, requested_by)
     values ($1,$2,$3,'submission',$4,$5,'system') on conflict do nothing`,
    [
      c.organization_id,
      c.website_id,
      c.id,
      submissionId,
      JSON.stringify({
        destination: {
          name: o.source?.name ?? o.prospect_domain,
          domain: o.prospect_domain,
          url: o.source?.submission_url ?? o.url,
          permission: o.source?.automation_permission ?? "none"
        },
        adapter: { key: adapter.manifest.key, name: adapter.manifest.name, type: adapter.manifest.type },
        score: o.score,
        values,
        assets: assets.map((a) => ({ id: a.id, type: a.asset_type, title: a.title, body: a.body, fact_check: a.fact_check })),
        outreach,
        why_approval: whyApproval
      })
    ]
  );
}

/** Browser submissions run only on a worker with Chromium; everything else on any worker (or a web tick). */
export function executeJobType(adapterKey: string) {
  return getAdapter(adapterKey).needsBrowser ? BACKLINK_JOBS.executeBrowser : BACKLINK_JOBS.execute;
}

export async function queueExecution(
  tx: Tx,
  s: { id: string; organization_id: string; website_id: string; campaign_id: string; adapter_key: string; attempt_count: number },
  suffix = "",
  opts: { alreadyQueued?: boolean } = {}
) {
  const jobType = executeJobType(s.adapter_key);
  if (!opts.alreadyQueued) {
    await transition(tx, s.id, "SUBMISSION_QUEUED", {
      actorType: "system",
      message: jobType === BACKLINK_JOBS.executeBrowser ? "Queued for the browser worker" : "Queued for execution"
    });
  }
  await enqueueJob(tx, {
    organizationId: s.organization_id,
    websiteId: s.website_id,
    campaignId: s.campaign_id,
    jobType,
    payload: { submission_id: s.id },
    idempotencyKey: `execute:${s.id}:${s.attempt_count}${suffix}`,
    maxAttempts: 4,
    priority: 40
  });
}

export async function planCampaignJob(ctx: EngineJobContext) {
  const { campaign_id } = ctx.job.payload as { campaign_id: string };
  return tenant(ctx.db, ctx.job.organization_id, (tx) => planCampaign(tx, campaign_id, { type: "worker", id: ctx.workerId }));
}
