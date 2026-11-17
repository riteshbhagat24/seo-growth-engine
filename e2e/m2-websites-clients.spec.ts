import { expect, test, type Browser, type Page } from "@playwright/test";
import { linkFromEmail, strongPassword, uniqueEmail } from "./mail";

/** M2 end-to-end: websites, verification, plan limits, clients and the client role. */
test.describe.configure({ mode: "serial" });

let ip = 100 + Math.floor(Math.random() * 100);
const person = (label: string, name: string) => ({ name, email: uniqueEmail(label), password: strongPassword() });

async function signUp(browser: Browser, who: { name: string; email: string; password: string }, next?: string): Promise<Page> {
  const ctx = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": `198.18.7.${ip++}` } });
  const page = await ctx.newPage();
  await page.goto(next ? `/sign-up?next=${encodeURIComponent(next)}` : "/sign-up");
  await page.getByLabel("Your name").fill(who.name);
  await page.getByLabel("Work email").fill(who.email);
  await page.getByLabel("Password", { exact: true }).fill(who.password);
  await page.getByLabel("Confirm password").fill(who.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText(/sent a verification link/)).toBeVisible();
  await page.goto(await linkFromEmail(who.email, /Verify your email/));
  return page;
}

const stamp = Date.now().toString(36);
const solo = person("solo", "Sam Solo");
const owner = person("agency", "Ava Agency");
const clientUser = person("client", "Chris Client");
let soloPage: Page;
let ownerPage: Page;
let agencyPath = "";
let agencySiteUrl = "";
let clientSiteUrl = "";

test("personal workspace: add a website and see verification instructions", async ({ browser }) => {
  soloPage = await signUp(browser, solo);
  const base = new URL(soloPage.url()).pathname;
  await soloPage.getByRole("link", { name: "Add your first website" }).click();
  await soloPage.getByLabel("Website address").fill(`https://www.solo-${stamp}.com/some/page`);
  await soloPage.getByRole("button", { name: "Add website" }).click();
  await expect(soloPage).toHaveURL(new RegExp(`${base}/websites/[0-9a-f-]{36}$`));
  await expect(soloPage.getByRole("heading", { name: `solo-${stamp}.com` })).toBeVisible();
  await expect(soloPage.getByText("Not verified")).toBeVisible();
  await expect(soloPage.getByText(/^sge-site-verification=[0-9a-f]{32}$/)).toBeVisible();
  await expect(soloPage.getByText(/<meta name="sge-site-verification" content="[0-9a-f]{32}">/)).toBeVisible();
});

test("verification failure is explained, and retries are throttled", async () => {
  await soloPage.getByRole("button", { name: "Check DNS record" }).click();
  await expect(soloPage.getByText(/TXT/).first()).toBeVisible();
  await soloPage.getByRole("button", { name: "Check meta tag" }).click();
  await expect(soloPage.getByText(/wait 10 seconds/)).toBeVisible();
});

test("the Free plan allows one website", async () => {
  const base = new URL(soloPage.url()).pathname.split("/websites")[0];
  await soloPage.goto(`${base}/websites`);
  await soloPage.getByLabel("Website address").fill(`second-${stamp}.com`);
  await soloPage.getByRole("button", { name: "Add website" }).click();
  await expect(soloPage.getByText(/Free plan allows 1 websites/)).toBeVisible();
  await soloPage.goto(`${base}/settings/usage`);
  await expect(soloPage.getByText("Free", { exact: true })).toBeVisible();
  await expect(soloPage.getByRole("listitem").filter({ hasText: "Websites" })).toContainText("1 / 1");
});

test("agency: create a client and add a website for it", async ({ browser }) => {
  ownerPage = await signUp(browser, owner);
  await ownerPage.goto("/workspaces/new");
  await ownerPage.getByLabel("Agency name").fill("E2E Clients Agency");
  await ownerPage.getByRole("button", { name: "Create workspace" }).click();
  await expect(ownerPage).toHaveURL(/\/w\/e2e-clients-agency-[0-9a-f]{6}$/);
  agencyPath = new URL(ownerPage.url()).pathname;

  await ownerPage.getByRole("link", { name: "Clients" }).click();
  await ownerPage.getByLabel("Client name").fill("Acme Retail");
  await ownerPage.getByRole("button", { name: "Add client" }).click();
  await expect(ownerPage.getByRole("heading", { name: "Acme Retail" })).toBeVisible();

  await ownerPage.getByRole("link", { name: "Add website" }).click();
  await expect(ownerPage.getByLabel("Client")).toHaveValue(/[0-9a-f-]{36}/); // pre-selected
  await ownerPage.getByLabel("Website address").fill(`acme-${stamp}.com`);
  await ownerPage.getByRole("button", { name: "Add website" }).click();
  await expect(ownerPage.getByText(`https://acme-${stamp}.com · Acme Retail`)).toBeVisible();
  await expect(ownerPage).toHaveURL(/\/websites\/[0-9a-f-]{36}$/);
  clientSiteUrl = new URL(ownerPage.url()).pathname;

  await ownerPage.goto(`${agencyPath}/websites`);
  await ownerPage.getByLabel("Website address").fill(`agency-${stamp}.com`);
  await ownerPage.getByLabel("Client").selectOption({ label: "No client (agency site)" });
  await ownerPage.getByRole("button", { name: "Add website" }).click();
  await expect(ownerPage).toHaveURL(/\/websites\/[0-9a-f-]{36}$/);
  agencySiteUrl = new URL(ownerPage.url()).pathname;
});

test("agency: invite a client user limited to Acme", async () => {
  await ownerPage.goto(`${agencyPath}/settings/members`);
  await ownerPage.getByLabel("Email").fill(clientUser.email);
  await ownerPage.getByLabel("Role").selectOption("client");
  await ownerPage.getByLabel("Acme Retail").check();
  await ownerPage.getByRole("button", { name: "Send invitation" }).click();
  await expect(ownerPage.getByText(`Invitation sent to ${clientUser.email}`)).toBeVisible();
});

test("the client user sees only Acme's website, read-only", async ({ browser }) => {
  const invite = await linkFromEmail(clientUser.email, /invited you to E2E Clients Agency/);
  const page = await signUp(browser, clientUser, new URL(invite).pathname);
  await page.getByRole("button", { name: "Accept and join" }).click();
  await expect(page).toHaveURL(new RegExp(`${agencyPath}$`));

  await page.getByRole("link", { name: "Websites" }).click();
  await expect(page.getByRole("link", { name: `acme-${stamp}.com` })).toBeVisible();
  await expect(page.getByRole("link", { name: `agency-${stamp}.com` })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add website" })).toHaveCount(0);

  expect((await page.goto(agencySiteUrl))?.status()).toBe(404); // agency's own site: invisible
  await page.goto(clientSiteUrl);
  await expect(page.getByText("This website hasn't been verified yet.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Check/ })).toHaveCount(0);

  // No team, usage or audit pages for clients.
  for (const p of ["settings/members", "settings/usage", "settings/audit", "settings"]) {
    expect((await page.goto(`${agencyPath}/${p}`))?.status()).toBe(404);
  }
  await page.goto(`${agencyPath}/clients`);
  await expect(page.getByRole("link", { name: "Acme Retail" })).toBeVisible();
});

test("the owner sees the client's restricted access and agency usage", async () => {
  await ownerPage.goto(`${agencyPath}/settings/members`);
  await expect(ownerPage.getByRole("row", { name: /Chris Client/ })).toContainText("Acme Retail");
  await ownerPage.goto(`${agencyPath}/settings/usage`);
  await expect(ownerPage.getByText("Agency Free", { exact: true })).toBeVisible();
  await expect(ownerPage.getByRole("listitem").filter({ hasText: "Websites" })).toContainText("2 / 3");
  await expect(ownerPage.getByRole("listitem").filter({ hasText: "Clients" })).toContainText("1 / 3");
});
