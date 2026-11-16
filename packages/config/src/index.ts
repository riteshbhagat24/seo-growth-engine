import { z } from "zod";

/**
 * Server-side environment. Parsed lazily so that build steps which never touch
 * the database (e.g. `next build` of static pages) don't require every secret.
 */
/** Treat blank env values ("FOO=") as unset. */
const optional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === "" ? undefined : v), schema.optional());

const serverSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /** Runtime connection as `app_user` (RLS enforced, no BYPASSRLS). */
  DATABASE_URL: z.string().url(),
  /** Owner connection, used only by migrations and admin tooling. */
  DATABASE_URL_OWNER: optional(z.string().url()),
  APP_URL: z.string().url().default("http://localhost:3000"),
  PRODUCT_NAME: z.string().min(1).default("Futuready Media"),
  /** 32-byte key, base64. Required in production (credential encryption). */
  ENCRYPTION_KEY: optional(z.string()),
  CRON_SECRET: optional(z.string().min(16))
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
  if (parsed.data.NODE_ENV === "production") {
    if (!parsed.data.ENCRYPTION_KEY) throw new Error("ENCRYPTION_KEY is required in production");
    if (!parsed.data.CRON_SECRET) throw new Error("CRON_SECRET is required in production");
  }
  cached = parsed.data;
  return cached;
}
