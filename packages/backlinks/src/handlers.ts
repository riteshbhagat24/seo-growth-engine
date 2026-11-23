import type { JobHandler } from "@sge/jobs";
import { BACKLINK_JOBS, engineHandler } from "./jobs";
import { createRuntime, type BacklinkRuntimeOptions, type Runtime } from "./runtime";
import { discoverCampaignJob } from "./pipeline/campaigns";
import { planCampaignJob } from "./pipeline/planner";
import { executeSubmissionJob } from "./pipeline/executor";
import { websiteTickJob } from "./pipeline/schedule";
import { qualifyProspectJob } from "./qualification/qualify";
import { verifySubmissionJob } from "./verification/verify";

export interface BacklinkHandlerOptions extends BacklinkRuntimeOptions {
  workerId?: string;
  /** Reuse a runtime (tests inspect its fetcher). */
  runtime?: Runtime;
}

/**
 * Every backlink job type this process can run. Browser submissions are registered only when `browser` is on
 * (the long-running worker with Chromium); a web tick then claims only the types listed here.
 */
export function backlinkJobHandlers(o: BacklinkHandlerOptions = {}): Record<string, JobHandler> {
  const rt = o.runtime ?? createRuntime(o);
  const h = (fn: Parameters<typeof engineHandler>[0]) => engineHandler(fn, rt, o.workerId);
  const handlers: Record<string, JobHandler> = {
    [BACKLINK_JOBS.discover]: h(discoverCampaignJob),
    [BACKLINK_JOBS.qualify]: h(qualifyProspectJob),
    [BACKLINK_JOBS.plan]: h(planCampaignJob),
    [BACKLINK_JOBS.execute]: h(executeSubmissionJob),
    [BACKLINK_JOBS.verify]: h(verifySubmissionJob),
    [BACKLINK_JOBS.tick]: h(websiteTickJob)
  };
  if (rt.browser) handlers[BACKLINK_JOBS.executeBrowser] = h(executeSubmissionJob);
  return handlers;
}
