/**
 * Website Qualification Engine — signal extraction (pure functions, unit tested).
 * Signals are derived only from what we can observe on the public pages we fetched.
 */
import type { PageInfo } from "../net/html";
import { countryFromTld } from "../net/url";
import { COUNTRIES, industryDef } from "../discovery/taxonomy";

export interface PageSignals {
  url: string;
  finalUrl: string;
  httpStatus: number;
  https: boolean;
  redirectedOffsite: boolean;
  title: string;
  description: string;
  lang: string | null;
  hreflangs: string[];
  wordCount: number;
  internalLinks: number;
  externalLinks: number;
  externalDomains: number;
  externalRatio: number;
  sponsoredOutbound: number;
  nofollowOutbound: number;
  hasContact: boolean;
  hasAbout: boolean;
  hasPrivacy: boolean;
  publicEmails: string[];
  organisationMarkup: boolean;
  noindex: boolean;
  industryMatches: string[];
  keywordMatches: string[];
  countryMatches: string[];
  tldCountry: string | null;
  risk: RiskFindings;
  submission: SubmissionSignals;
}

export interface SubmissionSignals {
  formFound: boolean;
  captcha: string | null;
  loginRequired: boolean;
  fileUpload: boolean;
  requiredFields: string[];
  method: "GET" | "POST" | null;
}

export interface RiskFindings {
  spamTerms: string[];
  linkSelling: string[];
  spamDirectory: string[];
  hacked: string[];
  phishing: string[];
  malware: string[];
  linkFarm: string[];
  blocklisted: boolean;
}

const SPAM_TERMS = [
  "casino",
  "online gambling",
  "sports betting",
  "poker online",
  "slot online",
  "judi",
  "viagra",
  "cialis",
  "levitra",
  "no prescription",
  "payday loan",
  "porn",
  "xxx",
  "escort",
  "adult dating",
  "replica watches",
  "cheap jerseys",
  "crypto doubler",
  "make money fast",
  "weight loss pills",
  "essay mill",
  "followers cheap",
  "buy followers"
];

const LINK_SELLING = [
  /buy (?:high[- ]?(?:da|dr|authority) )?backlinks/i,
  /sell(?:ing)? (?:back)?links/i,
  /do-?follow (?:links?|backlinks?) (?:for sale|available|starting)/i,
  /guest posts? (?:for sale|starting (?:at|from)|price|\$\s?\d+)/i,
  /link insertions?/i,
  /niche edits?/i,
  /\bPBN\b|private blog network/i,
  /\b(?:DA|DR)\s?[5-9]\d\s?\+/i,
  /backlinks? packages?/i,
  /paid (?:do-?follow )?links?/i
];

const SPAM_DIRECTORY = [
  /reciprocal link (?:required|back|is required)/i,
  /link exchange/i,
  /submit (?:your site )?to \d{2,} (?:web )?directories/i,
  /seo[- ]friendly (?:web )?directory/i,
  /\bpage ?rank\b|\bPR ?[0-9]\b/i,
  /free (?:web )?directory submission/i,
  /instant approval/i
];

const PHISHING = [
  /verify your (?:account|identity)/i,
  /your account (?:has been )?(?:suspended|locked|limited)/i,
  /confirm your (?:password|payment|billing)/i,
  /update your (?:payment|billing) (?:details|information)/i
];

const MALWARE = [
  /eval\s*\(\s*(?:atob|unescape)\s*\(/i,
  /document\.write\s*\(\s*unescape\s*\(/i,
  /coinhive|cryptonight|webminepool/i,
  /String\.fromCharCode\((?:\d+,\s*){40,}/
];

/** Small built-in blocklist; organisations extend it with backlink_exclusions. */
export const BLOCKLIST = new Set<string>(["example-linkfarm.test", "buy-backlinks.test"]);

function countTerms(text: string, terms: string[]): string[] {
  const t = ` ${text.toLowerCase()} `;
  return terms.filter((term) => {
    const re = new RegExp(`(^|[^a-z])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`, "i");
    return re.test(t);
  });
}

const NEGATION_RE = /\b(not|never|no|don'?t|doesn'?t|won'?t|nor|without|against|avoid)\b[^.!?]{0,20}$/i;

/** Pattern matches, ignoring negated statements such as "we do not sell links". */
export function matchAll(text: string, res: RegExp[]): string[] {
  const out: string[] = [];
  for (const re of res) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    for (const m of text.matchAll(g)) {
      const before = text.slice(Math.max(0, (m.index ?? 0) - 40), m.index ?? 0);
      if (NEGATION_RE.test(before)) continue;
      out.push(m[0].slice(0, 80));
      break;
    }
  }
  return out;
}

export function riskFindings(page: PageInfo, rawHtml: string, domain: string, ctxIndustry: string): RiskFindings {
  const text = `${page.title} ${page.description} ${page.text}`;
  const spamTerms = countTerms(text, SPAM_TERMS);
  const linkSelling = matchAll(text, LINK_SELLING);
  const spamDirectory = matchAll(text, SPAM_DIRECTORY);
  const phishing: string[] = [];
  const hasPassword = page.forms.some((f) => f.hasPassword);
  if (hasPassword) phishing.push(...matchAll(text, PHISHING));
  const malware = matchAll(rawHtml, MALWARE);
  const hacked: string[] = [];
  const hiddenBlocks =
    rawHtml.match(
      /<(div|span|p)[^>]+style=["'][^"']*(display\s*:\s*none|visibility\s*:\s*hidden|left\s*:\s*-\d{3,}px)[^"']*["'][^>]*>([\s\S]{0,4000}?)<\/\1>/gi
    ) ?? [];
  const hiddenLinks = hiddenBlocks.reduce((n, b) => n + (b.match(/<a\s/gi)?.length ?? 0), 0);
  if (hiddenLinks >= 5) hacked.push(`${hiddenLinks} links inside hidden elements`);
  const cjk = (page.text.match(/[぀-ヿ一-鿿]/g) ?? []).length;
  if ((page.lang ?? "en").startsWith("en") && page.text.length > 200 && cjk / page.text.length > 0.2 && spamTerms.length) {
    hacked.push("large amount of CJK spam text on an English site (keyword hack pattern)");
  }
  if (spamTerms.length && ctxIndustry !== "other" && /pharma|viagra|cialis/.test(spamTerms.join(" ")) && !/health/.test(ctxIndustry)) {
    if (page.title && countTerms(page.title, SPAM_TERMS).length) hacked.push("pharma spam in page title");
  }
  const linkFarm: string[] = [];
  const ext = page.links.filter((l) => !l.internal);
  const extDomains = new Set(ext.map((l) => safeHost(l.href)));
  if (ext.length > 200 && extDomains.size > 100 && ext.length / Math.max(1, page.links.length) > 0.7) {
    linkFarm.push(`${ext.length} outbound links to ${extDomains.size} domains on one page`);
  }
  return {
    spamTerms,
    linkSelling,
    spamDirectory,
    hacked,
    phishing,
    malware,
    linkFarm,
    blocklisted: BLOCKLIST.has(domain)
  };
}

function safeHost(u: string): string {
  try {
    return new URL(u).host.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function submissionSignals(page: PageInfo | null): SubmissionSignals {
  if (!page) return { formFound: false, captcha: null, loginRequired: false, fileUpload: false, requiredFields: [], method: null };
  const candidates = page.forms.filter((f) => f.fields.length >= 2 && !/search/i.test(f.action) && !f.fields.every((x) => x.type === "search"));
  const best = candidates.sort((a, b) => b.fields.length - a.fields.length)[0];
  const loginRequired =
    page.forms.some((f) => f.hasPassword) && !best?.fields.some((x) => /url|website|business|company/i.test(`${x.name} ${x.label}`));
  return {
    formFound: !!best && !loginRequired,
    captcha: best?.hasCaptcha ? (page.captcha?.kind ?? "generic") : (page.captcha?.kind ?? null),
    loginRequired,
    fileUpload: !!best?.hasFileUpload,
    requiredFields: best ? best.fields.filter((f) => f.required).map((f) => f.name) : [],
    method: best?.method ?? null
  };
}

export function pageSignals(input: {
  page: PageInfo;
  rawHtml: string;
  httpStatus: number;
  finalUrl: string;
  requestedUrl: string;
  domain: string;
  industry: string;
  keywords: string[];
  countries: string[];
  submissionPage?: PageInfo | null;
}): PageSignals {
  const { page } = input;
  const ext = page.links.filter((l) => !l.internal);
  const text = `${page.title} ${page.description} ${page.h1.join(" ")} ${page.text}`.toLowerCase();
  const ind = industryDef(input.industry);
  const countryMatches = input.countries.filter((c) => {
    const def = COUNTRIES[c];
    if (!def) return false;
    return (
      countTerms(text, def.terms).length > 0 || page.hreflangs.some((h) => def.lang.includes(h)) || (page.lang ? def.lang.includes(page.lang) : false)
    );
  });
  return {
    url: input.requestedUrl,
    finalUrl: input.finalUrl,
    httpStatus: input.httpStatus,
    https: input.finalUrl.startsWith("https://"),
    redirectedOffsite: safeHost(input.finalUrl) !== safeHost(input.requestedUrl),
    title: page.title,
    description: page.description,
    lang: page.lang,
    hreflangs: page.hreflangs,
    wordCount: page.wordCount,
    internalLinks: page.links.length - ext.length,
    externalLinks: ext.length,
    externalDomains: new Set(ext.map((l) => safeHost(l.href))).size,
    externalRatio: page.links.length ? ext.length / page.links.length : 0,
    sponsoredOutbound: ext.filter((l) => l.rel.includes("sponsored")).length,
    nofollowOutbound: ext.filter((l) => l.rel.includes("nofollow") || l.rel.includes("ugc")).length,
    hasContact: page.hasContactLink,
    hasAbout: page.hasAboutLink,
    hasPrivacy: page.hasPrivacyLink,
    publicEmails: page.emails,
    organisationMarkup: page.jsonLdTypes.some((t) => /organization|localbusiness|corporation/i.test(String(t))),
    noindex: page.noindex,
    industryMatches: countTerms(text, ind.terms),
    keywordMatches: countTerms(
      text,
      input.keywords.map((k) => k.toLowerCase())
    ),
    countryMatches,
    tldCountry: countryFromTld(input.domain),
    risk: riskFindings(page, input.rawHtml, input.domain, input.industry),
    submission: submissionSignals(input.submissionPage === undefined ? page : input.submissionPage)
  };
}
