import { expect, test, type Page } from "@playwright/test";
import { seedGoogleData } from "./db";
import { linkFromEmail, strongPassword, uniqueEmail } from "./mail";

/**
 * M5 end-to-end: Google OAuth start/callback safety, dashboards over seeded
 * Search Console + GA4 data, keywords (add, track from queries, CSV import,
 * remove) and the responsive navigation.
 */
test.describe.configure({ mode: "serial" });

let page: Page;
let site = "";
let ws = "";
const stamp = Date.now().toString(36);

test("sign up and add a website", async ({ browser }) => {
  const who = { name: "Gina Google", email: uniqueEmail("google"), password: strongPassword() };
  const ctx = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": `198.18.11.${Math.floor(Math.random() * 200) + 1}` } });
  page = await ctx.newPage();
  await page.goto("/sign-up");
  await page.getByLabel("Your name").fill(who.name);
  await page.getByLabel("Work email").fill(who.email);
  await page.getByLabel("Password", { exact: true }).fill(who.password);
  await page.getByLabel("Confirm password").fill(who.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.goto(await linkFromEmail(who.email, /Verify your email/));
  ws = new URL(page.url()).pathname;
  await page.getByRole("link", { name: "Add your first website" }).click();
  await page.getByLabel("Website address").fill(`seeded-${stamp}.com`);
  await page.getByRole("button", { name: "Add website" }).click();
  await expect(page).toHaveURL(/\/websites\/[0-9a-f-]{36}$/);
  site = new URL(page.url()).pathname;
});

test("empty states point to linking Google", async () => {
  await page.goto(`${site}/search`);
  await expect(page.getByRole("heading", { name: "Connect Google Search Console" })).toBeVisible();
  await page.goto(`${site}/traffic`);
  await expect(page.getByRole("heading", { name: "Connect Google Analytics 4" })).toBeVisible();
  await page.goto(`${site}/settings`);
  await expect(page.getByRole("link", { name: "Connect Google" })).toBeVisible();
});

test("Connect Google sends the user to Google with PKCE and a signed state cookie", async () => {
  const slug = ws.split("/")[2]!;
  const res = await page.request.get(`/api/integrations/google/start?w=${slug}`, { maxRedirects: 0 });
  expect(res.status()).toBe(303);
  const loc = new URL(res.headers().location!);
  expect(loc.origin).toBe("https://accounts.google.com");
  expect(loc.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/webmasters.readonly");
  expect(loc.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/analytics.readonly");
  expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
  expect(loc.searchParams.get("access_type")).toBe("offline");
  expect(loc.searchParams.get("redirect_uri")).toMatch(/\/api\/integrations\/google\/callback$/);
  const cookie = res.headers()["set-cookie"] ?? "";
  expect(cookie).toMatch(/sge-google-oauth=/);
  expect(cookie).toMatch(/HttpOnly/i);

  // A forged or replayed callback is refused.
  await page.goto(`/api/integrations/google/callback?state=forged&code=x`);
  await expect(page).toHaveURL(/google=state_mismatch/);
  await expect(page.getByText("The connection attempt couldn't be verified")).toBeVisible();
  await page.goto(`/api/integrations/google/callback?state=forged&code=x`);
  await expect(page).toHaveURL(/google=expired/); // cookie was single-use
  await expect(page.getByText("The connection attempt expired")).toBeVisible();
});

test("search performance and traffic dashboards render seeded data", async () => {
  await seedGoogleData(site.split("/").pop()!);
  await page.goto(`${site}/search`);
  await expect(page.getByText("Clicks", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("img", { name: /^Clicks: 28 points/ })).toBeVisible();
  await expect(page.getByRole("img", { name: /^Average position: 28 points/ })).toBeVisible();
  await expect(page.getByRole("cell", { name: "seed keyword" })).toBeVisible();

  // Range switch
  await page.getByRole("link", { name: "7 days" }).click();
  await expect(page.getByRole("img", { name: /^Clicks: 7 points/ })).toBeVisible();

  // Keyboard access to chart values
  const chart = page.getByRole("img", { name: /^Clicks: 7 points/ });
  await chart.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("status").filter({ hasText: /Clicks ·/ })).toBeVisible();

  // Track a query straight from the table
  await page.getByRole("row", { name: /other query/ }).getByRole("button", { name: "Track" }).click();
  await expect(page.getByText("✓ Tracking")).toBeVisible();

  await page.goto(`${site}/traffic`);
  await expect(page.getByRole("img", { name: /^Sessions: 28 points/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Referral traffic" })).toBeVisible();
  await expect(page.getByText("partner.example").first()).toBeVisible();
});

test("keywords: add, see Search Console metrics, import CSV, remove", async () => {
  await page.goto(`${site}/keywords`);
  await expect(page.getByRole("link", { name: "other query" })).toBeVisible(); // tracked from the queries table
  await page.getByLabel("Keywords", { exact: true }).fill("seed keyword\nbrand new phrase");
  await page.getByLabel("Group").fill("Core");
  await page.getByRole("button", { name: "Add keywords" }).click();
  await expect(page.getByText("Added 2 keywords.")).toBeVisible();
  const row = page.getByRole("row", { name: /seed keyword/ });
  await expect(row).toContainText("3.2"); // position from Search Console
  await expect(row).toContainText("Core");

  // CSV with volume needs a source label
  const csv = { name: "kw.csv", mimeType: "text/csv", buffer: Buffer.from("Keyword,Volume,KD\nimported one,1200,30\n") };
  await page.getByLabel("CSV file").setInputFiles(csv);
  await page.getByRole("button", { name: "Import" }).click();
  await expect(page.getByText(/Say where the volume/)).toBeVisible();
  await page.getByLabel("CSV file").setInputFiles(csv);
  await page.getByLabel("Source of volume / difficulty").fill("E2E export");
  await page.getByRole("button", { name: "Import" }).click();
  await expect(page.getByText(/Imported 1 new keyword/)).toBeVisible();
  await expect(page.getByRole("row", { name: /imported one/ })).toContainText("1,200");

  // Keyword detail page
  await page.getByRole("link", { name: "seed keyword" }).click();
  await expect(page.getByRole("heading", { name: "“seed keyword”" })).toBeVisible();
  await expect(page.getByRole("img", { name: /^Average position: \d+ points/ })).toBeVisible();
  await page.getByRole("link", { name: "← All keywords" }).click();

  // Bulk remove
  await page.getByLabel("Select brand new phrase").check();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Remove selected" }).click();
  await expect(page.getByText("Removed 1 keyword.")).toBeVisible();
  await expect(page.getByRole("link", { name: "brand new phrase" })).toHaveCount(0);

  // Overview reflects it all
  await page.goto(site);
  await expect(page.getByRole("heading", { name: "Clicks from Google" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Top keywords" })).toBeVisible();
  await expect(page.getByRole("link", { name: "seed keyword" })).toBeVisible();
});

test("mobile: the sidebar becomes a menu", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: await page.context().storageState() });
  const m = await ctx.newPage();
  await m.goto(ws);
  await expect(m.getByRole("navigation", { name: "Main" })).toBeHidden();
  await m.getByRole("button", { name: "Open navigation" }).click();
  await expect(m.getByRole("dialog", { name: "Navigation" })).toBeVisible();
  await m.getByRole("dialog").getByRole("link", { name: "Websites", exact: true }).click();
  await expect(m).toHaveURL(/\/websites$/);
  await expect(m.getByRole("dialog", { name: "Navigation" })).toHaveCount(0);
  await ctx.close();
});
