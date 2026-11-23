/** URL and domain normalisation used for de-duplication across discovery sources. */

const TRACKING_PARAMS = /^(utm_[a-z]+|gclid|fbclid|mc_[a-z]+|ref|ref_src|igshid|_hs[a-z]+)$/i;

export function tryParseUrl(input: string): URL | null {
  try {
    const trimmed = input.trim();
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const u = new URL(withScheme);
    // Reject bare words ("nope" -> https://nope/): require a dotted host or an IP literal.
    if (!u.hostname.includes(".") && !u.hostname.startsWith("[")) return null;
    return u;
  } catch {
    return null;
  }
}

/** Canonical form: lowercase host, no www, no default port, no fragment, no tracking params, sorted query. */
export function normalizeUrl(input: string): string {
  const u = tryParseUrl(input);
  if (!u) throw new Error(`Invalid URL: ${input}`);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`Unsupported scheme: ${u.protocol}`);
  u.hash = "";
  u.username = "";
  u.password = "";
  u.hostname = u.hostname
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/\.$/, "");
  if ((u.protocol === "https:" && u.port === "443") || (u.protocol === "http:" && u.port === "80")) u.port = "";
  const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAMS.test(k)).sort(([a], [b]) => a.localeCompare(b));
  u.search = "";
  for (const [k, v] of params) u.searchParams.append(k, v);
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "") || "/";
  // treat http/https as the same opportunity
  return u.toString().replace(/^http:\/\//, "https://");
}

/** Domain used for de-duplication: hostname without "www." (port kept for non-default ports). */
export function domainOf(input: string): string {
  const u = tryParseUrl(input);
  if (!u) throw new Error(`Invalid URL: ${input}`);
  const host = u.hostname
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/\.$/, "");
  const defaultPort =
    (u.protocol === "https:" && (u.port === "" || u.port === "443")) || (u.protocol === "http:" && (u.port === "" || u.port === "80"));
  return defaultPort ? host : `${host}:${u.port}`;
}

export function sameSite(a: string, b: string): boolean {
  try {
    return domainOf(a) === domainOf(b);
  } catch {
    return false;
  }
}

const CC_TLD_COUNTRY: Record<string, string> = {
  in: "IN",
  uk: "GB",
  au: "AU",
  ca: "CA",
  de: "DE",
  fr: "FR",
  es: "ES",
  it: "IT",
  nl: "NL",
  ie: "IE",
  nz: "NZ",
  sg: "SG",
  ae: "AE",
  za: "ZA",
  us: "US",
  jp: "JP",
  br: "BR",
  mx: "MX",
  se: "SE",
  no: "NO",
  dk: "DK",
  fi: "FI",
  ch: "CH",
  at: "AT",
  be: "BE",
  pl: "PL",
  pt: "PT",
  my: "MY",
  ph: "PH",
  id: "ID",
  ng: "NG",
  ke: "KE",
  pk: "PK",
  bd: "BD",
  lk: "LK",
  np: "NP",
  sa: "SA",
  qa: "QA",
  hk: "HK",
  tw: "TW",
  kr: "KR",
  cn: "CN"
};

export function countryFromTld(domain: string): string | null {
  const tld = (domain.split(":")[0] ?? "").split(".").pop() ?? "";
  return CC_TLD_COUNTRY[tld] ?? null;
}
