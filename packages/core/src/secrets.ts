import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM for credentials at rest (API keys, later OAuth tokens and SMTP
 * passwords). Format: "v1:" + base64(iv[12] | tag[16] | ciphertext).
 * The key comes from ENCRYPTION_KEY (64 hex chars or base64 of 32 bytes).
 */
const VERSION = "v1";

export function parseEncryptionKey(raw: string | undefined): Buffer {
  const v = (raw ?? "").trim();
  if (!v) throw new Error("ENCRYPTION_KEY is not configured");
  const key = /^[0-9a-f]{64}$/i.test(v) ? Buffer.from(v, "hex") : Buffer.from(v, "base64");
  if (key.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes (64 hex characters or base64)");
  return key;
}

const envKey = () => parseEncryptionKey(process.env.ENCRYPTION_KEY);

/** `aad` binds the ciphertext to its owner (e.g. organisation + provider) so rows can't be swapped. */
export function encryptSecret(plaintext: string, aad: string, key: Buffer = envKey()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${VERSION}:${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64")}`;
}

export function decryptSecret(payload: string, aad: string, key: Buffer = envKey()): string {
  const [version, data] = payload.split(":", 2);
  if (version !== VERSION || !data) throw new Error("Unsupported secret format");
  const buf = Buffer.from(data, "base64");
  if (buf.length < 29) throw new Error("Corrupt secret");
  const decipher = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
}

/** "…abcd": enough to recognise a key, never enough to use it. */
export const keyHint = (secret: string) => `…${secret.slice(-4)}`;
