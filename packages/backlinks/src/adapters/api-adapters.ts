/**
 * API-based adapters:
 *  - listing-api-v1   (official_api)        Open "Listing API v1" contract (docs/ADAPTER_SPEC.md). Idempotent.
 *  - wordpress-draft  (authorised_partner)  Creates DRAFT posts on a partner's WordPress via the REST API and an
 *                                            application password the partner issued. Never publishes.
 */
import type { Fetcher, SafeResponse } from "../net/fetcher";
import { PolicyBlockedError } from "../net/policy";
import type { Adapter, AdapterContext, AdapterResult, Evidence } from "./types";

/** Destination credentials are stored encrypted per workspace source and decrypted by the executor only. */
function secret(ctx: Pick<AdapterContext, "credentials">, key: string): string | null {
  return ctx.credentials?.[key] ?? null;
}

function exchangeEvidence(method: string, url: string, body: unknown, res: SafeResponse | null, err?: string): Evidence {
  return {
    kind: "http_exchange",
    content: JSON.stringify(
      {
        request: { method, url, body },
        response: res ? { status: res.status, headers: redactHeaders(res.headers), body: res.text.slice(0, 4000) } : null,
        error: err ?? null
      },
      null,
      2
    ),
    meta: { status: res?.status ?? null }
  };
}

/** Evidence never stores cookies. */
export function redactHeaders(h: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(h)) out[k] = /^(set-cookie|cookie|authorization)$/i.test(k) ? "[redacted]" : v;
  return out;
}

function retryAfter(res: SafeResponse): number | undefined {
  const v = Number(res.headers["retry-after"]);
  return Number.isFinite(v) && v > 0 ? Math.min(v, 3600) : undefined;
}

async function postJson(fetcher: Fetcher, url: string, headers: Record<string, string>, body: unknown): Promise<SafeResponse> {
  return fetcher.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", ...headers },
    body: JSON.stringify(body),
    respectRobots: false, // API endpoints used with explicit permission/credentials are not crawling
    acceptTypes: ["application/json", "text/"],
    followRedirects: false
  });
}

export const listingApiAdapter: Adapter = {
  manifest: {
    key: "listing-api-v1",
    name: "Listing API v1 (official API)",
    type: "official_api",
    version: "1.0.0",
    description: "Creates a listing through a destination's official REST API implementing the open Listing API v1 contract.",
    operations: ["submit", "check_status"],
    authentication: { kind: "bearer_token", description: "API token issued by the destination, stored encrypted on the workspace source." },
    submissionFields: [
      { key: "business_name", required: true, source: "profile.business_name" },
      { key: "website_url", required: true, source: "campaign target page" },
      { key: "anchor_text", required: false, source: "profile.approved_anchor_texts" },
      { key: "short_description", required: true, source: "asset.short_description", maxLength: 160 },
      { key: "long_description", required: false, source: "asset.long_description" },
      { key: "category", required: false, source: "profile.industry" },
      { key: "country", required: false, source: "profile.target_countries[0]" },
      { key: "contact_email", required: false, source: "profile.contact_email" }
    ],
    requiredUserInformation: ["API endpoint", "API token from the destination", "Approved business profile"],
    permissionRequirements: {
      accepted: ["explicit_permission", "own_property", "test_destination"],
      notes: "Using an issued API token is explicit permission."
    },
    rateLimits: { perDomainPerDay: 5, perDomainPerWeek: 20, minIntervalSeconds: 5 },
    verificationMethod: "api_status_then_crawl",
    errorHandling:
      "400/422 -> REJECTED; 409 duplicate -> REJECTED; 401/403 -> FAILED + credentials task; 429/5xx/network -> retry with backoff (Retry-After honoured).",
    retryPolicy: { maxAttempts: 5, retryOn: ["network error", "timeout", "HTTP 429", "HTTP 5xx"], idempotent: true },
    statuses: "SUBMITTING -> SUBMITTED (pending moderation) -> verified by crawl of listing_url",
    supportsAutopilot: true,
    queue: "crawl",
    implementationStatus: "implemented",
    testStatus: "live_tested",
    testEvidence: "packages/backlinks/test/acceptance-engine.test.ts (TEST 4-7, 12) against the approved test destination"
  },
  validate({ source }) {
    const p: string[] = [];
    if (!source) return ["No source record"];
    if (!source.api_config?.endpoint) p.push("api_config.endpoint missing");
    if (!source.has_credentials) p.push("API token missing (add it to the source; it is stored encrypted)");
    if (!this.manifest.permissionRequirements.accepted.includes(source.automation_permission))
      p.push(`Permission ${source.automation_permission} not accepted`);
    return p;
  },
  async submit(ctx: AdapterContext): Promise<AdapterResult> {
    const cfg = ctx.source!.api_config;
    const body = {
      business_name: ctx.values.business_name,
      website_url: ctx.values.target_url,
      anchor_text: ctx.values.anchor_text,
      short_description: ctx.values.short_description,
      long_description: ctx.values.long_description,
      category: ctx.values.category,
      country: ctx.values.country,
      contact_email: ctx.values.email
    };
    const evidence: Evidence[] = [];
    let res: SafeResponse;
    try {
      res = await postJson(
        ctx.rt.fetcher,
        cfg.endpoint,
        { authorization: `Bearer ${secret(ctx, "token")}`, "idempotency-key": ctx.idempotencyKey },
        body
      );
    } catch (err) {
      evidence.push(exchangeEvidence("POST", cfg.endpoint, body, null, (err as Error).message));
      if (err instanceof PolicyBlockedError && !["timeout", "dns_failure"].includes(err.code))
        return { outcome: "rejected", reason: err.message, evidence };
      return { outcome: "failed", retryable: true, error: (err as Error).message, evidence };
    }
    evidence.push(exchangeEvidence("POST", cfg.endpoint, body, res));
    let json: any = {};
    try {
      json = JSON.parse(res.text);
    } catch {
      /* non-JSON */
    }
    if (res.status === 201 || res.status === 200) {
      const confirmation = `Listing ${json.id ?? ""} accepted with status "${json.status ?? "unknown"}"`;
      evidence.push({ kind: "confirmation_text", content: confirmation });
      return {
        outcome: "submitted",
        confirmationText: confirmation,
        response: json,
        liveUrl: json.listing_url ?? null,
        externalId: json.id ? String(json.id) : null,
        evidence
      };
    }
    if (res.status === 429 || res.status >= 500)
      return {
        outcome: "failed",
        retryable: true,
        error: `HTTP ${res.status}: ${json.error ?? res.text.slice(0, 200)}`,
        retryAfterSeconds: retryAfter(res),
        evidence
      };
    if (res.status === 401 || res.status === 403)
      return { outcome: "failed", retryable: false, error: `Authentication failed (HTTP ${res.status}) — check the API token`, evidence };
    return { outcome: "rejected", reason: `HTTP ${res.status}: ${json.error ?? res.text.slice(0, 300)}`, evidence };
  },
  async checkStatus(ctx, externalId) {
    const cfg = ctx.source!.api_config;
    const res = await ctx.rt.fetcher.fetch(`${cfg.endpoint.replace(/\/$/, "")}/${encodeURIComponent(externalId)}`, {
      headers: { authorization: `Bearer ${secret(ctx, "token")}`, accept: "application/json" },
      respectRobots: false,
      acceptTypes: ["application/json"]
    });
    const json = JSON.parse(res.text || "{}");
    return { status: json.status ?? "unknown", liveUrl: json.listing_url ?? null };
  }
};

export const wordpressDraftAdapter: Adapter = {
  manifest: {
    key: "wordpress-draft",
    name: "WordPress partner draft (REST API)",
    type: "authorised_partner",
    version: "1.0.0",
    description:
      "Creates a DRAFT post on a partner/publisher WordPress site with an application password the publisher issued. The publisher reviews and publishes; nothing is auto-published.",
    operations: ["draft", "check_status"],
    authentication: {
      kind: "app_password",
      description: "WordPress application password issued by the publisher (api_config.username; password stored encrypted)."
    },
    submissionFields: [
      { key: "title", required: true, source: "asset.article_draft.title (human-approved)" },
      { key: "body", required: true, source: "asset.article_draft.body (human-approved)" }
    ],
    requiredUserInformation: ["Publisher-issued application password", "Human-approved article"],
    permissionRequirements: {
      accepted: ["explicit_permission", "own_property", "test_destination"],
      notes: "Publisher must have issued credentials; article must be approved by a person."
    },
    rateLimits: { perDomainPerDay: 1, perDomainPerWeek: 1, minIntervalSeconds: 60 },
    verificationMethod: "user_reported_url_then_crawl",
    errorHandling: "401/403 -> FAILED (credentials); 4xx -> REJECTED; 5xx/network -> retry.",
    retryPolicy: { maxAttempts: 3, retryOn: ["network error", "HTTP 5xx"], idempotent: false },
    statuses: "SUBMITTING -> SUBMITTED (draft awaiting publisher) -> PENDING_VERIFICATION -> VERIFIED after publication",
    supportsAutopilot: false,
    queue: "crawl",
    implementationStatus: "implemented",
    testStatus: "contract_tested",
    testEvidence:
      "packages/backlinks/test/acceptance-engine.test.ts against the test destination's WordPress-compatible /wp-json/wp/v2/posts endpoint (not a real WordPress install)"
  },
  validate({ source, assets }) {
    const p: string[] = [];
    if (!source?.api_config?.base_url) p.push("api_config.base_url missing");
    if (!source?.api_config?.username) p.push("api_config.username missing");
    if (source && !source.has_credentials) p.push("Application password missing");
    if (!assets.article_draft) p.push("No article draft");
    else if (assets.article_draft.status !== "approved") p.push("Article draft must be approved by a person before it is sent to the publisher");
    return p;
  },
  async submit(ctx) {
    const cfg = ctx.source!.api_config;
    const url = `${String(cfg.base_url).replace(/\/$/, "")}/wp-json/wp/v2/posts`;
    const art = ctx.assets.article_draft!;
    const body = { title: art.title, content: art.body, status: "draft" };
    const auth = Buffer.from(`${cfg.username}:${secret(ctx, "app_password")}`).toString("base64");
    const evidence: Evidence[] = [];
    let res: SafeResponse;
    try {
      res = await postJson(ctx.rt.fetcher, url, { authorization: `Basic ${auth}` }, body);
    } catch (err) {
      evidence.push(exchangeEvidence("POST", url, { title: art.title, status: "draft" }, null, (err as Error).message));
      return { outcome: "failed", retryable: true, error: (err as Error).message, evidence };
    }
    evidence.push(exchangeEvidence("POST", url, { title: art.title, status: "draft" }, res));
    const json: any = (() => {
      try {
        return JSON.parse(res.text);
      } catch {
        return {};
      }
    })();
    if (res.status === 201) {
      const confirmation = `Draft post #${json.id} created for the publisher's editorial review (status "${json.status}")`;
      evidence.push({ kind: "confirmation_text", content: confirmation });
      return { outcome: "submitted", confirmationText: confirmation, response: json, liveUrl: null, externalId: String(json.id), evidence };
    }
    if (res.status >= 500 || res.status === 429) return { outcome: "failed", retryable: true, error: `HTTP ${res.status}`, evidence };
    if (res.status === 401 || res.status === 403) return { outcome: "failed", retryable: false, error: "Publisher credentials rejected", evidence };
    return { outcome: "rejected", reason: `HTTP ${res.status}: ${json.message ?? ""}`, evidence };
  }
};
