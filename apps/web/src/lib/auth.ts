import "server-only";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { haveIBeenPwned, magicLink } from "better-auth/plugins";
import { nextCookies } from "better-auth/next-js";
import { createDb, schema, withContext } from "@sge/db";
import { audit, ensurePersonalWorkspace } from "@sge/core";
import { googleSignInEnabled, serverEnv } from "@sge/config";
import { db } from "./db";
import { clientIp } from "./client-ip";
import { sendActionEmail } from "./mail";

export const COOKIE_PREFIX = "sge";

function clientMeta(request?: Request | null) {
  const h = request?.headers;
  return {
    ip: clientIp(h),
    userAgent: h?.get("user-agent") ?? null
  };
}

function createAuth() {
  const env = serverEnv();
  if (!env.AUTH_DATABASE_URL) throw new Error("AUTH_DATABASE_URL is not configured");
  if (!env.BETTER_AUTH_SECRET) throw new Error("BETTER_AUTH_SECRET is not configured");
  const product = env.PRODUCT_NAME;

  return betterAuth({
    appName: product,
    baseURL: env.APP_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.APP_URL],
    database: drizzleAdapter(createDb(env.AUTH_DATABASE_URL), {
      provider: "pg",
      schema: {
        user: schema.users,
        session: schema.sessions,
        account: schema.accounts,
        verification: schema.verifications,
        rateLimit: schema.rateLimits
      }
    }),
    advanced: {
      cookiePrefix: COOKIE_PREFIX,
      ipAddress: { ipAddressHeaders: env.TRUSTED_IP_HEADERS },
      database: { generateId: "uuid" }
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: 10,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        await sendActionEmail({
          to: user.email,
          subject: `Reset your ${product} password`,
          intro: "Someone asked to reset the password for this account. If it was you, use the button below. The link expires in 1 hour.",
          actionLabel: "Reset password",
          actionUrl: url,
          outro: "If you didn't ask for this, you can ignore this email; your password won't change."
        });
      }
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        await sendActionEmail({
          to: user.email,
          subject: `Verify your email for ${product}`,
          intro: `Welcome to ${product}. Confirm this is your email address to finish creating your account.`,
          actionLabel: "Verify email",
          actionUrl: url
        });
      }
    },
    socialProviders: googleSignInEnabled(env)
      ? { google: { clientId: env.GOOGLE_CLIENT_ID!, clientSecret: env.GOOGLE_CLIENT_SECRET! } }
      : {},
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/sign-up/email": { window: 300, max: 5 },
        "/sign-in/magic-link": { window: 300, max: 5 },
        "/request-password-reset": { window: 300, max: 5 },
        "/send-verification-email": { window: 300, max: 5 }
      }
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user, ctx) => {
            const meta = clientMeta(ctx?.request);
            try {
              await withContext(db(), { userId: user.id }, (tx) =>
                audit(tx, { organizationId: null, actorUserId: user.id, action: "user.signed_up", ...meta })
              );
              await ensurePersonalWorkspace(db(), { userId: user.id, ...meta }, user.name);
            } catch (err) {
              // Not fatal: /app calls ensurePersonalWorkspace again on first visit.
              console.error("[auth] post-signup setup failed:", (err as Error).message);
            }
          }
        }
      },
      session: {
        create: {
          after: async (session, ctx) => {
            try {
              await withContext(db(), { userId: session.userId }, (tx) =>
                audit(tx, {
                  organizationId: null,
                  actorUserId: session.userId,
                  action: "user.signed_in",
                  ...clientMeta(ctx?.request)
                })
              );
            } catch (err) {
              console.error("[auth] sign-in audit failed:", (err as Error).message);
            }
          }
        }
      }
    },
    plugins: [
      magicLink({
        expiresIn: 600,
        sendMagicLink: async ({ email, url }) => {
          await sendActionEmail({
            to: email,
            subject: `Your ${product} sign-in link`,
            intro: "Use the button below to sign in. The link works once and expires in 10 minutes.",
            actionLabel: "Sign in",
            actionUrl: url,
            outro: "If you didn't ask for this, you can ignore this email."
          });
        }
      }),
      haveIBeenPwned({
        customPasswordCompromisedMessage:
          "This password has appeared in a known data breach. Please choose a different one."
      }),
      nextCookies() // must be last
    ]
  });
}

type Auth = ReturnType<typeof createAuth>;
let instance: Auth | undefined;

/** Lazily constructed so `next build` doesn't need runtime secrets. */
export function getAuth(): Auth {
  return (instance ??= createAuth());
}
