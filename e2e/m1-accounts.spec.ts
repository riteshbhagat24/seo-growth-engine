import { expect, test, type Browser, type Page } from "@playwright/test";
import { linkFromEmail, strongPassword, uniqueEmail } from "./mail";

/**
 * M1 end-to-end: real browser, real production bundle, real database, real emails.
 * One serial story so later steps can build on earlier ones.
 */
test.describe.configure({ mode: "serial" });

const owner = { name: "Olivia Owner", email: uniqueEmail("owner"), password: strongPassword() };
const invitee = { name: "Ivan Invitee", email: uniqueEmail("invitee"), password: strongPassword() };
const outsider = { name: "Oscar Outsider", email: uniqueEmail("outsider"), password: strongPassword() };

let ownerPage: Page;
let inviteePage: Page;
let agencyPath = "";
let inviteUrl = "";

/** Each simulated person gets their own client IP (rate limits are per IP). */
let ipCounter = Math.floor(Math.random() * 200);
const newPerson = (browser: Browser) =>
  browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": `203.0.113.${(ipCounter++ % 250) + 1}` } });

async function signUp(browser: Browser, who: typeof owner, next?: string): Promise<Page> {
  const page = await (await newPerson(browser)).newPage();
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

test("unauthenticated visitors are sent to sign-in", async ({ page }) => {
  await page.goto("/w/some-workspace");
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fw%2Fsome-workspace/);
});

test("sign-up → email verification → personal workspace", async ({ browser }) => {
  ownerPage = await signUp(browser, owner);
  await expect(ownerPage).toHaveURL(/\/w\/olivia-s-workspace-[0-9a-f]{6}$/);
  await expect(ownerPage.getByRole("heading", { name: "Olivia's workspace" })).toBeVisible();
  await expect(ownerPage.getByText("Personal workspace", { exact: true })).toBeVisible();
});

test("wrong password is rejected", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(owner.email);
  await page.getByLabel("Password").fill("definitely-not-it-123");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText("Invalid email or password")).toBeVisible();
});

test("owner creates an agency workspace", async () => {
  await ownerPage.goto("/workspaces/new");
  await ownerPage.getByLabel("Agency name").fill("E2E Agency");
  await ownerPage.getByRole("button", { name: "Create workspace" }).click();
  await expect(ownerPage).toHaveURL(/\/w\/e2e-agency-[0-9a-f]{6}$/);
  agencyPath = new URL(ownerPage.url()).pathname;
  await expect(ownerPage.getByRole("heading", { name: "E2E Agency" })).toBeVisible();
});

test("owner invites a manager by email", async () => {
  await ownerPage.goto(`${agencyPath}/settings/members`);
  await ownerPage.getByLabel("Email").fill(invitee.email);
  await ownerPage.getByLabel("Role").selectOption("manager");
  await ownerPage.getByRole("button", { name: "Send invitation" }).click();
  await expect(ownerPage.getByText(`Invitation sent to ${invitee.email}`)).toBeVisible();
  await expect(ownerPage.getByText("Pending invitations")).toBeVisible();
  inviteUrl = await linkFromEmail(invitee.email, /invited you to E2E Agency/);
  expect(inviteUrl).toMatch(/\/invite\/[A-Za-z0-9_-]{43}$/);
});

test("invitee signs up from the invitation and joins", async ({ browser }) => {
  const anon = await (await newPerson(browser)).newPage();
  await anon.goto(inviteUrl);
  await expect(anon.getByText(/invited to join E2E Agency as Manager/)).toBeVisible();

  inviteePage = await signUp(browser, invitee, new URL(inviteUrl).pathname);
  await expect(inviteePage).toHaveURL(new RegExp(`${new URL(inviteUrl).pathname}$`));
  await inviteePage.getByRole("button", { name: "Accept and join" }).click();
  await expect(inviteePage).toHaveURL(new RegExp(`${agencyPath}$`));
  await expect(inviteePage.getByRole("main").getByText("Manager", { exact: true })).toBeVisible();

  // The link can't be reused.
  await inviteePage.goto(inviteUrl);
  await expect(inviteePage.getByText(/already been used/)).toBeVisible();
});

test("roles are enforced in the UI and on direct URLs", async () => {
  await inviteePage.goto(`${agencyPath}/settings/members`);
  await expect(inviteePage.getByRole("cell", { name: /Olivia Owner/ })).toBeVisible();
  await expect(inviteePage.getByRole("button", { name: "Send invitation" })).toHaveCount(0);
  const audit = await inviteePage.goto(`${agencyPath}/settings/audit`);
  expect(audit?.status()).toBe(404);
});

test("outsiders get a 404 for someone else's workspace", async ({ browser }) => {
  const page = await signUp(browser, outsider);
  const res = await page.goto(agencyPath);
  expect(res?.status()).toBe(404);
  // Their switcher lists only their own workspace.
  await page.goto("/app");
  await page.locator("summary").first().click();
  await expect(page.getByRole("link", { name: /E2E Agency/ })).toHaveCount(0);
});

test("branding applies to the workspace and is audited", async () => {
  await ownerPage.goto(`${agencyPath}/settings`);
  await ownerPage.getByLabel("Primary colour").fill("#7a1fa2");
  await ownerPage.getByRole("button", { name: "Save branding" }).click();
  await expect(ownerPage.getByText("Branding saved.")).toBeVisible();
  await ownerPage.goto(agencyPath);
  const brand = await ownerPage.locator("[style*='--brand']").first().getAttribute("style");
  expect(brand).toContain("#7a1fa2");

  await ownerPage.goto(`${agencyPath}/settings/audit`);
  for (const what of ["Created the workspace", "Invited a member", "Joined via invitation", "Updated workspace settings"]) {
    await expect(ownerPage.getByRole("cell", { name: what })).toBeVisible();
  }
});

test("sign out, then sign back in with a password", async () => {
  await inviteePage.goto(agencyPath);
  await inviteePage.getByRole("button", { name: "Sign out" }).click();
  await expect(inviteePage).toHaveURL(/\/sign-in/);
  const res = await inviteePage.goto(agencyPath);
  expect(new URL(inviteePage.url()).pathname).toBe("/sign-in");
  expect(res?.status()).toBe(200);

  await inviteePage.getByLabel("Email").fill(invitee.email);
  await inviteePage.getByLabel("Password").fill(invitee.password);
  await inviteePage.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(inviteePage).toHaveURL(new RegExp(`${agencyPath}$`));
});

test("password reset by email works and signs out other sessions", async ({ browser }) => {
  const page = await (await newPerson(browser)).newPage();
  await page.goto("/forgot-password");
  await page.getByLabel("Email").fill(owner.email);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByText(/reset link is on its way/)).toBeVisible();
  await page.goto(await linkFromEmail(owner.email, /Reset your/));
  const newPassword = strongPassword();
  await page.getByLabel("New password", { exact: true }).fill(newPassword);
  await page.getByLabel("Confirm new password").fill(newPassword);
  await page.getByRole("button", { name: "Set new password" }).click();
  await expect(page.getByText(/Password updated/)).toBeVisible();

  // The owner's earlier session was revoked.
  await ownerPage.goto(agencyPath);
  await expect(ownerPage).toHaveURL(/\/sign-in/);
});

test("sign-in attempts are rate limited per client IP", async ({ request }) => {
  const ip = `198.51.100.${Math.floor(Math.random() * 250) + 1}`;
  const statuses: number[] = [];
  for (let i = 0; i < 7; i++) {
    const res = await request.post("/api/auth/sign-in/email", {
      headers: { "x-forwarded-for": ip, origin: "http://localhost:3123" },
      data: { email: owner.email, password: "wrong-password-123" }
    });
    statuses.push(res.status());
  }
  expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
  expect(statuses.at(-1)).toBe(429);
  // A different client is unaffected.
  const other = await request.post("/api/auth/sign-in/email", {
    headers: { "x-forwarded-for": "198.51.100.251", origin: "http://localhost:3123" },
    data: { email: owner.email, password: "wrong-password-123" }
  });
  expect(other.status()).toBe(401);
});
