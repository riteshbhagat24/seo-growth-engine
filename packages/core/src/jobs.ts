import type { JobHandler } from "@sge/jobs";
import { AUDIT_SCHEDULED_JOB, createAuditAnalyzeHandler, createScheduledAuditHandler } from "./audits";
import { AUDIT_ANALYZE_JOB, CRAWL_JOB, createCrawlHandler, type CrawlHandlerOptions } from "./crawls";
import { createCwvHandler, CWV_JOB } from "./cwv";
import { defaultGoogleDeps, type GoogleDeps } from "./google";
import { createReverifyHandler, REVERIFY_JOB } from "./maintenance";
import { createGa4SyncHandler, createGscSyncHandler, GA4_SYNC_JOB, GSC_SYNC_JOB } from "./searchdata";
import type { VerificationDeps } from "./websites";

export interface JobHandlerOptions extends CrawlHandlerOptions {
  /** Platform PageSpeed Insights key (optional). */
  psiApiKey?: string | null;
  psiFetch?: typeof fetch;
  verificationDeps?: VerificationDeps;
  googleDeps?: GoogleDeps;
  /** Injected clock for sync tests. */
  now?: () => Date;
}

/** Every job type the worker can run. */
export function jobHandlers(o: JobHandlerOptions = {}): Record<string, JobHandler> {
  return {
    [CRAWL_JOB]: createCrawlHandler(o),
    [AUDIT_ANALYZE_JOB]: createAuditAnalyzeHandler({ fetch: o.fetch, fetchTimeoutMs: o.fetchTimeoutMs }),
    [AUDIT_SCHEDULED_JOB]: createScheduledAuditHandler(),
    [CWV_JOB]: createCwvHandler({ apiKey: o.psiApiKey, fetch: o.psiFetch }),
    [REVERIFY_JOB]: createReverifyHandler(o.verificationDeps, o.googleDeps ?? defaultGoogleDeps),
    [GSC_SYNC_JOB]: createGscSyncHandler(o.googleDeps ?? defaultGoogleDeps, o.now),
    [GA4_SYNC_JOB]: createGa4SyncHandler(o.googleDeps ?? defaultGoogleDeps, o.now)
  };
}

/** Labels for the Jobs page. */
export const JOB_LABEL: Record<string, string> = {
  [CRAWL_JOB]: "Website crawl",
  [AUDIT_ANALYZE_JOB]: "Audit analysis",
  [AUDIT_SCHEDULED_JOB]: "Scheduled audit",
  [CWV_JOB]: "Core Web Vitals",
  [REVERIFY_JOB]: "Ownership re-check",
  [GSC_SYNC_JOB]: "Search Console sync",
  [GA4_SYNC_JOB]: "Analytics sync"
};
