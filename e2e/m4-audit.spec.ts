import { expect, test, type Page } from "@playwright/test";
import { linkFromEmail, strongPassword, uniqueEmail } from "./mail";

/**
 * M4 end-to-end: a real audit of example.com (crawl → link checks → rules →
 * score, processed in the background), issue drill-down, CSV export, audit
 * schedule, on-page analysis and the integrations page.
 * Needs internet access; set E2E_SKIP_NETWORK=1 to skip the network parts.
 */
test.describe.configure({ mode: "serial" });

let page: Page;
let websiteUrl = "";
let workspaceBase = "";

test("sign up and add a website", async ({ browser }) => {
  const who = { name: "Audrey Auditor", email: uniqueEmail("audit"), password: strongPassword() };
  const ctx = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": `198.18.10.${Math.floor(Math.random() * 200) + 1}` } });
  page = await ctx.newPage();
  await page.goto("/sign-up");
  await page.getByLabel("Your name").fill(who.name);
  await page.getByLabel("Work email").fill(who.email);
  await page.getByLabel("Password", { exact: true }).fill(who.password);
  await page.getByLabel("Confirm password").fill(who.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.goto(await linkFromEmail(who.email, /Verify your email/));
  workspaceBase = new URL(page.url()).pathname;
  await expect(page.getByText("Run a technical SEO audit")).toBeVisible();

  await page.getByRole("link", { name: "Add your first website" }).click();
  await page.getByLabel("Website address").fill("example.com");
  await page.getByRole("button", { name: "Add website" }).click();
  await expect(page.getByRole("heading", { name: "example.com" })).toBeVisible();
  websiteUrl = page.url();
  await expect(page.getByRole("heading", { name: "Technical SEO audit" })).toBeVisible();
});

test("run an audit and watch it complete in the background", async () => {
  test.skip(!!process.env.E2E_SKIP_NETWORK, "network-dependent");
  test.setTimeout(180_000);
  await page.goto(websiteUrl);
  await page.getByRole("button", { name: "Run first audit" }).click();
  await expect(page).toHaveURL(/\/audits\/[0-9a-f-]{36}$/);
  await expect(page.getByText("audits cover up to 25 pages")).toBeVisible(); // unverified
  // No manual reload: the page polls and refreshes itself.
  await expect(page.getByText("Completed", { exact: true })).toBeVisible({ timeout: 150_000 });
  await expect(page.getByRole("img", { name: /Health score: \d+ out of 100/ })).toBeVisible();
  await expect(page.getByText("Pages analysed")).toBeVisible();

  // Issues table → drill-down with explanation and fix.
  const firstIssue = page.locator("table a").first();
  await expect(firstIssue).toBeVisible();
  await firstIssue.click();
  await expect(page.getByRole("heading", { name: "Why it matters" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "How to fix it" })).toBeVisible();
  await page.getByRole("link", { name: "← Audit" }).click();

  // CSV export (same session cookie).
  const csvHref = await page.getByRole("link", { name: "Download issues (CSV)" }).getAttribute("href");
  const csv = await page.request.get(csvHref!);
  expect(csv.status()).toBe(200);
  expect(csv.headers()["content-type"]).toContain("text/csv");
  expect(await csv.text()).toContain("Severity,Category,Issue,URL,Details");

  // The crawl behind the audit.
  await page.getByRole("link", { name: "View crawled pages" }).click();
  await expect(page.getByRole("cell", { name: /Example Domain/ })).toBeVisible();

  // Score shows on the website page and the overview.
  await page.goto(websiteUrl);
  await expect(page.getByText("Health", { exact: true })).toBeVisible();
  await page.goto(workspaceBase);
  await expect(page.getByRole("heading", { name: "Site health" })).toBeVisible();

  // Jobs history.
  await page.goto(`${workspaceBase}/settings/jobs`);
  await expect(page.getByRole("row", { name: /Website crawl.*succeeded/i })).toBeVisible();
  await expect(page.getByRole("row", { name: /Audit analysis.*succeeded/i })).toBeVisible();
});

test("schedule automatic audits", async () => {
  await page.goto(websiteUrl);
  await page.getByLabel("Automatic audits").selectOption("weekly");
  await page.getByRole("button", { name: "Save schedule" }).click();
  await expect(page.getByText("Audits will run weekly.")).toBeVisible();
  await expect(page.getByText(/^Next: /)).toBeVisible();
});

test("analyse a page against a keyword", async () => {
  test.skip(!!process.env.E2E_SKIP_NETWORK, "network-dependent");
  await page.goto(websiteUrl);
  await page.getByRole("link", { name: "Analyse a page" }).click();
  await page.getByLabel("Target keyword").fill("example domain");
  await page.getByRole("button", { name: "Analyse page" }).click();
  await expect(page).toHaveURL(/\/onpage\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("img", { name: /On-page score: \d+ out of 100/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Search result preview" })).toBeVisible();
  await expect(page.getByText("Keyword in title")).toBeVisible();

  // Off-site URLs are refused.
  await page.goto(websiteUrl + "/onpage");
  await page.getByLabel("Page").fill("https://another-site.example/");
  await page.getByLabel("Target keyword").fill("anything");
  await page.getByRole("button", { name: "Analyse page" }).click();
  await expect(page.getByText("Enter a page on example.com")).toBeVisible();
});

test("store a PageSpeed API key encrypted, then remove it", async () => {
  await page.goto(`${workspaceBase}/settings/integrations`);
  await expect(page.getByText("Not connected")).toBeVisible();
  await page.getByLabel("API key").fill("AIzaSyE2E_test_key_abcdefghij1234");
  await page.getByRole("button", { name: "Save key" }).click();
  await expect(page.getByText(/Key saved/)).toBeVisible();
  await expect(page.getByText("Connected …1234")).toBeVisible();
  // The key itself is never sent back to the browser.
  expect(await page.content()).not.toContain("AIzaSyE2E_test_key");
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Remove key" }).click();
  await expect(page.getByText("Key removed.")).toBeVisible();
  await expect(page.getByText("Not connected")).toBeVisible();
});
