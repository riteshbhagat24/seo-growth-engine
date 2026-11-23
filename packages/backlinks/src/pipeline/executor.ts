/**
 * Submission executor ('backlinks.execute' / 'backlinks.execute_browser' jobs).
 * Gates: campaign active, authorisation (approval or autopilot decision recorded), adapter readiness,
 * campaign/domain/platform rate limits, plan allowances, duplicate-safety on retries.
 */
import crypto from "node:crypto";
import { AppError, assertWithinLimit, consumeUsage, decryptSecret } from "@sge/core";
import { tenant, type SqlTx as Tx } from "../sql";
import { getAdapter } from "../adapters/registry";
import type { AdapterContext, AdapterResult, Evidence, SourceInfo, SubmissionValues } from "../adapters/types";
import type { AssetType, BusinessProfile } from "../assets/generator";
import { transition, recordEvent } from "../submissions/state";
import { BACKLINK_JOBS, enqueueJob, secondsToNextMonth, type EngineJobContext } from "../jobs";
import { DeferError, PermanentError, RetryableError } from "../errors";
import { checkSubmissionLimits, createTask, SOURCE_JSON, type TaskType } from "./common";

/** Evidence is stored in Postgres (RLS-protected), so the web app can show it wherever it runs. */
export const EVIDENCE_MAX_BYTES = 2 * 1024 * 1024;
const TEXT_MAX = 200_000;

const credentialsAad = (orgId: string, sourceId: string) => `${orgId}:backlink_source:${sourceId}`;

/** Destination credentials of a workspace source, decrypted for one adapter run. */
export async function sourceCredentials(tx: Tx, orgId: string, source: SourceInfo | null, key?: Buffer): Promise<Record<string, string> | null> {
  if (!source?.has_credentials || source.organization_id !== orgId) return null;
  const row = await tx.maybe<{ credentials_enc: string }>(`select credentials_enc from backlink_sources where id = $1 and organization_id = $2`, [
    source.id,
    orgId
  ]);
  if (!row?.credentials_enc) return null;
  try {
    return JSON.parse(decryptSecret(row.credentials_enc, credentialsAad(orgId, source.id), key)) as Record<string, string>;
  } catch {
    throw new PermanentError("Stored destination credentials could not be decrypted; enter them again");
  }
}
export { credentialsAad };

const HUMAN_TASK: Record<string, TaskType> = {
  captcha_required: "captcha_required",
  email_verification: "email_verification",
  login_required: "login_required",
  manual_review: "manual_review",
  manual_submission: "manual_submission",
  outreach_send: "outreach_send"
};

const CONTENT_TYPES: Record<string, string> = { png: "image/png", html: "text/html", txt: "text/plain", json: "application/json" };

export async function storeEvidence(tx: Tx, orgId: string, submissionId: string, items: Evidence[]): Promise<number> {
  let total = 0;
  for (const e of items) {
    const raw = e.binary ?? (e.content !== undefined ? Buffer.from(e.content, "utf8") : null);
    if (!raw) continue;
    const sha = crypto.createHash("sha256").update(raw).digest("hex");
    const meta: Record<string, unknown> = { ...(e.meta ?? {}) };
    let data: Buffer | null = null;
    let content: string | null = null;
    if (e.binary) {
      if (raw.length <= EVIDENCE_MAX_BYTES) data = raw;
      else meta.not_stored = `larger than ${EVIDENCE_MAX_BYTES} bytes`;
    } else {
      content = e.content!.length > TEXT_MAX ? e.content!.slice(0, TEXT_MAX) : e.content!;
      if (content.length < e.content!.length) meta.truncated = true;
    }
    total += raw.length;
    await tx.exec(
      `insert into backlink_submission_evidence (organization_id, submission_id, kind, sha256, bytes, content, data, content_type, meta)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        orgId,
        submissionId,
        e.kind,
        sha,
        raw.length,
        content,
        data,
        CONTENT_TYPES[e.extension ?? (e.binary ? "bin" : "txt")] ?? "application/octet-stream",
        JSON.stringify(meta)
      ]
    );
  }
  return total;
}

async function isAuthorised(tx: Tx, submissionId: string): Promise<boolean> {
  const row = await tx.maybe(
    `select 1 from backlink_submission_events
      where submission_id = $1 and to_status = 'APPROVED'
        and (actor_type = 'user' or (actor_type = 'system' and data ->> 'policy' = 'autopilot'))
      limit 1`,
    [submissionId]
  );
  return !!row;
}

export async function executeSubmissionJob(ctx: EngineJobContext): Promise<unknown> {
  const { submission_id: submissionId } = ctx.job.payload as { submission_id: string };
  const orgId = ctx.job.organization_id;

  // ---- 1. Gates (inside a tenant transaction) ---------------------------------------------
  const prep = await tenant(ctx.db, orgId, async (tx) => {
    const s = await tx.maybe<any>(
      `select s.*, c.status as campaign_status, o.url as opportunity_url, o.opportunity_type,
              ${SOURCE_JSON} as source
         from backlink_submissions s
         join backlink_campaigns c on c.id = s.campaign_id
         join backlink_opportunities o on o.id = s.opportunity_id
         left join backlink_sources src on src.id = s.source_id
        where s.id = $1 for update of s`,
      [submissionId]
    );
    if (!s) return { stop: "submission not found" } as const;
    const adapter = getAdapter(s.adapter_key);
    if (s.status === "SUBMITTING") {
      // A previous attempt died mid-flight. Only idempotent adapters may safely retry.
      if (adapter.manifest.retryPolicy.idempotent) {
        await transition(tx, s.id, "SUBMISSION_QUEUED", {
          actorType: "worker",
          actorId: ctx.workerId,
          message: "Recovered interrupted attempt (idempotent adapter)"
        });
        s.status = "SUBMISSION_QUEUED";
      } else {
        await transition(tx, s.id, "MANUAL_ACTION_REQUIRED", {
          actorType: "worker",
          actorId: ctx.workerId,
          message: "Previous attempt was interrupted; outcome unknown"
        });
        await createTask(tx, {
          organizationId: orgId,
          websiteId: s.website_id,
          campaignId: s.campaign_id,
          submissionId: s.id,
          type: "manual_review",
          title: `Check whether ${s.destination_domain} received the submission`,
          instructions:
            "A submission attempt was interrupted after it may have reached the destination. Check for an existing listing before resuming, to avoid duplicates."
        });
        return { stop: "interrupted attempt routed to human" } as const;
      }
    }
    if (s.status !== "SUBMISSION_QUEUED") return { stop: `submission is ${s.status}` } as const;
    if (s.campaign_status === "paused") {
      await recordEvent(tx, s.id, { actorType: "worker", actorId: ctx.workerId, message: "Campaign paused — execution deferred" });
      return { defer: 3600, reason: "Campaign is paused" } as const;
    }
    if (s.campaign_status !== "active") {
      await transition(tx, s.id, "CANCELLED", { actorType: "worker", message: `Campaign is ${s.campaign_status}` });
      return { stop: `campaign ${s.campaign_status}` } as const;
    }
    if (!(await isAuthorised(tx, s.id))) throw new PermanentError("Submission has no recorded approval or autopilot authorisation");
    const limits = await checkSubmissionLimits(tx, s, adapter);
    if (!limits.ok) {
      await recordEvent(tx, s.id, {
        actorType: "worker",
        actorId: ctx.workerId,
        message: `Rate limited: ${limits.reason}`,
        data: { retry_after_seconds: limits.retryAfterSeconds }
      });
      return { defer: limits.retryAfterSeconds ?? 3600, reason: limits.reason ?? "rate limited" } as const;
    }
    // Plan allowances: links the verifier may monitor, and automated submissions per month (counted once per submission).
    try {
      await assertWithinLimit(tx.tx, orgId, "backlinks_monitored", 1);
    } catch (e) {
      if (e instanceof AppError && e.code === "limit_reached") {
        await recordEvent(tx, s.id, { actorType: "worker", actorId: ctx.workerId, message: `Deferred: ${e.message}` });
        return { defer: 86400, reason: e.message } as const;
      }
      throw e;
    }
    if (s.attempt_count === 0 && !(await consumeUsage(tx.tx, orgId, "backlink_submissions_month", 1))) {
      await recordEvent(tx, s.id, {
        actorType: "worker",
        actorId: ctx.workerId,
        message: "Deferred: this month's automated-submission allowance is used up"
      });
      return { defer: secondsToNextMonth(), reason: "Monthly automated-submission allowance used up" } as const;
    }
    const credentials = await sourceCredentials(tx, orgId, s.source as SourceInfo | null, ctx.rt.encryptionKey);
    const profile = await tx.one<BusinessProfile>(`select * from business_profiles where website_id = $1`, [s.website_id]);
    const assetRows = await tx.q<{ id: string; asset_type: AssetType; title: string | null; body: string; status: string }>(
      `select id, asset_type, title, body, status from backlink_assets where id = any($1::uuid[])`,
      [s.asset_ids]
    );
    await transition(tx, s.id, "SUBMITTING", {
      actorType: "worker",
      actorId: ctx.workerId,
      message: `Attempt ${s.attempt_count + 1} via ${adapter.manifest.key}`,
      patch: { attempt_count: s.attempt_count + 1 }
    });
    return { s, adapter, profile, credentials, assets: Object.fromEntries(assetRows.map((a) => [a.asset_type, a])) };
  });
  if ("stop" in prep) return prep;
  if ("defer" in prep) throw new DeferError(Number(prep.defer ?? 3600), String(prep.reason ?? "deferred"));
  const { s, adapter, profile, assets, credentials } = prep;

  // ---- 2. Execute the adapter (no DB transaction held) -------------------------------------
  const actx: AdapterContext = {
    submission: { ...s, attempt_count: s.attempt_count + 1 },
    source: s.source as SourceInfo | null,
    opportunity: { url: s.opportunity_url, opportunity_type: s.opportunity_type },
    profile,
    assets,
    values: (s.payload?.values ?? {}) as SubmissionValues,
    idempotencyKey: `sge-${s.id}`,
    credentials,
    rt: ctx.rt,
    db: ctx.db,
    log: ctx.log,
    signal: ctx.signal
  };
  let result: AdapterResult;
  try {
    result = await adapter.submit(actx);
  } catch (err) {
    result = { outcome: "failed", retryable: true, error: (err as Error).message, evidence: [] };
  }

  // ---- 3. Persist outcome --------------------------------------------------------------
  const lastAttempt = ctx.job.attempts >= ctx.job.max_attempts;
  const outcome = await tenant(ctx.db, orgId, async (tx) => {
    await storeEvidence(tx, orgId, s.id, result.evidence);
    switch (result.outcome) {
      case "submitted": {
        await transition(tx, s.id, "SUBMITTED", {
          actorType: "worker",
          actorId: ctx.workerId,
          message: result.confirmationText,
          patch: {
            submitted_at: new Date(),
            confirmation_text: result.confirmationText,
            response: { ...result.response, external_id: result.externalId ?? null },
            live_url: result.liveUrl ?? null,
            error_message: null
          }
        });
        await transition(tx, s.id, "PENDING_VERIFICATION", {
          actorType: "system",
          message: "Submitted is not acquired: awaiting publication and crawler verification"
        });
        const delay = Number(s.source?.form_mapping?.verify_after_seconds ?? 3600);
        await enqueueJob(tx, {
          organizationId: orgId,
          websiteId: s.website_id,
          campaignId: s.campaign_id,
          jobType: BACKLINK_JOBS.verify,
          payload: { submission_id: s.id, check: 1 },
          runAt: new Date(Date.now() + delay * 1000),
          idempotencyKey: `verify:${s.id}:1`
        });
        return { outcome: "SUBMITTED" };
      }
      case "human_required": {
        await transition(tx, s.id, "MANUAL_ACTION_REQUIRED", {
          actorType: "worker",
          actorId: ctx.workerId,
          message: `Paused for a person: ${result.reason}`,
          data: { reason: result.reason }
        });
        await createTask(tx, {
          organizationId: orgId,
          websiteId: s.website_id,
          campaignId: s.campaign_id,
          submissionId: s.id,
          type: HUMAN_TASK[result.reason] ?? "manual_review",
          title: `${result.reason.replace(/_/g, " ")} — ${s.destination_domain}`,
          instructions: result.instructions,
          payload: result.payload ?? {},
          dueInHours: 72
        });
        return { outcome: "MANUAL_ACTION_REQUIRED", reason: result.reason };
      }
      case "rejected": {
        await transition(tx, s.id, "REJECTED", {
          actorType: "worker",
          actorId: ctx.workerId,
          message: `Destination rejected the submission: ${result.reason}`,
          patch: { error_message: result.reason }
        });
        await tx.exec(`update backlink_opportunities set status = 'DONE' where id = $1`, [s.opportunity_id]);
        return { outcome: "REJECTED", reason: result.reason };
      }
      case "failed": {
        if (result.retryable && !lastAttempt) {
          await transition(tx, s.id, "SUBMISSION_QUEUED", {
            actorType: "worker",
            actorId: ctx.workerId,
            message: `Temporary failure, will retry: ${result.error}`,
            patch: { error_message: result.error }
          });
          return { outcome: "RETRY", error: result.error, retryAfter: result.retryAfterSeconds };
        }
        await transition(tx, s.id, "FAILED", {
          actorType: "worker",
          actorId: ctx.workerId,
          message: `Failed: ${result.error}`,
          patch: { error_message: result.error }
        });
        await createTask(tx, {
          organizationId: orgId,
          websiteId: s.website_id,
          campaignId: s.campaign_id,
          submissionId: s.id,
          type: "adapter_error",
          title: `Submission to ${s.destination_domain} failed`,
          instructions: result.error
        });
        return { outcome: "FAILED", error: result.error, permanent: !result.retryable };
      }
    }
  });
  if (outcome.outcome === "RETRY") throw new RetryableError(String(outcome.error), (outcome as any).retryAfter);
  if (outcome.outcome === "FAILED") throw new PermanentError(`Submission failed: ${(outcome as any).error ?? (outcome as any).reason}`);
  return outcome;
}
