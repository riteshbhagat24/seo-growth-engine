/**
 *  - manual-editorial (manual_editorial): prepares everything and hands the submission to a person.
 *  - outreach-email   (outreach): sends a HUMAN-APPROVED pitch from the workspace's own mailbox, one recipient at
 *    a time (never bulk). Without a workspace mailbox it becomes a "send from your mailbox" task.
 */
import { tenant } from "../sql";
import type { Adapter, AdapterContext, AdapterResult } from "./types";

/** Messages a workspace may send through its own mailbox per day. */
export const OUTREACH_DAILY_CAP = 20;

export const manualAdapter: Adapter = {
  manifest: {
    key: "manual-editorial",
    name: "Manual / editorial submission",
    type: "manual_editorial",
    version: "1.0.0",
    description:
      "For destinations that do not permit automation (accounts, verification, editorial review). Prepares assets and a task; a person submits and reports the URL.",
    operations: ["submit"],
    authentication: { kind: "user_account", description: "The user signs in with their own account where one is needed." },
    submissionFields: [{ key: "all prepared values", required: true, source: "approved profile + generated assets" }],
    requiredUserInformation: ["A person to complete the submission", "Listing/article URL once published"],
    permissionRequirements: {
      accepted: ["none", "manual_only", "tos_permits_form", "explicit_permission", "own_property", "test_destination"],
      notes: "No automation is performed."
    },
    rateLimits: { perDomainPerDay: 1, perDomainPerWeek: 2, minIntervalSeconds: 0 },
    verificationMethod: "user_reported_url_then_crawl",
    errorHandling: "Not applicable; the task stays open until resolved or dismissed.",
    retryPolicy: { maxAttempts: 1, retryOn: [], idempotent: true },
    statuses: "MANUAL_ACTION_REQUIRED -> SUBMITTED (user marks) -> PENDING_VERIFICATION -> VERIFIED",
    supportsAutopilot: false,
    queue: "light",
    implementationStatus: "implemented",
    testStatus: "live_tested",
    testEvidence: "packages/backlinks/test/acceptance-engine.test.ts (manual mode task + user-reported URL verified by crawler)"
  },
  validate: () => [],
  async submit(ctx: AdapterContext): Promise<AdapterResult> {
    return {
      outcome: "human_required",
      reason: "manual_submission",
      instructions: `Submit to ${ctx.source?.name ?? ctx.submission.destination_domain} manually at ${ctx.submission.submission_url ?? ctx.opportunity.url} using the prepared values, then mark this task done with the listing URL.`,
      payload: { prepared_values: ctx.values, destination: ctx.submission.submission_url ?? ctx.opportunity.url },
      evidence: []
    };
  }
};

export const outreachAdapter: Adapter = {
  manifest: {
    key: "outreach-email",
    name: "Approved one-to-one outreach email",
    type: "outreach",
    version: "1.0.0",
    description: "Sends one approved, personalised email to a publicly listed business contact from the user's own mailbox (SMTP).",
    operations: ["send"],
    authentication: {
      kind: "smtp",
      description: "The workspace's own mailbox. Not configured = \"send from your mailbox\" task (the platform's system mail is never used)."
    },
    submissionFields: [
      { key: "to", required: true, source: "public business contact found on the destination site (with source URL)" },
      { key: "subject/body", required: true, source: "approved outreach asset" }
    ],
    requiredUserInformation: ["Approval of every message", "Workspace mailbox (optional)"],
    permissionRequirements: {
      accepted: ["none", "manual_only", "tos_permits_form", "explicit_permission", "own_property", "test_destination"],
      notes: `Every message requires a recorded approval. Opt-outs are suppressed. At most ${OUTREACH_DAILY_CAP} messages per workspace per day.`
    },
    rateLimits: { perDomainPerDay: 1, perDomainPerWeek: 1, minIntervalSeconds: 120 },
    verificationMethod: "user_reported_url_then_crawl",
    errorHandling: "SMTP errors -> retry; missing SMTP -> manual send task; opted-out recipient -> CANCELLED.",
    retryPolicy: { maxAttempts: 3, retryOn: ["SMTP transient error"], idempotent: false },
    statuses: "AWAITING_APPROVAL -> APPROVED -> SUBMITTED (pitch sent; NOT a link) -> PENDING_VERIFICATION once a URL is reported",
    supportsAutopilot: false,
    queue: "light",
    implementationStatus: "implemented",
    testStatus: "contract_tested",
    testEvidence:
      "packages/backlinks/test/adapters.test.ts (approval gate, opt-out suppression, daily cap, no-mailbox task; send through an in-memory transport — no live mailbox)"
  },
  validate: () => [],
  async submit(ctx: AdapterContext): Promise<AdapterResult> {
    const org = ctx.submission.organization_id;
    const outreach = await tenant(ctx.db, org, (tx) =>
      tx.maybe<{ id: string; contact_email: string | null; subject: string | null; body: string | null; status: string; approved_at: Date | null }>(
        `select id, contact_email, subject, body, status, approved_at from backlink_outreach where submission_id = $1 order by created_at desc limit 1`,
        [ctx.submission.id]
      )
    );
    if (!outreach || outreach.status !== "approved" || !outreach.approved_at) {
      return { outcome: "rejected", reason: "Outreach message has not been approved — nothing was sent", evidence: [] };
    }
    const optedOut = await tenant(ctx.db, org, (tx) =>
      tx.maybe(`select 1 from backlink_exclusions where kind = 'email' and lower(value) = lower($1)`, [outreach.contact_email ?? ""])
    );
    if (optedOut) return { outcome: "rejected", reason: "Recipient has opted out", evidence: [] };
    if (!outreach.contact_email) {
      return {
        outcome: "human_required",
        reason: "outreach_send",
        instructions: "No public contact email was found. Use the destination's contact form with the approved message.",
        payload: { subject: outreach.subject, body: outreach.body },
        evidence: []
      };
    }
    const transport = ctx.rt.mail;
    if (!transport) {
      return {
        outcome: "human_required",
        reason: "outreach_send",
        instructions: `Send the approved message from your own mailbox to ${outreach.contact_email}, then mark this task done.`,
        payload: {
          to: outreach.contact_email,
          subject: outreach.subject,
          body: outreach.body,
          mailto: `mailto:${outreach.contact_email}?subject=${encodeURIComponent(outreach.subject ?? "")}`
        },
        evidence: []
      };
    }
    const sentToday = await tenant(ctx.db, org, (tx) =>
      tx.one<{ n: number }>(`select count(*) as n from backlink_outreach where sent_at >= date_trunc('day', now())`)
    );
    if (sentToday.n >= OUTREACH_DAILY_CAP)
      return {
        outcome: "failed",
        retryable: true,
        error: `Daily outreach limit (${OUTREACH_DAILY_CAP}) reached`,
        retryAfterSeconds: 3600,
        evidence: []
      };
    if (!ctx.values.email)
      return {
        outcome: "human_required",
        reason: "outreach_send",
        instructions: "The business profile has no contact email to send from.",
        evidence: []
      };
    const info = await transport.sendMail({
      from: ctx.values.email,
      to: outreach.contact_email,
      subject: outreach.subject ?? "",
      text: `${outreach.body}\n\n—\nIf you'd prefer not to hear from us again, just reply "unsubscribe" and we won't contact you again.`,
      headers: { "List-Unsubscribe": `<mailto:${ctx.values.email}?subject=unsubscribe>` }
    });
    await tenant(ctx.db, org, (tx) =>
      tx.exec(`update backlink_outreach set status = 'sent', sent_at = now(), next_followup_at = now() + interval '7 days' where id = $1`, [
        outreach.id
      ])
    );
    const confirmation = `Outreach email sent to ${outreach.contact_email} (message id ${info.messageId ?? "n/a"}). This is a pitch, not a backlink.`;
    return {
      outcome: "submitted",
      confirmationText: confirmation,
      response: { messageId: info.messageId ?? null },
      evidence: [{ kind: "email", content: JSON.stringify({ to: outreach.contact_email, subject: outreach.subject }) }]
    };
  }
};
