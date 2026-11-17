import { and, eq, schema, sql, withContext, type Tx } from "@sge/db";
import type { JobHandler } from "@sge/jobs";
import { audit } from "./audit";
import { assertId } from "./context";
import { defaultGoogleDeps, type GoogleDeps } from "./google";
import { gscStillOwned } from "./searchdata";
import { checkOwnership, defaultVerificationDeps, REVERIFY_JOB, type VerificationDeps } from "./websites";

const { websites, schedules } = schema;

export { REVERIFY_JOB, REVERIFY_INTERVAL_MINUTES, scheduleReverification } from "./websites";

/**
 * Re-checks a verified website with its original method. One failed check is
 * recorded as a warning; two in a row remove the verified status (so a site
 * that changes hands can't keep verified-only privileges).
 */
export function createReverifyHandler(deps: VerificationDeps = defaultVerificationDeps, googleDeps: GoogleDeps = defaultGoogleDeps): JobHandler {
  return async ({ job, appDb }) => {
    const org = job.organizationId!;
    const websiteId = String(job.websiteId ?? job.payload.websiteId ?? "");
    assertId(websiteId, "Website");
    const t = <T>(fn: (tx: Tx) => Promise<T>) => withContext(appDb, { organizationId: org }, fn);
    const [w] = await t((tx) => tx.select().from(websites).where(eq(websites.id, websiteId)));
    if (!w || w.verificationStatus !== "verified" || !w.verificationMethod) {
      if (w) await t((tx) => tx.update(schedules).set({ enabled: false }).where(and(eq(schedules.websiteId, websiteId), eq(schedules.jobType, REVERIFY_JOB))));
      return { done: true };
    }
    const reason =
      w.verificationMethod === "gsc" ? await gscStillOwned(appDb, org, w.id, googleDeps) : await checkOwnership(w.verificationMethod, w, deps);
    await t(async (tx) => {
      if (reason === null) {
        await tx.update(websites).set({ lastVerificationError: null, lastVerificationAt: new Date() }).where(eq(websites.id, w.id));
        return;
      }
      const secondFailure = Boolean(w.lastVerificationError?.startsWith("Re-check failed"));
      await tx
        .update(websites)
        .set({
          lastVerificationError: `Re-check failed: ${reason}`.slice(0, 500),
          lastVerificationAt: new Date(),
          ...(secondFailure ? { verificationStatus: "unverified" as const, verifiedAt: null } : {})
        })
        .where(eq(websites.id, w.id));
      if (secondFailure) {
        await tx.update(schedules).set({ enabled: false, updatedAt: sql`now()` }).where(and(eq(schedules.websiteId, w.id), eq(schedules.jobType, REVERIFY_JOB)));
        await audit(tx, {
          organizationId: org,
          actorUserId: null,
          action: "website.verification_lost",
          entityType: "website",
          entityId: w.id,
          metadata: { domain: w.domain, reason }
        });
      }
    });
    return { done: true };
  };
}
