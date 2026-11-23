/**
 * Contract tests for the two adapters whose manifests say "contract_tested": the WordPress partner-draft API and
 * one-to-one outreach email. Both run against the project's own test destination / an in-memory mail transport.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { BACKLINK_JOBS, createBacklinkCampaign, decideBacklinkApproval, getAdapter, optOutContact, type MailTransport } from "../src/index";
import type { AdapterContext } from "../src/adapters/types";
import {
  closeAll,
  db,
  makeAgency,
  newWebsite,
  one,
  ownerInTenant,
  q,
  registerTestDestination,
  startTestDestination,
  testRuntime,
  TestRunner,
  type Agency,
  type TestDestination
} from "./helpers";

let dest: TestDestination;
let a: Agency;

beforeAll(async () => {
  dest = await startTestDestination();
  a = await makeAgency("Adapter Agency");
}, 60_000);

afterAll(async () => {
  await dest?.close();
  await closeAll();
});

describe("wordpress-draft adapter (publisher-issued application password)", () => {
  const wp = getAdapter("wordpress-draft");
  const ctx = (password: string, status = "approved"): AdapterContext =>
    ({
      submission: {
        id: "s",
        organization_id: "o",
        website_id: "w",
        submission_url: null,
        target_url: "https://acme.com/",
        anchor_text: "Acme",
        destination_domain: "d",
        attempt_count: 1
      },
      source: {
        id: "src",
        organization_id: "o",
        domain: "d",
        name: "Partner blog",
        homepage_url: `${dest.url}/`,
        submission_url: null,
        automation_permission: "test_destination",
        permission_evidence: {},
        form_mapping: {},
        api_config: { base_url: dest.url, username: "sge-partner" },
        has_credentials: true
      },
      opportunity: { url: dest.url, opportunity_type: "guest_post" },
      profile: {} as never,
      assets: { article_draft: { id: "a", title: "Choosing analytics", body: "Draft body", status } },
      values: {} as never,
      idempotencyKey: "k",
      credentials: { app_password: password },
      rt: testRuntime(dest),
      db,
      log: async () => undefined,
      signal: new AbortController().signal
    }) as AdapterContext;

  test("refuses an article no person has approved; creates a draft (never publishes) with valid credentials", async () => {
    expect(wp.validate(ctx("x", "draft"))).toContain("Article draft must be approved by a person before it is sent to the publisher");
    const r = await wp.submit(ctx("abcd efgh ijkl mnop"));
    expect(r.outcome).toBe("submitted");
    expect(dest.state.posts).toHaveLength(1);
    expect(dest.state.posts[0]).toMatchObject({ status: "draft", title: "Choosing analytics" });
    if (r.outcome === "submitted") expect(r.confirmationText).toMatch(/Draft post #100 created/);
    expect(JSON.stringify(r.evidence)).not.toContain("abcd efgh"); // the password never reaches evidence
  });

  test("rejected credentials fail without retrying", async () => {
    const r = await wp.submit(ctx("wrong password"));
    expect(r).toMatchObject({ outcome: "failed", retryable: false });
    expect(dest.state.posts).toHaveLength(1);
  });
});

describe("outreach-email adapter (approval-gated, one recipient, opt-outs suppressed)", () => {
  const sent: { to: string; subject: string; text: string; headers: Record<string, string> }[] = [];
  const mail: MailTransport = { sendMail: async (m) => (sent.push(m), { messageId: `<m${sent.length}@test>` }) };

  async function outreachCampaign(name: string, url: string, runner: TestRunner) {
    const sourceId = await registerTestDestination(a.orgId, a.owner.userId, dest, "outreach-email");
    await ownerInTenant(a.orgId, `update backlink_sources set source_type = 'guest_post' where id = $1`, [sourceId]);
    const w = await newWebsite(a, name, url);
    await createBacklinkCampaign(db, a.owner, a.access, {
      websiteId: w,
      name: `${name} outreach`,
      preferredCategories: ["guest_post"],
      allowedAdapters: ["outreach-email"],
      minQualityScore: 30
    });
    await runner.drain();
    const s = await one(a.orgId, `select * from backlink_submissions where website_id = $1`, [w]);
    expect(s.status).toBe("AWAITING_APPROVAL"); // every message needs a person's approval
    const o = await one(a.orgId, `select * from backlink_outreach where submission_id = $1`, [s.id]);
    expect(o).toMatchObject({ status: "awaiting_approval", outreach_type: "guest_post", contact_email: "editor@sge-test-directory.invalid" });
    expect(o.contact_source_url).toContain(dest.url); // where the public contact was found
    const approval = await one(a.orgId, `select id from backlink_approvals where subject_id = $1 and status = 'pending'`, [s.id]);
    await decideBacklinkApproval(db, a.owner, a.access, approval.id, "approved");
    await runner.drain();
    return { websiteId: w, submissionId: s.id as string, outreachId: o.id as string };
  }

  test("without a workspace mailbox the approved message becomes a 'send it yourself' task", async () => {
    const r = await outreachCampaign("Mailless Media", "https://mailless-media.com/", new TestRunner(testRuntime(dest)));
    expect((await one(a.orgId, `select status from backlink_submissions where id = $1`, [r.submissionId])).status).toBe("MANUAL_ACTION_REQUIRED");
    const task = await one(a.orgId, `select task_type, payload from backlink_tasks where submission_id = $1`, [r.submissionId]);
    expect(task.task_type).toBe("outreach_send");
    expect(task.payload.to).toBe("editor@sge-test-directory.invalid");
    expect(sent).toHaveLength(0);
  });

  test("with the workspace's own mailbox: one approved email, opt-out footer and header; opt-outs are then suppressed", async () => {
    const runner = new TestRunner({ ...testRuntime(dest), mail });
    const r = await outreachCampaign("Postbox Partners", "https://postbox-partners.com/", runner);
    const s = await one(a.orgId, `select status, confirmation_text from backlink_submissions where id = $1`, [r.submissionId]);
    expect(["SUBMITTED", "PENDING_VERIFICATION"]).toContain(s.status);
    expect(s.confirmation_text).toMatch(/This is a pitch, not a backlink/); // never counted as a link
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("editor@sge-test-directory.invalid");
    expect(sent[0]!.headers["List-Unsubscribe"]).toMatch(/^<mailto:/);
    expect(sent[0]!.text).toMatch(/reply "unsubscribe"/);
    expect((await one(a.orgId, `select status from backlink_outreach where id = $1`, [r.outreachId])).status).toBe("sent");

    // The recipient opts out: suppressed across the workspace, and a later approved pitch is not sent.
    await optOutContact(db, a.owner, a.access, r.outreachId);
    expect(await q(a.orgId, `select kind, value from backlink_exclusions where kind = 'email'`)).toEqual([
      { kind: "email", value: "editor@sge-test-directory.invalid" }
    ]);
    const again = await outreachCampaign("Second Signal", "https://second-signal.com/", runner);
    expect(await one(a.orgId, `select status, error_message from backlink_submissions where id = $1`, [again.submissionId])).toMatchObject({
      status: "REJECTED",
      error_message: expect.stringMatching(/opted out/)
    });
    expect(sent).toHaveLength(1);
    expect((await q(a.orgId, `select 1 from jobs where type = $1 and status = 'failed'`, [BACKLINK_JOBS.execute])).length).toBe(0);
  }, 120_000);
});
