import { z } from "zod";

/** Treat blank env values ("FOO=") as unset. */
const optional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === "" ? undefined : v), schema.optional());

/**
 * Server-side environment. Parsed lazily so that build steps which never touch
 * the database (e.g. `next build` of static pages) don't require every secret.
 */
const serverSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /** Runtime connection as `app_user` (RLS enforced, no BYPASSRLS). */
  DATABASE_URL: z.string().url(),
  /** Identity connection as `auth_user` (schema "auth" only). */
  AUTH_DATABASE_URL: optional(z.string().url()),
  /** Owner connection, used only by migrations and admin tooling. */
  DATABASE_URL_OWNER: optional(z.string().url()),
  APP_URL: z.string().url().default("http://localhost:3000"),
  PRODUCT_NAME: z.string().min(1).default("Futuready Media"),
  /** Signs sessions and tokens. ≥ 32 chars. */
  BETTER_AUTH_SECRET: optional(z.string().min(32)),
  /** 32-byte key, base64. Required in production (credential encryption). */
  ENCRYPTION_KEY: optional(z.string()),
  CRON_SECRET: optional(z.string().min(16)),

  SMTP_HOST: optional(z.string()),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_SECURE: z.preprocess((v) => v === "true" || v === "1", z.boolean()).default(false),
  SMTP_USER: optional(z.string()),
  SMTP_PASS: optional(z.string()),
  MAIL_FROM: z.string().default("Futuready Media <no-reply@localhost>"),

  /**
   * Headers the hosting proxy sets (overwriting any client value) that carry the
   * real client IP. Used for rate limiting and audit logs. Vercel: x-forwarded-for.
   * Check your cPanel host before production (see docs/DEPLOYMENT.md).
   */
  TRUSTED_IP_HEADERS: z
    .string()
    .default("x-forwarded-for")
    .transform((v) => v.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean)),

  GOOGLE_CLIENT_ID: optional(z.string()),
  GOOGLE_CLIENT_SECRET: optional(z.string())
});

export type ServerEnv = z.infer<typeof serverSchema>;

let cached: ServerEnv | undefined;

export function serverEnv(): ServerEnv {
  if (cached) return cached;
  const parsed = serverSchema.safeParse(process.env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid server environment: ${fields}`);
  }
  const env = parsed.data;
  if (env.NODE_ENV === "production") {
    const missing = (["BETTER_AUTH_SECRET", "ENCRYPTION_KEY", "CRON_SECRET", "SMTP_HOST"] as const).filter((k) => !env[k]);
    if (missing.length) throw new Error(`Required in production: ${missing.join(", ")}`);
    const { protocol, hostname } = new URL(env.APP_URL);
    const local = hostname === "localhost" || hostname === "127.0.0.1";
    if (protocol !== "https:" && !local) throw new Error("APP_URL must use https in production");
  }
  cached = env;
  return cached;
}

export const googleSignInEnabled = (env: ServerEnv) => Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
