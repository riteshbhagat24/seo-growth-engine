/**
 * Permitted public submission form adapter (no browser). Fetches the form, maps approved information onto
 * its fields, posts it (including CSRF hidden fields/cookies) and captures the confirmation response.
 * CAPTCHA, login walls, email verification, unknown required fields and un-accepted terms pause the
 * workflow and create a human task. Never reports an unconfirmed attempt as submitted.
 */
import crypto from "node:crypto";
import { extractPage } from "../net/html";
import type { SafeResponse } from "../net/fetcher";
import { PolicyBlockedError } from "../net/policy";
import { redactHeaders } from "./api-adapters";
import { chooseForm, confirmationSnippet, CONFIRMATION_RE, EMAIL_VERIFY_RE, FORM_ERROR_RE, outcomeText, planFill } from "./form-fill";
import { AUTOPILOT_PERMISSIONS, type Adapter, type AdapterContext, type AdapterResult, type Evidence } from "./types";

function cookiesFrom(res: SafeResponse): string {
  const sc = res.headers["set-cookie"];
  const list = Array.isArray(sc) ? sc : sc ? [sc] : [];
  return list.map((c) => c.split(";")[0]).join("; ");
}

function exchange(method: string, url: string, res: SafeResponse | null, extra: Record<string, unknown> = {}): Evidence {
  return {
    kind: "http_exchange",
    content: JSON.stringify(
      {
        request: { method, url, ...extra },
        response: res
          ? { status: res.status, url: res.url, redirects: res.redirects, headers: redactHeaders(res.headers), body_excerpt: res.text.slice(0, 4000) }
          : null
      },
      null,
      2
    ),
    meta: { status: res?.status ?? null }
  };
}

/** multipart/form-data with text fields only: file uploads are never automated. */
function multipart(fields: Record<string, string>): { body: Buffer; contentType: string } {
  const boundary = `----sge${crypto.randomBytes(12).toString("hex")}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k.replace(/["\r\n]/g, "")}"\r\n\r\n${v}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

export const httpFormAdapter: Adapter = {
  manifest: {
    key: "http-form",
    name: "Permitted public submission form (HTTP)",
    type: "public_form",
    version: "1.0.0",
    description: "Submits approved business information to a public HTML form without a browser. For simple server-rendered forms.",
    operations: ["submit"],
    authentication: { kind: "none", description: "Public form; no login. Login-walled forms are routed to a human task." },
    submissionFields: [
      { key: "business_name", required: true, source: "profile.business_name" },
      { key: "website_url", required: true, source: "campaign target page / profile.website_url" },
      { key: "email", required: false, source: "profile.contact_email" },
      { key: "short_description", required: false, source: "asset.short_description", maxLength: 160 },
      { key: "long_description", required: false, source: "asset.long_description" },
      { key: "category", required: false, source: "profile.industry" }
    ],
    requiredUserInformation: ["Approved business profile", "Terms acceptance recorded by a person when the form has a terms checkbox"],
    permissionRequirements: {
      accepted: ["tos_permits_form", "explicit_permission", "own_property", "test_destination"],
      notes: "The source must record that its terms permit form submission by a business representative (or explicit permission)."
    },
    rateLimits: { perDomainPerDay: 1, perDomainPerWeek: 2, minIntervalSeconds: 300 },
    verificationMethod: "crawl_live_url",
    errorHandling:
      "Validation errors -> REJECTED; CAPTCHA/login/email verification/unknown required field -> MANUAL_ACTION_REQUIRED; network/5xx -> retry; ambiguous response -> human confirmation task (never counted).",
    retryPolicy: { maxAttempts: 3, retryOn: ["network error", "timeout", "HTTP 429", "HTTP 5xx before submission"], idempotent: false },
    statuses: "SUBMITTING -> SUBMITTED | REJECTED | FAILED | MANUAL_ACTION_REQUIRED",
    supportsAutopilot: true,
    queue: "crawl",
    implementationStatus: "implemented",
    testStatus: "live_tested",
    testEvidence: "packages/backlinks/test/acceptance-engine.test.ts (TEST 4b http-form path) against the approved test destination"
  },

  validate({ source }) {
    const problems: string[] = [];
    if (!source) problems.push("No source record (form adapter requires a known source with permission evidence)");
    else if (!this.manifest.permissionRequirements.accepted.includes(source.automation_permission)) {
      problems.push(`Source permission "${source.automation_permission}" does not allow automated form submission`);
    }
    return problems;
  },

  async submit(ctx: AdapterContext): Promise<AdapterResult> {
    const evidence: Evidence[] = [];
    const formUrl = ctx.submission.submission_url ?? ctx.source?.submission_url ?? ctx.opportunity.url;
    const explicitPermission = AUTOPILOT_PERMISSIONS.includes(ctx.source!.automation_permission);
    let page: SafeResponse;
    try {
      page = await ctx.rt.fetcher.fetch(formUrl, { respectRobots: !explicitPermission });
    } catch (err) {
      if (err instanceof PolicyBlockedError && err.code === "robots") {
        return {
          outcome: "human_required",
          reason: "manual_review",
          instructions: `robots.txt disallows automated access to ${formUrl}. Submit manually with the prepared values if appropriate.`,
          evidence
        };
      }
      if (err instanceof PolicyBlockedError && err.code !== "timeout" && err.code !== "dns_failure") {
        return { outcome: "rejected", reason: `Blocked by policy: ${err.message}`, evidence };
      }
      return { outcome: "failed", retryable: true, error: `Could not load form: ${(err as Error).message}`, evidence };
    }
    evidence.push(exchange("GET", formUrl, page));
    if (page.status >= 500 || page.status === 429)
      return { outcome: "failed", retryable: true, error: `Form page returned HTTP ${page.status}`, evidence };
    if (page.status >= 400) return { outcome: "rejected", reason: `Form page returned HTTP ${page.status}`, evidence };
    const info = extractPage(page.text, page.url);
    const form = chooseForm(info.forms, ctx.source);
    if (!form)
      return {
        outcome: "human_required",
        reason: "manual_review",
        instructions: `No submission form found at ${formUrl}. Review the page and submit manually if appropriate.`,
        evidence
      };
    if (form.hasPassword)
      return {
        outcome: "human_required",
        reason: "login_required",
        instructions: `The form at ${formUrl} requires an account login. Sign in yourself (no fake accounts are created) and submit using the prepared information.`,
        evidence
      };
    if (form.hasCaptcha || info.captcha) {
      return {
        outcome: "human_required",
        reason: "captcha_required",
        instructions: `The form at ${formUrl} is protected by a CAPTCHA (${info.captcha?.kind ?? "detected"}). CAPTCHAs are never bypassed — open the page, paste the prepared values and submit it yourself, then mark the task done with the listing URL if shown.`,
        payload: { form_url: formUrl, prepared_values: planFill(form, ctx.values, ctx.source).values },
        evidence
      };
    }
    const plan = planFill(form, ctx.values, ctx.source);
    if (plan.unmappedRequired.length) {
      return {
        outcome: "human_required",
        reason: "manual_review",
        instructions: `The form requires information we will not invent: ${plan.unmappedRequired.map((u) => `${u.label} (${u.reason})`).join("; ")}.`,
        payload: { form_url: formUrl, prepared_values: plan.values, unmapped: plan.unmappedRequired },
        evidence
      };
    }
    const fields: Record<string, string> = { ...form.hiddenFields, ...plan.values };
    for (const c of plan.checkboxes) fields[c] = "on";
    let body: string | Buffer;
    let contentType: string;
    if (form.enctype.includes("multipart")) {
      const mp = multipart(fields);
      body = mp.body;
      contentType = mp.contentType;
    } else {
      body = new URLSearchParams(fields).toString();
      contentType = "application/x-www-form-urlencoded";
    }
    let res: SafeResponse;
    try {
      res = await ctx.rt.fetcher.fetch(form.action, {
        method: form.method === "POST" ? "POST" : "GET",
        body: form.method === "POST" ? body : undefined,
        headers: { "content-type": contentType, cookie: cookiesFrom(page), referer: page.url, origin: new URL(page.url).origin },
        respectRobots: false // posting a permitted form is not crawling; permission comes from the source record
      });
    } catch (err) {
      // We cannot know whether the destination processed the request — do not blindly retry (duplicate risk).
      evidence.push({ kind: "note", content: `POST failed: ${(err as Error).message}` });
      return {
        outcome: "human_required",
        reason: "manual_review",
        instructions: `The submission request to ${form.action} failed mid-flight (${(err as Error).message}). Check the destination for an existing listing before retrying to avoid duplicates.`,
        evidence
      };
    }
    evidence.push(exchange(form.method, form.action, res, { fields: Object.keys(fields) }));
    evidence.push({ kind: "html_snapshot", content: res.text.slice(0, 200_000), extension: "html", meta: { url: res.url } });
    const text = outcomeText(res.text);
    const customOk = ctx.source?.form_mapping?.confirmation_pattern ? new RegExp(ctx.source.form_mapping.confirmation_pattern, "i") : null;
    if (res.status === 429 || res.status >= 500) {
      return {
        outcome: "human_required",
        reason: "manual_review",
        instructions: `Destination returned HTTP ${res.status} after submission; check for an existing listing before retrying.`,
        evidence
      };
    }
    if (EMAIL_VERIFY_RE.test(text)) {
      return {
        outcome: "human_required",
        reason: "email_verification",
        instructions: `The destination sent a verification email to ${ctx.values.email}. Click the link in that email, then mark this task done.`,
        evidence
      };
    }
    if (res.status < 400 && (customOk?.test(text) || CONFIRMATION_RE.test(text)) && !(FORM_ERROR_RE.test(text) && !CONFIRMATION_RE.test(text))) {
      const sentence = confirmationSnippet(res.text);
      evidence.push({ kind: "confirmation_text", content: sentence });
      const listing = res.text.match(/href=["']([^"']*\/listing\/[^"']+)["']/i)?.[1] ?? sentence.match(/https?:\/\/\S+|\/listing\/\S+/)?.[0] ?? null;
      return {
        outcome: "submitted",
        confirmationText: sentence,
        response: { status: res.status, url: res.url },
        liveUrl: listing ? new URL(listing.replace(/[.,)]+$/, ""), res.url).toString() : null,
        evidence
      };
    }
    if (res.status >= 400 || FORM_ERROR_RE.test(text)) {
      return {
        outcome: "rejected",
        reason: (text.match(/[^.!?]*(error|invalid|required|already|duplicate|rejected)[^.!?]*[.!?]?/i)?.[0] ?? `HTTP ${res.status}`).trim(),
        evidence
      };
    }
    return {
      outcome: "human_required",
      reason: "manual_review",
      instructions: "The destination response did not clearly confirm the submission. Check the destination and mark the outcome manually.",
      evidence
    };
  }
};
