import "server-only";
import { isAppError } from "@sge/core";
import type { ActionResult } from "@/components/form";

/**
 * Wraps a server action body: AppErrors become user-facing messages; anything
 * else is logged and replaced with a generic message (no internals leak).
 * Next.js redirect/notFound control-flow errors are re-thrown untouched.
 */
export async function runAction(fn: () => Promise<ActionResult | void>): Promise<ActionResult> {
  try {
    return (await fn()) ?? null;
  } catch (e) {
    if (isAppError(e)) return { error: e.message };
    const digest = (e as { digest?: string })?.digest;
    if (typeof digest === "string" && (digest.startsWith("NEXT_REDIRECT") || digest.startsWith("NEXT_HTTP_ERROR_FALLBACK")))
      throw e;
    console.error("[action] unexpected error:", e);
    return { error: "Something went wrong. Please try again." };
  }
}

export const field = (data: FormData, name: string) => {
  const v = data.get(name);
  return typeof v === "string" ? v : "";
};
