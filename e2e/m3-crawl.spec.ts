import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

/** M3 end-to-end: cron endpoint security. (Crawling itself is exercised through audits in m4-audit.spec.ts.) */

const cronSecret = readFileSync("apps/web/.env.local", "utf8").match(/^CRON_SECRET=(.*)$/m)?.[1] ?? "";

test("the cron endpoint rejects missing or wrong secrets and runs with the right one", async ({ request }) => {
  expect((await request.get("/api/cron/tick")).status()).toBe(401);
  expect((await request.get("/api/cron/tick", { headers: { authorization: "Bearer wrong-secret-value" } })).status()).toBe(401);
  const ok = await request.get("/api/cron/tick", { headers: { authorization: `Bearer ${cronSecret}` } });
  expect(ok.status()).toBe(200);
  expect(await ok.json()).toMatchObject({ ok: true });
});
