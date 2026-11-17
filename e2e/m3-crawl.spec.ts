import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { linkFromEmail, strongPassword, uniqueEmail } from "./mail";

/** M3 end-to-end: cron endpoint security, and a real crawl processed in the background. */

const cronSecret = readFileSync("apps/web/.env.local", "utf8").match(/^CRON_SECRET=(.*)$/m)?.[1] ?? "";

test("the cron endpoint rejects missing or wrong secrets and runs with the right one", async ({ request }) => {
  expect((await request.get("/api/cron/tick")).status()).toBe(401);
  expect((await request.get("/api/cron/tick", { headers: { authorization: "Bearer wrong-secret-value" } })).status()).toBe(401);
  const ok = await request.get("/api/cron/tick", { headers: { authorization: `Bearer ${cronSecret}` } });
  expect(ok.status()).toBe(200);
  expect(await ok.json()).toMatchObject({ ok: true });
});

test("start a crawl and watch it complete (needs internet access)", async ({ browser }) => {
  test.skip(!!process.env.E2E_SKIP_NETWORK, "network-dependent");
  test.setTimeout(150_000);
  const who = { name: "Cara Crawler", email: uniqueEmail("crawl"), password: strongPassword() };
  const ctx = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": `198.18.9.${Math.floor(Math.random() * 200) + 1}` } });
  const page = await ctx.newPage();
  await page.goto("/sign-up");
  await page.getByLabel("Your name").fill(who.name);
  await page.getByLabel("Work email").fill(who.email);
  await page.getByLabel("Password", { exact: true }).fill(who.password);
  await page.getByLabel("Confirm password").fill(who.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.goto(await linkFromEmail(who.email, /Verify your email/));

  await page.getByRole("link", { name: "Add your first website" }).click();
  await page.getByLabel("Website address").fill("example.com");
  await page.getByRole("button", { name: "Add website" }).click();
  await expect(page.getByRole("heading", { name: "example.com" })).toBeVisible();

  await page.getByRole("button", { name: "Start crawl" }).click();
  await expect(page).toHaveURL(/\/crawls\/[0-9a-f-]{36}$/);
  await expect(page.getByText("limited to 25 pages")).toBeVisible(); // unverified
  // Background processing + live refresh, no manual reload.
  await expect(page.getByText("Completed", { exact: true })).toBeVisible({ timeout: 120_000 });
  await expect(page.getByRole("cell", { name: /Example Domain/ })).toBeVisible();
  await expect(page.getByText(/robots\.txt: (found and respected|none)/)).toBeVisible();

  // History is visible on the Jobs page.
  const base = new URL(page.url()).pathname.split("/websites")[0];
  await page.goto(`${base}/settings/jobs`);
  await expect(page.getByRole("row", { name: /Website crawl.*succeeded/i })).toBeVisible();
});
