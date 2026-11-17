import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { serverEnv } from "@sge/config";

/** Short-lived, tamper-proof values for cookies (HMAC-SHA256 with the auth secret). */
const key = () => {
  const s = serverEnv().BETTER_AUTH_SECRET;
  if (!s) throw new Error("BETTER_AUTH_SECRET is not configured");
  return `signed-cookie:${s}`;
};

export function sign(payload: Record<string, unknown>, ttlSeconds: number): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlSeconds * 1000 })).toString("base64url");
  const mac = createHmac("sha256", key()).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function verify<T extends Record<string, unknown>>(token: string | undefined): T | null {
  if (!token) return null;
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const expected = createHmac("sha256", key()).update(body).digest();
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T & { exp: number };
    return typeof data.exp === "number" && data.exp > Date.now() ? data : null;
  } catch {
    return null;
  }
}

export const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Holds the Google OAuth state + PKCE verifier between /start and /callback. */
export const OAUTH_COOKIE = "sge-google-oauth";
