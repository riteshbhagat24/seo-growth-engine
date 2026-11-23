/**
 * The engine's only HTTP client. Wraps @sge/crawler's safeFetch (SSRF checks, DNS pinning, redirect
 * re-validation, size/time caps) with what a polite crawler of third-party sites also needs: robots.txt
 * (cached per origin, RFC 9309 via @sge/crawler parseRobots), per-host spacing (or Crawl-delay) and a global
 * concurrency cap.
 */
import { parseRobots, safeFetch, SafeFetchError, type RobotsRules, type SafeFetchErrorCode } from "@sge/crawler";
import { HostRateLimiter, Semaphore } from "./limiter";
import { PolicyBlockedError, UrlPolicy, type PolicyCode, type TestNetOverrides } from "./policy";

export interface FetchOptions {
  method?: "GET" | "HEAD" | "POST";
  headers?: Record<string, string>;
  body?: string | Buffer;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  followRedirects?: boolean;
  /** Respect robots.txt (default true). Posting to a permitted form/API endpoint isn't crawling. */
  respectRobots?: boolean;
  /** Allowed content types (prefix match). */
  acceptTypes?: string[];
  /** Skip the per-host politeness delay (robots.txt fetches only). */
  skipRateLimit?: boolean;
}

export interface SafeResponse {
  url: string;
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  redirects: { url: string; status: number }[];
  elapsedMs: number;
}

export interface FetcherOptions {
  /** Minimum spacing between requests to one host (robots.txt Crawl-delay wins when longer). */
  hostIntervalMs?: number;
  concurrency?: number;
  timeoutMs?: number;
  maxBytes?: number;
  /** TESTS ONLY. */
  test?: TestNetOverrides;
}

const DEFAULT_TYPES = [
  "text/html",
  "application/xhtml",
  "text/xml",
  "application/xml",
  "text/plain",
  "application/json",
  "application/ld+json",
  "application/rss",
  "application/atom"
];
const ROBOTS_TTL_MS = 6 * 60 * 60 * 1000;

const CODE_MAP: Record<SafeFetchErrorCode, PolicyCode> = {
  invalid_url: "hostname",
  blocked_scheme: "scheme",
  blocked_port: "port",
  blocked_address: "private_address",
  dns_failed: "dns_failure",
  too_many_redirects: "too_many_redirects",
  too_large: "too_large",
  bad_content_type: "content_type",
  timeout: "timeout",
  network: "network"
};

export class Fetcher {
  readonly policy: UrlPolicy;
  private readonly limiter: HostRateLimiter;
  private readonly sem: Semaphore;
  private readonly robots = new Map<string, { rules: RobotsRules; at: number }>();
  /** Requests attempted, robots.txt included (for usage metering and tests). */
  requests = 0;

  constructor(private readonly o: FetcherOptions = {}) {
    this.policy = new UrlPolicy(o.test);
    this.limiter = new HostRateLimiter(o.hostIntervalMs ?? 2000);
    this.sem = new Semaphore(o.concurrency ?? 4);
  }

  clearRobotsCache(): void {
    this.robots.clear();
  }

  private async raw(url: URL, opts: FetchOptions): Promise<SafeResponse> {
    const started = Date.now();
    this.requests++;
    try {
      const r = await safeFetch(url.toString(), {
        method: opts.method,
        body: opts.body,
        headers: opts.headers,
        timeoutMs: opts.timeoutMs ?? this.o.timeoutMs ?? 15_000,
        maxBytes: opts.maxBytes ?? this.o.maxBytes ?? 2 * 1024 * 1024,
        maxRedirects: opts.maxRedirects ?? 5,
        followRedirects: opts.followRedirects,
        contentTypes: opts.acceptTypes ?? DEFAULT_TYPES,
        ...this.policy.fetchOverrides(url)
      });
      return {
        url: r.url,
        status: r.status,
        headers: r.responseHeaders ?? {},
        text: r.body,
        redirects: r.redirects.map((u, i) => ({ url: u, status: r.redirectStatuses?.[i] ?? 0 })),
        elapsedMs: Date.now() - started
      };
    } catch (e) {
      if (e instanceof SafeFetchError) throw new PolicyBlockedError(CODE_MAP[e.code], e.message);
      throw e;
    }
  }

  private async robotsFor(u: URL): Promise<RobotsRules> {
    const origin = u.origin;
    const hit = this.robots.get(origin);
    if (hit && Date.now() - hit.at < ROBOTS_TTL_MS) return hit.rules;
    const robotsUrl = `${origin}/robots.txt`;
    let rules: RobotsRules;
    try {
      const r = await this.raw(new URL(robotsUrl), { maxBytes: 512 * 1024, timeoutMs: 10_000, acceptTypes: ["text/", "application/octet-stream"] });
      rules = parseRobots(robotsUrl, r.status, r.text);
    } catch (e) {
      // Policy blocks and unresolvable hosts are the request's own failure: report them as such (not as robots).
      if (e instanceof PolicyBlockedError && ["dns_failure", "private_address", "port", "scheme", "hostname", "credentials"].includes(e.code))
        throw e;
      // A robots.txt served as HTML/JSON is not a robots file: treat as missing (allow). Unreachable, timeout or
      // too large means we stay out, per RFC 9309 — remembered briefly, so a flaky host is retried soon.
      const allow = e instanceof PolicyBlockedError && e.code === "content_type";
      rules = parseRobots(robotsUrl, allow ? 404 : 0, "");
      this.robots.set(origin, { rules, at: Date.now() - ROBOTS_TTL_MS + (allow ? ROBOTS_TTL_MS : 10 * 60_000) });
      return rules;
    }
    this.robots.set(origin, { rules, at: Date.now() });
    return rules;
  }

  /** robots.txt verdict for a URL (cached). */
  async robotsCheck(url: string): Promise<{ allowed: boolean; crawlDelayMs: number | null }> {
    const u = this.policy.assertAllowed(url);
    if (u.pathname === "/robots.txt") return { allowed: true, crawlDelayMs: null };
    const rules = await this.robotsFor(u);
    return { allowed: rules.isAllowed(u.toString()), crawlDelayMs: rules.crawlDelayMs };
  }

  async fetch(rawUrl: string, opts: FetchOptions = {}): Promise<SafeResponse> {
    const u = this.policy.assertAllowed(rawUrl);
    if (opts.respectRobots !== false) {
      const r = await this.robotsCheck(u.toString());
      if (!r.allowed) throw new PolicyBlockedError("robots", `Disallowed by robots.txt: ${u.toString()}`);
      if (!opts.skipRateLimit) await this.limiter.wait(u.host, Math.max(r.crawlDelayMs ?? 0, this.o.hostIntervalMs ?? 2000));
    } else if (!opts.skipRateLimit) {
      await this.limiter.wait(u.host);
    }
    const release = await this.sem.acquire();
    try {
      return await this.raw(u, opts);
    } finally {
      release();
    }
  }
}
