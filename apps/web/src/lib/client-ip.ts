import "server-only";
import { serverEnv } from "@sge/config";

/** Client IP from the configured trusted proxy header(s); first address wins. */
export function clientIp(h: Headers | null | undefined): string | null {
  if (!h) return null;
  for (const name of serverEnv().TRUSTED_IP_HEADERS) {
    const v = h.get(name)?.split(",")[0]?.trim();
    if (v) return v.slice(0, 64);
  }
  return null;
}
