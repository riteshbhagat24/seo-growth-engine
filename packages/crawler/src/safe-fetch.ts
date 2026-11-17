import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, request } from "undici";
import { isPublicAddress } from "./ip-guard";

export const USER_AGENT = "Mozilla/5.0 (compatible; SEOGrowthEngineBot/1.0; +https://seo-growth-engine-nine.vercel.app/bot)";

export type Resolver = (hostname: string) => Promise<{ address: string; family: number }[]>;

const defaultResolver: Resolver = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** Allowed response content types (prefix match). Default: HTML and plain text. */
  contentTypes?: string[];
  headers?: Record<string, string>;
  /** Injected for tests. */
  resolver?: Resolver;
  /**
   * TESTS ONLY. Lets the suite reach a local fixture server. Never set this
   * from application code.
   */
  unsafeTestOverrides?: { allowAddress?: (address: string) => boolean; allowAnyPort?: boolean };
}

export interface SafeFetchResult {
  url: string;
  status: number;
  contentType: string;
  body: string;
  redirects: string[];
}

export type SafeFetchErrorCode =
  | "invalid_url"
  | "blocked_scheme"
  | "blocked_port"
  | "blocked_address"
  | "dns_failed"
  | "too_many_redirects"
  | "too_large"
  | "bad_content_type"
  | "timeout"
  | "network";

export class SafeFetchError extends Error {
  constructor(
    readonly code: SafeFetchErrorCode,
    message: string
  ) {
    super(message);
    this.name = "SafeFetchError";
  }
}

/** Validates a URL and resolves it to a single vetted public address. */
async function vet(
  raw: string,
  resolver: Resolver,
  overrides: SafeFetchOptions["unsafeTestOverrides"] = {}
): Promise<{ url: URL; address: string; family: number }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SafeFetchError("invalid_url", "That isn't a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new SafeFetchError("blocked_scheme", "Only http and https URLs are allowed");
  if (url.username || url.password) throw new SafeFetchError("invalid_url", "URLs with credentials are not allowed");
  if (url.port && url.port !== "80" && url.port !== "443" && !overrides.allowAnyPort) throw new SafeFetchError("blocked_port", "Only ports 80 and 443 are allowed");

  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: { address: string; family: number }[];
  if (isIP(host)) {
    addresses = [{ address: host, family: isIP(host) }];
  } else {
    try {
      addresses = await resolver(host);
    } catch {
      throw new SafeFetchError("dns_failed", `Couldn't find the domain ${host}`);
    }
    if (addresses.length === 0) throw new SafeFetchError("dns_failed", `Couldn't find the domain ${host}`);
  }
  // Every address must be public: a mixed answer is a classic rebinding setup.
  const allowed = (a: string) => isPublicAddress(a) || overrides.allowAddress?.(a) === true;
  if (addresses.some((a) => !allowed(a.address)))
    throw new SafeFetchError("blocked_address", "That address points to a private or reserved network");
  return { url, ...addresses[0]! };
}

/**
 * GET a user-supplied URL safely: SSRF/DNS-rebinding protection, manual
 * redirect re-validation, time and size limits. The TCP connection is pinned
 * to the vetted IP, so a second DNS answer can't redirect it.
 */
export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
  const maxRedirects = opts.maxRedirects ?? 5;
  const contentTypes = opts.contentTypes ?? ["text/html", "application/xhtml+xml", "text/plain"];
  const resolver = opts.resolver ?? defaultResolver;
  const deadline = Date.now() + timeoutMs;
  const redirects: string[] = [];

  let current = rawUrl;
  for (let hop = 0; ; hop++) {
    const { url, address, family } = await vet(current, resolver, opts.unsafeTestOverrides);
    const agent = new Agent({
      connect: {
        timeout: Math.max(1, deadline - Date.now()),
        // Pin: whatever hostname undici asks for, connect only to the vetted IP.
        lookup: (_hostname, options, cb) => {
          if ((options as { all?: boolean }).all) (cb as (e: null, a: { address: string; family: number }[]) => void)(null, [{ address, family }]);
          else (cb as (e: null, a: string, f: number) => void)(null, address, family);
        }
      }
    });
    try {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new SafeFetchError("timeout", "The site took too long to respond");
      const res = await request(url, {
        method: "GET",
        dispatcher: agent,
        headersTimeout: remaining,
        bodyTimeout: remaining,
        signal: AbortSignal.timeout(remaining),
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
          ...opts.headers
        }
      });

      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        await res.body.dump();
        const location = res.headers.location;
        const next = Array.isArray(location) ? location[0] : location;
        if (!next) throw new SafeFetchError("network", "Redirect without a location");
        if (hop >= maxRedirects) throw new SafeFetchError("too_many_redirects", "Too many redirects");
        current = new URL(next, url).toString();
        redirects.push(current);
        continue;
      }

      const ct = String(res.headers["content-type"] ?? "").toLowerCase();
      const okType = res.statusCode >= 400 || contentTypes.some((t) => ct.startsWith(t));
      if (!okType) {
        await res.body.dump();
        throw new SafeFetchError("bad_content_type", `Unexpected content type: ${ct || "none"}`);
      }
      const declared = Number(res.headers["content-length"] ?? NaN);
      if (Number.isFinite(declared) && declared > maxBytes) {
        await res.body.dump();
        throw new SafeFetchError("too_large", "The page is too large");
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of res.body) {
        size += (chunk as Buffer).length;
        if (size > maxBytes) {
          res.body.destroy();
          throw new SafeFetchError("too_large", "The page is too large");
        }
        chunks.push(chunk as Buffer);
      }
      return { url: url.toString(), status: res.statusCode, contentType: ct, body: Buffer.concat(chunks).toString("utf8"), redirects };
    } catch (e) {
      if (e instanceof SafeFetchError) throw e;
      const name = (e as Error).name;
      if (name === "AbortError" || name === "TimeoutError" || /Timeout/i.test((e as { code?: string }).code ?? ""))
        throw new SafeFetchError("timeout", "The site took too long to respond");
      throw new SafeFetchError("network", "Couldn't connect to the site");
    } finally {
      await agent.close().catch(() => undefined);
    }
  }
}
