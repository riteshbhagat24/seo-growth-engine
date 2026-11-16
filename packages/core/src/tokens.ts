import { createHash, randomBytes } from "node:crypto";

/** 256-bit random token, URL-safe. Only the hash is ever stored. */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Rejects anything that couldn't have come from newToken() before hashing. */
export function isWellFormedToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}
