import { createHash, randomBytes } from "node:crypto";
import { and, eq, inArray, schema, type Db, type Tx } from "@sge/db";
import { audit } from "./audit";
import { inWorkspace, requireAction, type Actor, type WorkspaceAccess } from "./context";
import { AppError } from "./errors";
import { decryptSecret, encryptSecret } from "./secrets";

const { integrations, schedules } = schema;

/**
 * Google OAuth for data access (Search Console + Analytics), per workspace.
 * Separate from "Sign in with Google": a workspace connects one Google account
 * whose refresh token is stored encrypted. Read-only scopes only.
 */
export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/webmasters.readonly",
  "https://www.googleapis.com/auth/analytics.readonly"
] as const;
export const GSC_SCOPE = GOOGLE_SCOPES[2];
export const GA4_SCOPE = GOOGLE_SCOPES[3];

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface GoogleDeps {
  fetch: typeof fetch;
  /** Null when the platform hasn't configured a Google OAuth client. */
  config: () => GoogleOAuthConfig | null;
}

export const GOOGLE_CALLBACK_PATH = "/api/integrations/google/callback";

export const defaultGoogleDeps: GoogleDeps = {
  fetch: (...a) => fetch(...a),
  config: () => {
    const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
    const appUrl = process.env.APP_URL?.trim().replace(/\/+$/, "");
    return clientId && clientSecret && appUrl ? { clientId, clientSecret, redirectUri: `${appUrl}${GOOGLE_CALLBACK_PATH}` } : null;
  }
};

const aad = (organizationId: string) => `${organizationId}:google`;

/* ─────────────────────────────── OAuth flow ────────────────────────────── */

export interface OAuthStart {
  url: string;
  state: string;
  verifier: string;
}

/** Authorization URL with PKCE (S256) and a random state; the caller keeps state + verifier server-side (signed cookie). */
export function googleAuthStart(cfg: GoogleOAuthConfig, loginHint?: string): OAuthStart {
  const state = randomBytes(24).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const u = new URL(AUTH_URL);
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", cfg.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("include_granted_scopes", "true");
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  if (loginHint) u.searchParams.set("login_hint", loginHint);
  return { url: u.toString(), state, verifier };
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  id_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

/** Email claim from an ID token received directly from Google's token endpoint over TLS. */
function emailFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8")) as { email?: string };
    return typeof payload.email === "string" ? payload.email.slice(0, 320) : null;
  } catch {
    return null;
  }
}

/** Exchanges the authorization code and stores the encrypted refresh token for the workspace. */
export async function completeGoogleConnection(
  db: Db,
  actor: Actor,
  access: WorkspaceAccess,
  input: { code: string; verifier: string },
  deps: GoogleDeps = defaultGoogleDeps
): Promise<{ email: string | null; scopes: string[] }> {
  const cfg = deps.config();
  if (!cfg) throw new AppError("invalid_input", "Google isn't configured on this platform yet");
  // Authorise before talking to Google.
  await inWorkspace(db, actor, access, async (_tx, { role }) => requireAction(role, "integrations.manage"));

  const res = await deps.fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: input.code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: cfg.redirectUri,
      grant_type: "authorization_code",
      code_verifier: input.verifier
    }),
    signal: AbortSignal.timeout(15_000)
  });
  const body = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !body.refresh_token) {
    if (res.ok && !body.refresh_token) throw new AppError("verification_failed", "Google didn't return offline access. Please try connecting again.");
    throw new AppError("verification_failed", "Google sign-in didn't complete. Please try again.");
  }
  const scopes = (body.scope ?? "").split(/\s+/).filter(Boolean);
  if (!scopes.includes(GSC_SCOPE) && !scopes.includes(GA4_SCOPE))
    throw new AppError("verification_failed", "Please allow access to Search Console and/or Analytics on Google's consent screen.");
  const email = emailFromIdToken(body.id_token);

  await inWorkspace(db, actor, access, async (tx, { role }) => {
    requireAction(role, "integrations.manage");
    const values = {
      credentialsEnc: encryptSecret(JSON.stringify({ refreshToken: body.refresh_token }), aad(access.workspace.id)),
      keyHint: null,
      scopes,
      accountEmail: email,
      status: "active",
      lastError: null,
      connectedByUserId: actor.userId,
      updatedAt: new Date()
    };
    await tx
      .insert(integrations)
      .values({ organizationId: access.workspace.id, provider: "google", ...values })
      .onConflictDoUpdate({ target: [integrations.organizationId, integrations.provider], set: values });
    await audit(tx, {
      organizationId: access.workspace.id,
      actorUserId: actor.userId,
      action: "integration.google_connected",
      entityType: "integration",
      metadata: { email, scopes },
      ip: actor.ip,
      userAgent: actor.userAgent
    });
  });
  return { email, scopes };
}

export async function disconnectGoogle(db: Db, actor: Actor, access: WorkspaceAccess, deps: GoogleDeps = defaultGoogleDeps): Promise<void> {
  const refresh = await inWorkspace(db, actor, access, async (tx, { role }) => {
    requireAction(role, "integrations.manage");
    const token = await googleRefreshToken(tx, access.workspace.id);
    await tx.delete(integrations).where(and(eq(integrations.organizationId, access.workspace.id), eq(integrations.provider, "google")));
    // Stop syncing; data already imported stays.
    await tx
      .update(schedules)
      .set({ enabled: false, updatedAt: new Date() })
      .where(and(eq(schedules.organizationId, access.workspace.id), inArray(schedules.jobType, ["gsc.sync", "ga4.sync"])));
    await audit(tx, {
      organizationId: access.workspace.id,
      actorUserId: actor.userId,
      action: "integration.google_disconnected",
      entityType: "integration",
      ip: actor.ip,
      userAgent: actor.userAgent
    });
    return token;
  });
  if (refresh) {
    // Best effort: also revoke at Google.
    await deps
      .fetch(REVOKE_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: refresh }),
        signal: AbortSignal.timeout(10_000)
      })
      .catch(() => undefined);
  }
}

export interface GoogleConnection {
  configured: boolean;
  connected: boolean;
  email: string | null;
  scopes: string[];
  status: string | null;
  lastError: string | null;
  updatedAt: Date | null;
}

export async function getGoogleConnection(db: Db, actor: Actor, access: WorkspaceAccess, deps: GoogleDeps = defaultGoogleDeps): Promise<GoogleConnection> {
  return inWorkspace(db, actor, access, async (tx) => {
    const [row] = await tx
      .select()
      .from(integrations)
      .where(and(eq(integrations.organizationId, access.workspace.id), eq(integrations.provider, "google")));
    return {
      configured: deps.config() !== null,
      connected: Boolean(row?.credentialsEnc) && row?.status === "active",
      email: row?.accountEmail ?? null,
      scopes: row?.scopes ?? [],
      status: row?.status ?? null,
      lastError: row?.lastError ?? null,
      updatedAt: row?.updatedAt ?? null
    };
  });
}

/* ─────────────────────────────── Tokens ────────────────────────────────── */

export async function googleRefreshToken(tx: Tx, organizationId: string): Promise<string | null> {
  const [row] = await tx
    .select()
    .from(integrations)
    .where(and(eq(integrations.organizationId, organizationId), eq(integrations.provider, "google")));
  if (!row?.credentialsEnc) return null;
  try {
    return (JSON.parse(decryptSecret(row.credentialsEnc, aad(organizationId))) as { refreshToken: string }).refreshToken;
  } catch {
    return null;
  }
}

/** Raised when Google access is gone (revoked / expired): jobs stop retrying and the UI asks to reconnect. */
export class GoogleAuthError extends AppError {
  constructor(message: string) {
    super("verification_failed", message);
  }
}

/** Exchanges the stored refresh token for a short-lived access token. */
export async function googleAccessToken(refreshToken: string, deps: GoogleDeps = defaultGoogleDeps): Promise<string> {
  const cfg = deps.config();
  if (!cfg) throw new GoogleAuthError("Google isn't configured on this platform");
  const res = await deps.fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
    signal: AbortSignal.timeout(15_000)
  });
  const body = (await res.json().catch(() => ({}))) as TokenResponse;
  if (res.ok && body.access_token) return body.access_token;
  if (body.error === "invalid_grant" || res.status === 400 || res.status === 401)
    throw new GoogleAuthError("Google access has expired or was revoked. Reconnect Google in Settings → Integrations.");
  throw new Error(`Google token endpoint returned ${res.status}`);
}

export async function markGoogleError(tx: Tx, organizationId: string, error: string | null, expired = false): Promise<void> {
  await tx
    .update(integrations)
    .set({ lastError: error?.slice(0, 300) ?? null, ...(expired ? { status: "expired" } : {}), updatedAt: new Date() })
    .where(and(eq(integrations.organizationId, organizationId), eq(integrations.provider, "google")));
}

/** Access token for a workspace's connected Google account (reads the refresh token in its own short transaction). */
export async function workspaceGoogleToken(
  run: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>,
  organizationId: string,
  deps: GoogleDeps = defaultGoogleDeps
): Promise<string> {
  const refresh = await run((tx) => googleRefreshToken(tx, organizationId));
  if (!refresh) throw new GoogleAuthError("Google isn't connected for this workspace.");
  try {
    return await googleAccessToken(refresh, deps);
  } catch (e) {
    if (e instanceof GoogleAuthError) await run((tx) => markGoogleError(tx, organizationId, e.message, true));
    throw e;
  }
}

/* ─────────────────────────────── API calls ─────────────────────────────── */

export class GoogleApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
  get transient() {
    return this.status === 429 || this.status >= 500;
  }
}

async function googleJson<T>(deps: GoogleDeps, token: string, url: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await deps.fetch(url, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${token}`, ...(init.body ? { "content-type": "application/json" } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(30_000)
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; status?: string } };
  if (!res.ok) throw new GoogleApiError(res.status, String(body.error?.message ?? res.statusText).slice(0, 300));
  return body;
}

export interface GscSite {
  siteUrl: string;
  permissionLevel: string;
}

export async function listGscSites(token: string, deps: GoogleDeps = defaultGoogleDeps): Promise<GscSite[]> {
  const r = await googleJson<{ siteEntry?: GscSite[] }>(deps, token, "https://www.googleapis.com/webmasters/v3/sites");
  return (r.siteEntry ?? []).filter((s) => s.permissionLevel !== "siteUnverifiedUser");
}

export interface GscRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export async function gscQuery(
  token: string,
  property: string,
  body: { startDate: string; endDate: string; dimensions: string[]; rowLimit?: number; startRow?: number },
  deps: GoogleDeps = defaultGoogleDeps
): Promise<GscRow[]> {
  const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property)}/searchAnalytics/query`;
  const r = await googleJson<{ rows?: GscRow[] }>(deps, token, url, { method: "POST", body: { ...body, dataState: "final" } });
  return r.rows ?? [];
}

export interface Ga4Property {
  property: string;
  displayName: string;
  account: string;
}

export async function listGa4Properties(token: string, deps: GoogleDeps = defaultGoogleDeps): Promise<Ga4Property[]> {
  const out: Ga4Property[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < 10; i++) {
    const u = new URL("https://analyticsadmin.googleapis.com/v1beta/accountSummaries");
    u.searchParams.set("pageSize", "200");
    if (pageToken) u.searchParams.set("pageToken", pageToken);
    const r = await googleJson<{
      accountSummaries?: { displayName?: string; propertySummaries?: { property: string; displayName?: string }[] }[];
      nextPageToken?: string;
    }>(deps, token, u.toString());
    for (const a of r.accountSummaries ?? [])
      for (const p of a.propertySummaries ?? []) out.push({ property: p.property, displayName: p.displayName ?? p.property, account: a.displayName ?? "" });
    pageToken = r.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

export interface Ga4Report {
  rows: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[];
  rowCount: number;
}

export async function ga4RunReport(
  token: string,
  property: string,
  body: { startDate: string; endDate: string; dimensions: string[]; metrics: string[]; limit: number; offset: number },
  deps: GoogleDeps = defaultGoogleDeps
): Promise<Ga4Report> {
  if (!/^properties\/\d+$/.test(property)) throw new GoogleApiError(400, "Invalid GA4 property");
  const r = await googleJson<{ rows?: Ga4Report["rows"]; rowCount?: number }>(deps, token, `https://analyticsdata.googleapis.com/v1beta/${property}:runReport`, {
    method: "POST",
    body: {
      dateRanges: [{ startDate: body.startDate, endDate: body.endDate }],
      dimensions: body.dimensions.map((name) => ({ name })),
      metrics: body.metrics.map((name) => ({ name })),
      limit: String(body.limit),
      offset: String(body.offset),
      keepEmptyRows: false
    }
  });
  return { rows: r.rows ?? [], rowCount: r.rowCount ?? 0 };
}

/** True if a Search Console property covers the website's domain. */
export function gscPropertyMatches(property: string, domain: string): boolean {
  const d = domain.toLowerCase().replace(/^www\./, "");
  if (property.startsWith("sc-domain:")) {
    const p = property.slice("sc-domain:".length).toLowerCase();
    return d === p || d.endsWith(`.${p}`);
  }
  try {
    return new URL(property).hostname.toLowerCase().replace(/^www\./, "") === d;
  } catch {
    return false;
  }
}
