/**
 * Approved browser automation adapter (Playwright / Chromium). Runs ONLY in the long-lived worker
 * (queue 'browser'), never inside Vercel functions.
 *
 * Opens the approved submission page, fills approved business information (handling site-specific
 * variations via form-fill mapping), uploads authorised assets, submits, captures confirmation text,
 * timestamps and screenshots. Honest user agent; no stealth plugins; no CAPTCHA solving; no account
 * creation. All browser traffic is forced through the SSRF-safe egress proxy.
 */
import type { Browser } from "playwright";
import { USER_AGENT } from "@sge/crawler";
import { extractPage } from "../net/html";
import { startEgressProxy } from "../browser/egress-proxy";
import { chooseForm, confirmationSnippet, CONFIRMATION_RE, EMAIL_VERIFY_RE, FORM_ERROR_RE, outcomeText, planFill } from "./form-fill";
import type { Adapter, AdapterContext, AdapterResult, Evidence } from "./types";

function cssAttr(v: string): string {
  return v.replace(/["\\]/g, "\\$&");
}

export const browserFormAdapter: Adapter = {
  manifest: {
    key: "browser-form",
    name: "Approved browser automation (Playwright)",
    type: "browser_automation",
    version: "1.0.0",
    description: "Fills and submits JavaScript-rendered public forms in headless Chromium, with screenshots as evidence.",
    operations: ["submit"],
    authentication: { kind: "none", description: "Public forms only. Login, CAPTCHA and email verification are routed to human tasks." },
    submissionFields: [
      { key: "business_name", required: true, source: "profile.business_name" },
      { key: "website_url", required: true, source: "campaign target page / profile.website_url" },
      { key: "email", required: false, source: "profile.contact_email" },
      { key: "short_description", required: false, source: "asset.short_description", maxLength: 160 },
      { key: "long_description", required: false, source: "asset.long_description" }
    ],
    requiredUserInformation: ["Approved business profile", "Terms acceptance recorded by a person when required"],
    permissionRequirements: {
      accepted: ["tos_permits_form", "explicit_permission", "own_property", "test_destination"],
      notes:
        "Only for sources whose terms, permissions and technical controls permit automated submission. Bot-detection challenges are never evaded."
    },
    rateLimits: { perDomainPerDay: 1, perDomainPerWeek: 2, minIntervalSeconds: 600 },
    verificationMethod: "crawl_live_url",
    errorHandling:
      "CAPTCHA/login/email verification/unknown fields -> MANUAL_ACTION_REQUIRED; navigation timeout before submit -> retry; failure after clicking submit -> human confirmation (duplicate protection).",
    retryPolicy: { maxAttempts: 3, retryOn: ["page load failure before submit", "browser crash before submit"], idempotent: false },
    statuses: "SUBMITTING -> SUBMITTED | REJECTED | FAILED | MANUAL_ACTION_REQUIRED",
    supportsAutopilot: true,
    queue: "browser",
    implementationStatus: "implemented",
    testStatus: "live_tested",
    testEvidence:
      "packages/backlinks/test/acceptance-engine.test.ts (TEST 4b browser path, CAPTCHA pause; TEST 8) against the approved test destination"
  },
  needsBrowser: true,

  validate({ source }) {
    if (!source) return ["No source record"];
    if (!this.manifest.permissionRequirements.accepted.includes(source.automation_permission)) {
      return [`Source permission "${source.automation_permission}" does not allow browser automation`];
    }
    return [];
  },

  async submit(ctx: AdapterContext): Promise<AdapterResult> {
    const evidence: Evidence[] = [];
    const formUrl = ctx.submission.submission_url ?? ctx.source?.submission_url ?? ctx.opportunity.url;
    const policy = ctx.rt.fetcher.policy;
    policy.assertAllowed(formUrl);
    if (!ctx.rt.browser) return { outcome: "failed", retryable: true, error: "Browser automation is not enabled on this worker", evidence };
    // Loaded only here: the web app never bundles or starts a browser.
    const { chromium } = await import("playwright");
    const proxy = await startEgressProxy(policy);
    let browser: Browser | null = null;
    let clicked = false;
    try {
      browser = await chromium.launch({
        headless: true,
        proxy: { server: proxy.url, bypass: "<-loopback>" },
        args: ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--no-first-run", "--disable-background-networking"]
      });
      const context = await browser.newContext({ userAgent: USER_AGENT, acceptDownloads: false, serviceWorkers: "block" });
      await context.route("**/*", async (route) => {
        const url = route.request().url();
        if (url.startsWith("data:") || url.startsWith("blob:")) return route.continue();
        try {
          policy.assertAllowed(url);
          await route.continue();
        } catch {
          proxy.blocked.push({ target: url, reason: "route policy" });
          await route.abort("blockedbyclient");
        }
      });
      const page = await context.newPage();
      page.setDefaultTimeout(20_000);
      const nav = await page.goto(formUrl, { waitUntil: "domcontentloaded" });
      const status = nav?.status() ?? 0;
      if (status >= 500 || status === 429) return { outcome: "failed", retryable: true, error: `Form page returned HTTP ${status}`, evidence };
      if (status >= 400) return { outcome: "rejected", reason: `Form page returned HTTP ${status}`, evidence };
      await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
      const html = await page.content();
      const info = extractPage(html, page.url());
      evidence.push({
        kind: "screenshot",
        binary: await page.screenshot({ fullPage: true }),
        extension: "png",
        meta: { stage: "form_loaded", url: page.url() }
      });
      const captchaFrame = page.frames().some((f) => /recaptcha|hcaptcha|turnstile|arkoselabs/i.test(f.url()));
      const form = chooseForm(info.forms, ctx.source);
      if (info.captcha || captchaFrame || form?.hasCaptcha) {
        return {
          outcome: "human_required",
          reason: "captcha_required",
          instructions: `The form at ${formUrl} is protected by a CAPTCHA. It will not be bypassed — open the page, paste the prepared values and submit it yourself, then mark this task done (with the listing URL if shown).`,
          payload: { form_url: formUrl, prepared_values: form ? planFill(form, ctx.values, ctx.source).values : {} },
          evidence
        };
      }
      if (!form) return { outcome: "human_required", reason: "manual_review", instructions: `No submission form found at ${formUrl}.`, evidence };
      if (form.hasPassword)
        return {
          outcome: "human_required",
          reason: "login_required",
          instructions: `The form at ${formUrl} requires a login. Sign in yourself; accounts are never created automatically.`,
          evidence
        };
      const plan = planFill(form, ctx.values, ctx.source);
      if (plan.unmappedRequired.length) {
        return {
          outcome: "human_required",
          reason: "manual_review",
          instructions: `Required fields need information we will not invent: ${plan.unmappedRequired.map((u) => `${u.label} (${u.reason})`).join("; ")}`,
          payload: { form_url: formUrl, prepared_values: plan.values, unmapped: plan.unmappedRequired },
          evidence
        };
      }
      const formLoc = page.locator("form").nth(form.index);
      for (const [name, value] of Object.entries(plan.values)) {
        const el = formLoc.locator(`[name="${cssAttr(name)}"]`).first();
        const tag = await el.evaluate((n) => n.tagName.toLowerCase());
        if (tag === "select") await el.selectOption(value);
        else await el.fill(value);
      }
      for (const name of plan.checkboxes)
        await formLoc
          .locator(`[name="${cssAttr(name)}"]`)
          .first()
          .check();
      evidence.push({ kind: "screenshot", binary: await page.screenshot({ fullPage: true }), extension: "png", meta: { stage: "filled" } });
      const submitBtn = formLoc.locator("button[type=submit], input[type=submit], button:not([type])").first();
      const submittedAt = new Date().toISOString();
      clicked = true;
      await Promise.all([page.waitForLoadState("domcontentloaded").catch(() => {}), submitBtn.click()]);
      await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
      const afterHtml = await page.content();
      const after = extractPage(afterHtml, page.url());
      evidence.push({
        kind: "screenshot",
        binary: await page.screenshot({ fullPage: true }),
        extension: "png",
        meta: { stage: "after_submit", url: page.url(), submitted_at: submittedAt }
      });
      evidence.push({ kind: "html_snapshot", content: afterHtml.slice(0, 200_000), extension: "html", meta: { url: page.url() } });
      evidence.push({ kind: "note", content: JSON.stringify({ egress_blocked: proxy.blocked, egress_allowed_count: proxy.allowed.length }) });
      const text = outcomeText(afterHtml);
      if (EMAIL_VERIFY_RE.test(text)) {
        return {
          outcome: "human_required",
          reason: "email_verification",
          instructions: `Verify the email sent to ${ctx.values.email}, then mark this task done.`,
          evidence
        };
      }
      const customOk = ctx.source?.form_mapping?.confirmation_pattern ? new RegExp(ctx.source.form_mapping.confirmation_pattern, "i") : null;
      if (customOk?.test(text) || (CONFIRMATION_RE.test(text) && !FORM_ERROR_RE.test(text))) {
        const sentence = confirmationSnippet(afterHtml);
        evidence.push({ kind: "confirmation_text", content: sentence });
        const listingHref = after.links.find((l) => /\/listing\//.test(l.href))?.href ?? null;
        return {
          outcome: "submitted",
          confirmationText: sentence,
          response: { url: page.url(), submitted_at: submittedAt },
          liveUrl: listingHref,
          evidence
        };
      }
      if (FORM_ERROR_RE.test(text)) {
        return {
          outcome: "rejected",
          reason: (text.match(/[^.!?]*(error|invalid|required|already|duplicate)[^.!?]*[.!?]?/i)?.[0] ?? "Form error").trim(),
          evidence
        };
      }
      return {
        outcome: "human_required",
        reason: "manual_review",
        instructions: "Submission outcome unclear — check the destination before retrying.",
        evidence
      };
    } catch (err) {
      evidence.push({ kind: "note", content: `Browser error: ${(err as Error).message}` });
      if (clicked) {
        return {
          outcome: "human_required",
          reason: "manual_review",
          instructions: `Browser error after submitting (${(err as Error).message}). Check the destination for an existing listing before retrying.`,
          evidence
        };
      }
      return { outcome: "failed", retryable: true, error: (err as Error).message, evidence };
    } finally {
      await browser?.close().catch(() => {});
      await proxy.close().catch(() => {});
    }
  }
};
