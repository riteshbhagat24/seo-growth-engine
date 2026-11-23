/**
 * Submission Adapter interface. Every supported platform is an adapter with a declared manifest.
 * The platform never claims a destination is supported unless its adapter is implemented AND tested.
 */
import type { Db } from "@sge/db";
import type { AssetType, BusinessProfile } from "../assets/generator";
import type { Runtime } from "../runtime";

export type AdapterType = "official_api" | "authorised_partner" | "public_form" | "browser_automation" | "manual_editorial" | "outreach";

export type AutomationPermission = "none" | "manual_only" | "tos_permits_form" | "explicit_permission" | "own_property" | "test_destination";

/** Sources whose permission allows unattended (AUTOPILOT) execution. */
export const AUTOPILOT_PERMISSIONS: AutomationPermission[] = ["explicit_permission", "own_property", "test_destination"];

export interface AdapterManifest {
  key: string;
  name: string;
  type: AdapterType;
  version: string;
  description: string;
  operations: ("submit" | "check_status" | "update" | "draft" | "send")[];
  authentication: { kind: "none" | "bearer_token" | "app_password" | "smtp" | "user_account"; description: string };
  submissionFields: { key: string; required: boolean; source: string; maxLength?: number }[];
  requiredUserInformation: string[];
  permissionRequirements: { accepted: AutomationPermission[]; notes: string };
  rateLimits: { perDomainPerDay: number; perDomainPerWeek: number; minIntervalSeconds: number };
  verificationMethod: "crawl_live_url" | "api_status_then_crawl" | "user_reported_url_then_crawl";
  errorHandling: string;
  retryPolicy: { maxAttempts: number; retryOn: string[]; idempotent: boolean };
  statuses: string;
  supportsAutopilot: boolean;
  queue: "light" | "crawl" | "browser";
  implementationStatus: "implemented" | "experimental" | "not_supported";
  testStatus: "live_tested" | "contract_tested" | "untested";
  testEvidence: string;
}

export interface SubmissionValues {
  business_name: string;
  website_url: string;
  target_url: string;
  anchor_text: string;
  email: string | null;
  phone: string | null;
  contact_name: string | null;
  short_description: string;
  long_description: string;
  category: string;
  country: string | null;
  city: string | null;
  address: string | null;
  keywords: string;
  logo_url: string | null;
  title: string | null;
  body: string | null;
}

export interface SourceInfo {
  id: string;
  organization_id: string | null;
  domain: string;
  name: string;
  homepage_url: string;
  submission_url: string | null;
  automation_permission: AutomationPermission;
  permission_evidence: Record<string, any>;
  form_mapping: Record<string, any>;
  api_config: Record<string, any>;
  /** Encrypted credentials are stored (never exposed to the UI or adapters as ciphertext). */
  has_credentials?: boolean;
}

export interface Evidence {
  kind: "screenshot" | "html_snapshot" | "http_exchange" | "confirmation_text" | "email" | "note";
  /** In-memory content (text) or binary to be stored as a file by the executor. */
  content?: string;
  binary?: Buffer;
  extension?: string;
  meta?: Record<string, unknown>;
}

export interface AdapterContext {
  submission: {
    id: string;
    organization_id: string;
    website_id: string;
    submission_url: string | null;
    target_url: string;
    anchor_text: string | null;
    destination_domain: string;
    attempt_count: number;
  };
  source: SourceInfo | null;
  opportunity: { url: string; opportunity_type: string };
  profile: BusinessProfile;
  assets: Partial<Record<AssetType, { id: string; title: string | null; body: string; status: string }>>;
  values: SubmissionValues;
  idempotencyKey: string;
  /** Decrypted destination credentials (workspace sources only), e.g. { token } or { app_password }. */
  credentials: Record<string, string> | null;
  rt: Runtime;
  db: Db;
  log(level: "debug" | "info" | "warn" | "error", message: string, data?: unknown): Promise<void>;
  signal: AbortSignal;
}

export type HumanReason = "captcha_required" | "email_verification" | "login_required" | "manual_review" | "manual_submission" | "outreach_send";

export type AdapterResult =
  | {
      outcome: "submitted";
      confirmationText: string;
      response: Record<string, unknown>;
      liveUrl?: string | null;
      externalId?: string | null;
      evidence: Evidence[];
    }
  | { outcome: "human_required"; reason: HumanReason; instructions: string; payload?: Record<string, unknown>; evidence: Evidence[] }
  | { outcome: "rejected"; reason: string; evidence: Evidence[] }
  | { outcome: "failed"; retryable: boolean; error: string; retryAfterSeconds?: number; evidence: Evidence[] };

export interface Adapter {
  manifest: AdapterManifest;
  /** Returns blocking problems (missing config/permissions). Empty array = ready. */
  validate(ctx: Pick<AdapterContext, "source" | "values" | "assets">): string[];
  /** Runs only in a worker with Chromium. */
  needsBrowser?: boolean;
  submit(ctx: AdapterContext): Promise<AdapterResult>;
  checkStatus?(ctx: AdapterContext, externalId: string): Promise<{ status: string; liveUrl?: string | null }>;
}
