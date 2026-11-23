/**
 * Acceptance tests 1–9 (+ manual mode) for the backlink acquisition engine, ported from the standalone build.
 *
 * Real Postgres (RLS on, app_user), the shared @sge/jobs runner, real HTTP and real Chromium. Submissions go ONLY to
 * the approved test destination (fixtures/test-destination.ts). Real third-party sites are crawled (read-only,
 * robots-respecting) only with BACKLINKS_LIVE_TESTS=1; by default every public hostname fails to resolve.
 */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { addWebsite, createClient } from "@sge/core";
import {
  BACKLINK_JOBS,
  campaignDetail,
  createBacklinkCampaign,
  decideBacklinkApproval,
  enqueueJob,
  getAutomation,
  importOpportunities,
  markOutreachMessageSent,
  pauseBacklinkCampaign,
  resolveBacklinkTask,
  resumeBacklinkCampaign,
  saveBusinessProfile,
  approveBusinessProfile,
  tenant
} from "../src/index";
import { factCheck, generateAssetsForOpportunity, renderAsset, similarity, type BusinessProfile } from "../src/assets/generator";
import {
  admin,
  closeAll,
  db,
  FIXTURE_PROFILE,
  LIVE,
  makeAgency,
  makeDue,
  newWebsite,
  one,
  q,
  registerTestDestination,
  startTestDestination,
  testRuntime,
  TestRunner,
  worker,
  type Agency,
  type TestDestination
} from "./helpers";

let dest: TestDestination;
let runner: TestRunner;
let a: Agency;
let sourceId: string;
const ids: Record<string, string> = {};

const destDomain = () => `127.0.0.1:${dest.port}`;
const destSubmission = (websiteId: string) =>
  one(a.orgId, `select * from backlink_submissions where website_id = $1 and destination_domain = $2`, [websiteId, destDomain()]);
const events = (submissionId: string) =>
  q<{ from_status: string; to_status: string; actor_type: string; message: string; data: any }>(
    a.orgId,
    `select from_status, to_status, actor_type, message, data from backlink_submission_events where submission_id = $1 order by id`,
    [submissionId]
  );
const testDestCampaign = (websiteId: string, name: string, adapters: string[]) =>
  createBacklinkCampaign(db, a.owner, a.access, {
    websiteId,
    name,
    preferredCategories: ["industry_directory"],
    allowedAdapters: adapters,
    approvalRequired: false,
    minQualityScore: 45,
    maxDailySubmissions: 10,
    maxWeeklySubmissions: 20
  });

beforeAll(async () => {
  dest = await startTestDestination();
  runner = new TestRunner(testRuntime(dest));
  a = await makeAgency("Acme Agency");
}, 120_000);

afterAll(async () => {
  await dest?.close();
  await closeAll();
});

describe("Backlink acquisition engine (acceptance)", () => {
  test("TEST 1: add a website and create an acquisition campaign", async () => {
    const client = await createClient(db, a.owner, a.access, { name: "Brightlane Ltd" });
    const w = await addWebsite(db, a.owner, a.access, {
      url: "https://brightlane-analytics.com/",
      displayName: "Brightlane Analytics",
      clientId: client.id
    });
    ids.websiteA = w.id;
    expect((await getAutomation(db, a.owner, a.access, w.id)).mode).toBe("supervised"); // default mode
    await saveBusinessProfile(db, a.owner, a.access, w.id, FIXTURE_PROFILE("https://brightlane-analytics.com/", "Brightlane Analytics"));
    expect((await approveBusinessProfile(db, a.owner, a.access, w.id)).version).toBe(1);
    sourceId = await registerTestDestination(a.orgId, a.owner.userId, dest, "listing-api-v1");

    const c = await createBacklinkCampaign(db, a.owner, a.access, {
      websiteId: w.id,
      name: "Q4 2026 SaaS directories",
      targetKeywords: ["website analytics", "saas analytics"],
      targetPages: ["https://brightlane-analytics.com/analytics"],
      minQualityScore: 45,
      maxDailySubmissions: 30,
      maxWeeklySubmissions: 60,
      excludedDomains: ["example-linkfarm.test"],
      seedUrls: LIVE ? ["https://github.com/onurakpolat/awesome-analytics", "https://github.com/sindresorhus/awesome"] : []
    });
    ids.campaignA = c.id;
    const row = await one(
      a.orgId,
      `select c.organization_id, c.website_id, c.status, w.client_id, s.max_daily_submissions, s.approval_required
         from backlink_campaigns c join backlink_campaign_settings s on s.campaign_id = c.id join websites w on w.id = c.website_id where c.id = $1`,
      [c.id]
    );
    expect(row).toMatchObject({
      organization_id: a.orgId,
      client_id: client.id,
      website_id: w.id,
      status: "active",
      max_daily_submissions: 30,
      approval_required: true
    });
    const jobs = await q(a.orgId, `select type, status from jobs where payload ->> 'campaign_id' = $1`, [c.id]);
    expect(jobs).toEqual([{ type: BACKLINK_JOBS.discover, status: "queued" }]);
    // The website's daily schedule (planning, weekly discovery and re-verification) is on.
    expect(await q(a.orgId, `select job_type, enabled from schedules where website_id = $1`, [w.id])).toEqual([
      { job_type: BACKLINK_JOBS.tick, enabled: true }
    ]);
  });

  test("TEST 2: discover and qualify backlink prospects", async () => {
    // Competitor backlink export (Ahrefs format). alternativeto.net is also in the curated catalogue (dedupe).
    const csv = [
      '"Referring page URL","Anchor","Target URL","Domain rating"',
      `"${dest.url}/","Brightlane competitor","https://competitor.com/","55"`,
      '"https://alternativeto.net/","competitor","https://competitor.com/","91"',
      '"not a url","x","y","1"'
    ].join("\n");
    const imp = await importOpportunities(db, a.owner, a.access, ids.campaignA!, {
      csv,
      kind: "competitor",
      competitor: "competitor.com",
      fileName: "ahrefs-export.csv"
    });
    expect(imp.errors.length).toBe(1);

    const outcomes = await runner.drain();
    expect(outcomes.filter((o) => o.jobType === BACKLINK_JOBS.qualify).length).toBeGreaterThan(LIVE ? 3 : 0);

    const prospects = await q<{ domain: string; status: string; score: number; reject_reasons: string[] }>(
      a.orgId,
      `select domain, status, score, reject_reasons from backlink_prospects where website_id = $1 order by score desc nulls last`,
      [ids.websiteA]
    );
    const opps = await q<{
      url: string;
      status: string;
      score: number;
      score_breakdown: any[];
      discovery_method: string;
      discovery_source: string;
      discovery_evidence: any;
      reject_reasons: string[];
    }>(
      a.orgId,
      `select url, status, score, score_breakdown, discovery_method, discovery_source, discovery_evidence, reject_reasons from backlink_opportunities where campaign_id = $1`,
      [ids.campaignA]
    );
    if (LIVE)
      console.table(prospects.map((p) => ({ domain: p.domain, status: p.status, score: p.score, reason: (p.reject_reasons[0] ?? "").slice(0, 70) })));

    // Curated (industry/country aware), competitor CSV and site-expansion discovery are all present.
    const methods = new Set(opps.map((o) => o.discovery_method));
    expect(methods.has("curated_database")).toBe(true);
    expect(methods.has("competitor_csv")).toBe(true);
    expect(methods.has("site_expansion")).toBe(true);
    if (LIVE) expect(methods.has("user_url")).toBe(true);
    // De-duplication: alternativeto.net from the CSV and from the catalogue is one prospect.
    expect(prospects.filter((p) => p.domain === "alternativeto.net").length).toBe(1);
    // Every evaluated opportunity carries evidence and a reasoned 0-100 score; DA/DR is never a factor.
    const evaluated = opps.filter((o) => !["DISCOVERED", "EXCLUDED"].includes(o.status));
    expect(evaluated.length).toBeGreaterThan(0);
    for (const o of evaluated) {
      expect(o.discovery_source).toBeTruthy();
      expect(o.discovery_evidence.discovered_at).toBeTruthy();
      expect(o.score).toBeGreaterThanOrEqual(0);
      expect(o.score).toBeLessThanOrEqual(100);
      if (o.score_breakdown.length) {
        for (const f of o.score_breakdown) expect(f.reason).toBeTruthy();
        expect(o.score_breakdown.map((f: any) => f.factor)).not.toContain("domain_authority");
      } else {
        expect(o.reject_reasons.length).toBeGreaterThan(0); // unreachable / robots / policy: reason recorded
      }
    }
    if (LIVE) {
      const real = prospects.filter((p) => !p.domain.startsWith("127.0.0.1"));
      expect(real.filter((p) => ["qualified", "rejected", "error"].includes(p.status)).length).toBeGreaterThanOrEqual(5);
      expect(real.filter((p) => p.status === "qualified").length).toBeGreaterThanOrEqual(1);
    }
    expect(prospects.find((p) => p.domain === destDomain())!.status).toBe("qualified");
  }, 600_000);

  test("TEST 3: generate relevant, accurate and unique submission assets", async () => {
    const sub = await destSubmission(ids.websiteA!);
    ids.subA = sub.id;
    const assets = await q<{ asset_type: string; title: string | null; body: string; fact_check: any }>(
      a.orgId,
      `select asset_type, title, body, fact_check from backlink_assets where id = any($1::uuid[])`,
      [sub.asset_ids]
    );
    expect(assets.map((x) => x.asset_type).sort()).toEqual(["directory_listing", "long_description", "short_description"]);
    expect(assets.find((x) => x.asset_type === "short_description")!.body.length).toBeLessThanOrEqual(160);
    for (const x of assets) {
      expect(x.fact_check.passed).toBe(true);
      expect(x.body).toMatch(/Brightlane Analytics|analytics/i);
      expect(x.body).not.toMatch(/award|certified|#1|testimonial|\d+\s?%/i);
    }
    // Unique per destination: the generator compares new copy with earlier copy for the website, varies it, and
    // flags anything still too similar for a person to edit (never silently reused).
    const profile = await one<BusinessProfile>(a.orgId, `select * from business_profiles where website_id = $1`, [ids.websiteA]);
    const mine = assets.find((x) => x.asset_type === "long_description")!.body;
    const otherOpp = await one(
      a.orgId,
      `select o.id from backlink_opportunities o join backlink_prospects p on p.id = o.prospect_id where o.campaign_id = $1 and p.domain <> $2 limit 1`,
      [ids.campaignA, destDomain()]
    );
    const [other] = await tenant(db, a.orgId, (tx) =>
      generateAssetsForOpportunity(tx, {
        organizationId: a.orgId,
        websiteId: ids.websiteA!,
        campaignId: ids.campaignA!,
        opportunityId: otherOpp.id,
        types: ["long_description"]
      })
    );
    expect(similarity(mine, other!.body) < 0.85 || other!.fact_check.missing.includes("unique copy")).toBe(true);
    // Never invented: no founder in the profile -> no founder bio; fabricated claims are flagged.
    const d = { name: "Example Publisher", domain: "publisher.com", type: "guest_post", pageTitle: "Analytics tips" };
    expect(renderAsset("founder_bio", profile, d, 1)).toBeNull();
    expect(renderAsset("article_draft", profile, d, 1)!.body).toMatch(/^DRAFT FOR EDITORIAL REVIEW/);
    expect(factCheck(renderAsset("guest_post_pitch", profile, d, 1)!.body, profile, [d.name, d.pageTitle]).passed).toBe(true);
    const fabricated = factCheck("Brightlane Analytics is an award-winning, ISO 27001 certified #1 platform trusted by 500+ clients.", profile);
    expect(fabricated.passed).toBe(false);
    expect(fabricated.claims.filter((c) => !c.supported).map((c) => c.kind)).toEqual(
      expect.arrayContaining(["award", "certification", "superlative", "statistic"])
    );
  });

  test("TEST 9: approval-required handling (SUPERVISED default)", async () => {
    const sub = await destSubmission(ids.websiteA!);
    expect(sub.status).toBe("AWAITING_APPROVAL");
    const approval = await one(a.orgId, `select * from backlink_approvals where subject_id = $1 and status = 'pending'`, [sub.id]);
    expect(approval.snapshot.destination.url).toBe(`${dest.url}/submit`);
    expect(approval.snapshot.adapter.key).toBe("listing-api-v1");
    expect(approval.snapshot.values.business_name).toBe("Brightlane Analytics");
    expect(approval.snapshot.assets.length).toBe(3);
    expect(approval.snapshot.why_approval.join(" ")).toMatch(/automation mode is supervised/);
    expect(JSON.stringify(approval.snapshot)).not.toMatch(/credentials_enc|test-api-token/); // secrets never in snapshots
    // Nothing executes without approval.
    await runner.drain();
    expect(await q(a.orgId, `select 1 from jobs where type like 'backlinks.execute%' and payload ->> 'submission_id' = $1`, [sub.id])).toHaveLength(
      0
    );
    expect(dest.state.listings).toHaveLength(0);
    if (LIVE) {
      const manual = await q(
        a.orgId,
        `select 1 from backlink_tasks t join backlink_submissions s on s.id = t.submission_id where s.campaign_id = $1 and t.task_type = 'manual_submission'`,
        [ids.campaignA]
      );
      expect(manual.length).toBeGreaterThanOrEqual(1); // manual-only catalogue destinations go to a person
    }
    const r = await decideBacklinkApproval(db, a.owner, a.access, approval.id, "approved", "Copy checked");
    expect(r.status).toBe("SUBMISSION_QUEUED");
    expect((await events(sub.id)).find((e) => e.to_status === "APPROVED")).toMatchObject({ actor_type: "user" });
  });

  test("TEST 4 + 5: execute a permitted submission (official API adapter) and capture the confirmation", async () => {
    await runner.drain();
    const sub = await destSubmission(ids.websiteA!);
    expect(sub.status).toBe("PENDING_VERIFICATION"); // submitted, but NOT counted as acquired
    expect(sub.submitted_at).toBeTruthy();
    expect(sub.confirmation_text).toMatch(/accepted with status "pending"/);
    expect(sub.live_url).toBe(`${dest.url}/listing/1`);
    expect(dest.state.listings).toHaveLength(1);
    expect(dest.state.listings[0]).toMatchObject({
      via: "api",
      business_name: "Brightlane Analytics",
      website_url: "https://brightlane-analytics.com/analytics",
      idempotency_key: `sge-${sub.id}`,
      status: "pending"
    });
    const evidence = await q(a.orgId, `select kind, sha256, bytes, content from backlink_submission_evidence where submission_id = $1`, [sub.id]);
    expect(evidence.map((e) => e.kind)).toEqual(expect.arrayContaining(["http_exchange", "confirmation_text"]));
    expect(JSON.parse(evidence.find((e) => e.kind === "http_exchange").content).response.status).toBe(201);
    expect(evidence.map((e) => e.content).join(" ")).not.toContain("test-api-token"); // the bearer token never reaches evidence
    const path = (await events(sub.id)).map((e) => e.to_status);
    expect(path).toEqual(expect.arrayContaining(["SUBMISSION_QUEUED", "SUBMITTING", "SUBMITTED", "PENDING_VERIFICATION"]));
    // The listing is still in moderation, so verification found nothing yet.
    expect((await q(a.orgId, `select result from backlink_verifications where submission_id = $1`, [sub.id])).map((x) => x.result)).toContain(
      "page_unavailable"
    );
    const m = (await campaignDetail(db, a.owner, a.access, ids.campaignA!)).metrics;
    expect(m.funnel.successful_submissions).toBe(1);
    expect(m.funnel.verified_ever).toBe(0);
  });

  test("TEST 4b: AUTOPILOT through the public-form (HTTP) and browser adapters; CAPTCHA pauses for a human", async () => {
    // --- HTTP public form, autopilot ---
    ids.websiteB = await newWebsite(a, "Northwind Tools", "https://northwind-tools.com/", "autopilot", [sourceId]);
    await registerTestDestination(a.orgId, a.owner.userId, dest, "http-form", { submissionPath: "/submit" });
    await testDestCampaign(ids.websiteB, "Form autopilot", ["http-form"]);
    await runner.drain();
    const sb = await destSubmission(ids.websiteB);
    expect(sb.status).toBe("PENDING_VERIFICATION");
    expect((await events(sb.id)).find((e) => e.to_status === "APPROVED")).toMatchObject({
      actor_type: "system",
      data: expect.objectContaining({ policy: "autopilot" })
    });
    expect(sb.confirmation_text).toMatch(/Your listing #2 has been received and is pending review/);
    expect(dest.state.listings[1]).toMatchObject({ via: "form", business_name: "Northwind Tools", status: "pending", logo_bytes: 0 });
    expect(sb.live_url).toBe(`${dest.url}/listing/2`);

    // --- Browser automation (JavaScript-rendered form), autopilot ---
    ids.websiteC = await newWebsite(a, "Cobalt Metrics", "https://cobalt-metrics.com/", "autopilot", [sourceId]);
    await registerTestDestination(a.orgId, a.owner.userId, dest, "browser-form", { submissionPath: "/submit-js" });
    await testDestCampaign(ids.websiteC, "Browser autopilot", ["browser-form"]);
    const browserRun = await runner.drain();
    expect(browserRun.some((o) => o.jobType === BACKLINK_JOBS.executeBrowser && o.outcome === "succeeded")).toBe(true);
    const sc = await destSubmission(ids.websiteC);
    expect(sc.status).toBe("PENDING_VERIFICATION");
    expect(dest.state.listings[2]).toMatchObject({ via: "form-js", business_name: "Cobalt Metrics" });
    expect(dest.state.requests.some((r) => r.path === "/submit-js" && r.ua.includes("SEOGrowthEngineBot"))).toBe(true); // honest UA
    const shots = await q<{ data: Buffer; sha256: string; meta: any; bytes: number }>(
      a.orgId,
      `select data, sha256, meta, bytes from backlink_submission_evidence where submission_id = $1 and kind = 'screenshot'`,
      [sc.id]
    );
    expect(shots.map((s) => s.meta.stage)).toEqual(expect.arrayContaining(["form_loaded", "filled", "after_submit"]));
    for (const s of shots) {
      expect(s.data.length).toBe(s.bytes);
      expect(createHash("sha256").update(s.data).digest("hex")).toBe(s.sha256);
    }

    // --- CAPTCHA-protected form: never bypassed, paused for a person ---
    ids.websiteD = await newWebsite(a, "Delta Dashboards", "https://delta-dashboards.com/", "autopilot", [sourceId]);
    await registerTestDestination(a.orgId, a.owner.userId, dest, "browser-form", { submissionPath: "/submit-captcha" });
    await testDestCampaign(ids.websiteD, "Captcha autopilot", ["browser-form"]);
    await runner.drain();
    const sd = await destSubmission(ids.websiteD);
    expect(sd.status).toBe("MANUAL_ACTION_REQUIRED");
    const task = await one(a.orgId, `select task_type, instructions, payload from backlink_tasks where submission_id = $1`, [sd.id]);
    expect(task.task_type).toBe("captcha_required");
    expect(task.instructions).toMatch(/will not be bypassed/);
    expect(task.payload.prepared_values.business_name).toBe("Delta Dashboards");
    expect(dest.state.listings.some((l) => l.via === "form-captcha")).toBe(false);
    expect(sd.submitted_at).toBeNull(); // an attempt is not a submission
  }, 300_000);

  test("TEST 6: verify the published backlink", async () => {
    await admin(dest, "/admin/listings/1/approve"); // moderator publishes the API listing (followed link)
    await admin(dest, "/admin/listings/2/approve", { rel: "nofollow ugc" }); // and the form listing (nofollow ugc)
    await makeDue({ jobType: BACKLINK_JOBS.verify });
    await runner.drain();
    const sub = await destSubmission(ids.websiteA!);
    expect(sub.status).toBe("VERIFIED");
    expect(sub.first_detected_at).toBeTruthy();
    expect(sub.last_verified_at).toBeTruthy();
    expect(sub.link_attributes).toMatchObject({ nofollow: false, sponsored: false, ugc: false, anchor_text: "Brightlane Analytics" });
    const v = await one(
      a.orgId,
      `select * from backlink_verifications where submission_id = $1 and result = 'link_found' order by checked_at desc limit 1`,
      [sub.id]
    );
    expect(v).toMatchObject({ http_status: 200, link_href: "https://brightlane-analytics.com/analytics", is_nofollow: false });
    const path = (await events(sub.id)).map((e) => e.to_status);
    expect(path.indexOf("PUBLISHED")).toBeLessThan(path.indexOf("VERIFIED"));
    const sb = await destSubmission(ids.websiteB!);
    expect(sb.status).toBe("VERIFIED");
    expect(sb.link_attributes).toMatchObject({ nofollow: true, ugc: true });
    const m = (await campaignDetail(db, a.owner, a.access, ids.campaignA!)).metrics;
    expect(m.funnel).toMatchObject({ successful_submissions: 1, published: 1, verified_ever: 1, verified_live_now: 1 });
    expect(m.link_attributes.dofollow).toBe(1);
    expect(m.new_referring_domains).toBe(1);
  });

  test("TEST 7: detect a removed backlink and open a recovery campaign", async () => {
    await admin(dest, "/admin/listings/1/remove");
    await makeDue({ submissionId: ids.subA });
    await runner.drain();
    let sub = await destSubmission(ids.websiteA!);
    expect(sub.status).toBe("VERIFIED"); // one miss is not enough (avoids flapping)
    expect(sub.consecutive_misses).toBe(1);
    await makeDue({ submissionId: ids.subA });
    await runner.drain();
    sub = await destSubmission(ids.websiteA!);
    expect(sub.status).toBe("LOST");
    expect(sub.lost_at).toBeTruthy();
    const rc = await one(a.orgId, `select * from backlink_recovery_campaigns where submission_id = $1`, [sub.id]);
    expect(rc).toMatchObject({ diagnosis: "page_gone", status: "outreach_drafted" });
    const outreach = await one(a.orgId, `select status, body, outreach_type from backlink_outreach where id = $1`, [rc.outreach_id]);
    expect(outreach).toMatchObject({ status: "awaiting_approval", outreach_type: "recovery" });
    expect(outreach.body).toContain(`${dest.url}/listing/1`);
    expect(
      await q(a.orgId, `select 1 from backlink_tasks where submission_id = $1 and task_type = 'recovery' and status = 'open'`, [sub.id])
    ).toHaveLength(1);
    expect((await campaignDetail(db, a.owner, a.access, ids.campaignA!)).metrics.funnel.lost).toBe(1);
    // A person reviews the recovery email and sends it from their own mailbox.
    await markOutreachMessageSent(db, a.owner, a.access, rc.outreach_id);
    expect(await one(a.orgId, `select status, approved_by from backlink_outreach where id = $1`, [rc.outreach_id])).toMatchObject({
      status: "sent",
      approved_by: a.owner.userId
    });
    expect((await one(a.orgId, `select status from backlink_recovery_campaigns where id = $1`, [rc.id])).status).toBe("in_progress");
    // The destination restores the listing -> detected as recovered.
    await admin(dest, "/admin/listings/1/approve");
    await makeDue({ submissionId: ids.subA });
    await runner.drain();
    sub = await destSubmission(ids.websiteA!);
    expect(sub.status).toBe("VERIFIED");
    expect((await one(a.orgId, `select status from backlink_recovery_campaigns where submission_id = $1`, [sub.id])).status).toBe("recovered");
  });

  test("TEST 8: pause and resume a campaign", async () => {
    ids.websiteE = await newWebsite(a, "Ember Insights", "https://ember-insights.com/", "autopilot", [sourceId]);
    await registerTestDestination(a.orgId, a.owner.userId, dest, "browser-form", { submissionPath: "/submit" });
    const c = await testDestCampaign(ids.websiteE, "Pause test", ["browser-form"]);
    // Discover, qualify and plan without a browser worker: the submission waits in SUBMISSION_QUEUED.
    await runner.drain({ types: Object.keys(runner.handlers).filter((t) => t !== BACKLINK_JOBS.executeBrowser) });
    let s = await destSubmission(ids.websiteE);
    expect(s.status).toBe("SUBMISSION_QUEUED");
    const paused = await pauseBacklinkCampaign(db, a.owner, a.access, c.id);
    expect(paused.cancelledJobs).toBeGreaterThanOrEqual(1);
    // A job created before the pause (or a stale retry) is deferred, not executed.
    await tenant(db, a.orgId, (tx) =>
      enqueueJob(tx, {
        organizationId: a.orgId,
        websiteId: ids.websiteE,
        campaignId: c.id,
        jobType: BACKLINK_JOBS.executeBrowser,
        payload: { submission_id: s.id },
        idempotencyKey: `stale:${s.id}`
      })
    );
    const during = await runner.drain();
    expect(during.find((o) => o.jobType === BACKLINK_JOBS.executeBrowser)?.outcome).toBe("deferred");
    s = await destSubmission(ids.websiteE);
    expect(s.status).toBe("SUBMISSION_QUEUED");
    expect(dest.state.listings.some((l) => l.business_name === "Ember Insights")).toBe(false);
    expect((await events(s.id)).some((e) => /Campaign paused/.test(e.message ?? ""))).toBe(true);
    // Resume: execution is re-queued and completes.
    await resumeBacklinkCampaign(db, a.owner, a.access, c.id);
    await runner.drain();
    s = await destSubmission(ids.websiteE);
    expect(["SUBMITTED", "PENDING_VERIFICATION"]).toContain(s.status);
    expect(dest.state.listings.filter((l) => l.business_name === "Ember Insights")).toHaveLength(1);
    const audit = await q(a.orgId, `select action from audit_logs where entity_id = $1 order by created_at`, [c.id]);
    expect(audit.map((x) => x.action)).toEqual(expect.arrayContaining(["campaign.paused", "campaign.resumed"]));
  }, 300_000);

  test("MANUAL mode: tasks with prepared content; a user-reported URL is verified by the crawler", async () => {
    const wId = await newWebsite(a, "Fjord Funnels", "https://fjord-funnels.com/", "manual");
    await registerTestDestination(a.orgId, a.owner.userId, dest, "listing-api-v1");
    await testDestCampaign(wId, "Manual mode", ["listing-api-v1"]);
    await runner.drain();
    const s = await destSubmission(wId);
    expect(s.status).toBe("MANUAL_ACTION_REQUIRED");
    expect(dest.state.listings.some((l) => l.business_name === "Fjord Funnels")).toBe(false);
    // A person submits by hand, the moderator publishes, the user reports the URL.
    const res = await fetch(`${dest.url}/api/v1/listings`, {
      method: "POST",
      headers: { authorization: "Bearer test-api-token", "content-type": "application/json" },
      body: JSON.stringify({
        business_name: "Fjord Funnels",
        website_url: "https://fjord-funnels.com/analytics",
        contact_email: "hello@fjord-funnels.com"
      })
    });
    const listing = (await res.json()) as { id: number; listing_url: string };
    await admin(dest, `/admin/listings/${listing.id}/approve`);
    const task = await one(a.orgId, `select id, payload from backlink_tasks where submission_id = $1 and status = 'open'`, [s.id]);
    expect(task.payload.values.business_name).toBe("Fjord Funnels"); // prepared content for the person
    await resolveBacklinkTask(db, a.owner, a.access, task.id, { action: "submitted_manually", live_url: listing.listing_url });
    await runner.drain();
    expect((await destSubmission(wId)).status).toBe("VERIFIED");
  }, 120_000);

  test("worker_user still touches only the queue tables", async () => {
    await expect(worker.query("select count(*) from backlink_submissions")).rejects.toThrow(/permission denied/);
    await expect(worker.query("select count(*) from business_profiles")).rejects.toThrow(/permission denied/);
  });
});
