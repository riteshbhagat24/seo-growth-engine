/**
 * URL policy for every outbound request the engine makes (crawler, verifier, adapters, browser egress proxy).
 *
 * Synchronous checks here (scheme, credentials, port, internal hostnames, IP literals); DNS resolution, the
 * all-answers-public rule, connection pinning, redirect re-validation and size/time caps are enforced by
 * @sge/crawler's safeFetch (and `vetUrl` for the browser proxy). Address ranges come from @sge/crawler's
 * ip-guard, so the engine and the site crawler share one definition of "public".
 */
import { isIP } from "node:net";
import { isPublicAddress, type SafeFetchOptions } from "@sge/crawler";

export type PolicyCode =
  | "scheme"
  | "credentials"
  | "port"
  | "hostname"
  | "private_address"
  | "dns_failure"
  | "robots"
  | "too_large"
  | "too_many_redirects"
  | "content_type"
  | "timeout"
  | "network";

export class PolicyBlockedError extends Error {
  constructor(
    readonly code: PolicyCode,
    message: string
  ) {
    super(message);
    this.name = "PolicyBlockedError";
  }
}

const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home.arpa", ".corp"];
const BLOCKED_HOSTS = new Set(["localhost", "metadata.google.internal", "metadata", "instance-data"]);

/** TESTS ONLY: exact `host:port` pairs (e.g. the local test destination) exempt from address/port checks. */
export interface TestNetOverrides {
  allowHostPorts?: string[];
  resolver?: SafeFetchOptions["resolver"];
}

export function hostKey(u: URL): string {
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  return `${u.hostname.replace(/^\[|\]$/g, "")}:${port}`.toLowerCase();
}

export class UrlPolicy {
  private readonly allowed: Set<string>;
  constructor(readonly test: TestNetOverrides = {}) {
    this.allowed = new Set((test.allowHostPorts ?? []).map((h) => h.toLowerCase()));
  }

  isAllowListed(u: URL): boolean {
    return this.allowed.has(hostKey(u));
  }

  /** Throws PolicyBlockedError for anything that must never be requested. Returns the parsed URL. */
  assertAllowed(raw: string | URL): URL {
    let u: URL;
    try {
      u = typeof raw === "string" ? new URL(raw) : raw;
    } catch {
      throw new PolicyBlockedError("hostname", "Invalid URL");
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new PolicyBlockedError("scheme", `Scheme ${u.protocol} is not allowed`);
    if (u.username || u.password) throw new PolicyBlockedError("credentials", "Credentials in URLs are not allowed");
    const allowListed = this.isAllowListed(u);
    const port = u.port || (u.protocol === "https:" ? "443" : "80");
    if (!allowListed && port !== "80" && port !== "443") throw new PolicyBlockedError("port", `Port ${port} is not allowed`);
    const host = u.hostname
      .replace(/^\[|\]$/g, "")
      .toLowerCase()
      .replace(/\.$/, "");
    if (!host) throw new PolicyBlockedError("hostname", "Empty hostname");
    if (!allowListed) {
      if (BLOCKED_HOSTS.has(host) || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s)))
        throw new PolicyBlockedError("hostname", `Host ${host} is not allowed`);
      // WHATWG URL parsing already normalises decimal/octal/hex IPv4 forms (2130706433, 0x7f.1, 0177.0.0.1).
      if (isIP(host) && !isPublicAddress(host)) throw new PolicyBlockedError("private_address", `Address ${host} is not a public address`);
      if (!host.includes(".") && !isIP(host)) throw new PolicyBlockedError("hostname", `Single-label host ${host} is not allowed`);
    }
    return u;
  }

  /** safeFetch options for a request to `u` (test overrides apply only to allow-listed host:port pairs). */
  fetchOverrides(u: URL): Pick<SafeFetchOptions, "resolver" | "unsafeTestOverrides"> {
    const out: Pick<SafeFetchOptions, "resolver" | "unsafeTestOverrides"> = {};
    if (this.test.resolver) out.resolver = this.test.resolver;
    if (this.isAllowListed(u)) {
      const host = u.hostname.replace(/^\[|\]$/g, "");
      out.unsafeTestOverrides = { allowAddress: (a) => a === host || a === `::ffff:${host}`, allowAnyPort: true };
    }
    return out;
  }
}

export { isPublicAddress };
