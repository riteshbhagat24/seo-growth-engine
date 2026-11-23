/** Pure engine logic: URL handling, SSRF primitives, signals, scoring, form filling, state machine, assets, discovery. */
import { describe, expect, test } from "vitest";
import { domainOf, normalizeUrl, countryFromTld } from "../src/net/url";
import { extractPage, detectCaptcha } from "../src/net/html";
import { isPublicAddress, PolicyBlockedError, UrlPolicy } from "../src/net/policy";
import { pageSignals, matchAll } from "../src/qualification/signals";
import { scoreOpportunity } from "../src/scoring/score";
import { planFill, semanticFor } from "../src/adapters/form-fill";
import { canTransition, TRANSITIONS } from "../src/submissions/state";
import { cleanSiteName, factCheck, renderAsset, similarity, type BusinessProfile } from "../src/assets/generator";
import { competitorCsvCandidates, csvCandidates, expansionCandidates, inferType, searchQueryTemplates } from "../src/discovery/discovery";
import { linkMatchesTarget, diagnose } from "../src/verification/verify";
import { autopilotDecision } from "../src/pipeline/common";
import { ADAPTERS, isAutomationSupported } from "../src/adapters/registry";
import { isRetryable, PermanentError, RetryableError } from "../src/errors";
import type { SourceInfo, SubmissionValues } from "../src/adapters/types";

const assertUrlAllowed = (u: string) => new UrlPolicy().assertAllowed(u);

const PROFILE: BusinessProfile = {
  id: "p",
  website_id: "w",
  business_name: "Brightlane Analytics",
  website_url: "https://brightlane.example/",
  industry: "technology",
  description: "Brightlane Analytics builds analytics dashboards for small online businesses. It helps teams understand website performance.",
  products_services: ["Analytics dashboards", "Conversion reporting"],
  target_countries: ["IN"],
  contact_email: "hello@brightlane.example",
  contact_phone: null,
  address: null,
  social_profiles: {},
  logo_url: null,
  brand_descriptions: [],
  target_landing_pages: [],
  target_keywords: ["website analytics"],
  approved_anchor_texts: ["Brightlane Analytics"],
  founder: null,
  founded_year: 2019,
  verified_facts: ["Winner of the 2024 Example Startup Award"],
  status: "approved",
  version: 1
};

function page(body: string, url = "https://dir.example/") {
  return extractPage(`<html lang="en"><head><title>Dir</title><meta name="description" content="d"></head><body>${body}</body></html>`, url);
}

describe("URL normalisation & dedupe", () => {
  test("normalises equivalent URLs to one key", () => {
    const a = normalizeUrl("HTTP://www.Example.com:80/path/?utm_source=x&b=2&a=1#frag");
    const b = normalizeUrl("https://example.com/path?a=1&b=2");
    expect(a).toBe(b);
    expect(domainOf("https://www.example.com/x")).toBe("example.com");
    expect(domainOf("http://127.0.0.1:4010/x")).toBe("127.0.0.1:4010");
    expect(countryFromTld("shop.co.in")).toBe("IN");
  });
});

describe("SSRF primitives", () => {
  test("only public unicast addresses are allowed", () => {
    for (const ip of [
      "127.0.0.1",
      "10.0.0.1",
      "172.20.1.1",
      "192.168.0.1",
      "169.254.169.254",
      "100.64.0.1",
      "::1",
      "fd00::1",
      "::ffff:10.0.0.1",
      "0.0.0.0",
      "224.0.0.1"
    ])
      expect(isPublicAddress(ip), ip).toBe(false);
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) expect(isPublicAddress(ip), ip).toBe(true);
    expect(() => assertUrlAllowed("http://0177.0.0.1/")).toThrow(PolicyBlockedError);
  });
});

describe("Qualification signals & scoring", () => {
  const base = {
    rawHtml: "",
    httpStatus: 200,
    finalUrl: "https://dir.example/",
    requestedUrl: "https://dir.example/",
    domain: "dir.example",
    industry: "technology",
    keywords: ["saas analytics"],
    countries: ["IN"]
  };

  test("a credible relevant directory qualifies with a reason for every factor", () => {
    const p =
      page(`<nav>${Array.from({ length: 12 }, (_, i) => `<a href="/c/${i}">c${i}</a>`).join("")}<a href="/about">About</a><a href="/contact">Contact</a><a href="/privacy">Privacy</a></nav>
      <p>${"A directory of software and SaaS analytics companies in India. ".repeat(30)}</p><a href="/submit">Add your startup</a>
      <form method="post" action="/submit"><input name="business_name" required><input name="website_url" type="url" required><textarea name="description"></textarea></form>`);
    const s = pageSignals({ ...base, page: p, rawHtml: "" });
    const r = scoreOpportunity({
      home: s,
      opportunityType: "startup_directory",
      targetCountries: ["IN"],
      keywords: ["saas analytics"],
      curatedVerified: false,
      sourceAutomation: "tos_permits_form"
    });
    expect(r.hardRejects).toEqual([]);
    expect(r.score).toBeGreaterThanOrEqual(55);
    expect(r.breakdown.every((f) => f.reason.length > 0)).toBe(true);
    expect(r.breakdown.find((f) => f.factor === "organic_visibility")!.reason).toMatch(/Not verifiable/);
    expect(JSON.stringify(r.breakdown)).not.toMatch(/domain authority|domain rating/i);
  });

  test("link sellers, link farms, hacked and spam sites are rejected automatically", () => {
    const seller = pageSignals({ ...base, page: page("<p>Buy high DA backlinks! Guest posts starting at $50. DA 70+ PBN network.</p>") });
    expect(
      scoreOpportunity({
        home: seller,
        opportunityType: "guest_post",
        targetCountries: [],
        keywords: [],
        curatedVerified: false,
        sourceAutomation: null
      }).hardRejects.join(" ")
    ).toMatch(/Sells links/);
    const farm = pageSignals({
      ...base,
      page: page(Array.from({ length: 260 }, (_, i) => `<a href="https://site${i}.example/">s${i}</a>`).join(""))
    });
    expect(
      scoreOpportunity({
        home: farm,
        opportunityType: "other",
        targetCountries: [],
        keywords: [],
        curatedVerified: false,
        sourceAutomation: null
      }).hardRejects.join(" ")
    ).toMatch(/Link farm/);
    const hackedHtml = `<div style="display:none">${Array.from({ length: 8 }, (_, i) => `<a href="https://pills${i}.example">cheap</a>`).join("")}</div>`;
    const hacked = pageSignals({ ...base, page: page(hackedHtml), rawHtml: hackedHtml });
    expect(
      scoreOpportunity({
        home: hacked,
        opportunityType: "other",
        targetCountries: [],
        keywords: [],
        curatedVerified: false,
        sourceAutomation: null
      }).hardRejects.join(" ")
    ).toMatch(/Hacked/);
    const spam = pageSignals({ ...base, page: page("<p>casino online gambling viagra payday loan</p>") });
    expect(
      scoreOpportunity({ home: spam, opportunityType: "other", targetCountries: [], keywords: [], curatedVerified: false, sourceAutomation: null })
        .score
    ).toBe(0);
  });

  test("negated statements are not treated as link selling", () => {
    expect(matchAll("We do not sell links and never accept paid links.", [/sell(?:ing)? (?:back)?links/i, /paid (?:do-?follow )?links?/i])).toEqual(
      []
    );
    expect(matchAll("We sell links.", [/sell(?:ing)? (?:back)?links/i])).toEqual(["sell links"]);
  });

  test("CAPTCHA and login walls are detected", () => {
    expect(detectCaptcha('<div class="g-recaptcha" data-sitekey="x">')?.kind).toBe("recaptcha");
    expect(detectCaptcha('<script src="https://challenges.cloudflare.com/turnstile/v0/api.js">')?.kind).toBe("turnstile");
    const s = pageSignals({ ...base, page: page('<form><input name="user"><input type="password" name="pw"></form>') });
    expect(s.submission.loginRequired).toBe(true);
  });
});

describe("Form filling never invents data", () => {
  const values: SubmissionValues = {
    business_name: "Brightlane Analytics",
    website_url: "https://brightlane.example/",
    target_url: "https://brightlane.example/analytics",
    anchor_text: "Brightlane",
    email: "hello@brightlane.example",
    phone: null,
    contact_name: null,
    short_description: "short",
    long_description: "long",
    category: "Technology / SaaS",
    country: "India",
    city: null,
    address: null,
    keywords: "a",
    logo_url: null,
    title: null,
    body: null
  };
  const source = (accepted: boolean): SourceInfo => ({
    id: "s",
    organization_id: null,
    domain: "d",
    name: "D",
    homepage_url: "https://d/",
    submission_url: null,
    automation_permission: "tos_permits_form",
    permission_evidence: accepted ? { terms_accepted_by: "u", terms_accepted_at: "now" } : {},
    form_mapping: {},
    api_config: {}
  });
  const form = page(`<form method="post"><label for="n">Company name</label><input id="n" name="company" required>
    <input name="site" type="url" required><input name="mail" type="email"><label for="ph">Phone</label><input id="ph" name="phone" required>
    <input type="checkbox" name="newsletter"><label><input type="checkbox" name="tos" required> I accept the terms</label></form>`).forms[0]!;

  test("maps fields, points website fields at the target page, leaves opt-ins unticked", () => {
    const plan = planFill(form, values, source(true));
    expect(plan.values).toMatchObject({
      company: "Brightlane Analytics",
      site: "https://brightlane.example/analytics",
      mail: "hello@brightlane.example"
    });
    expect(plan.checkboxes).toEqual(["tos"]);
    expect(plan.skipped.find((s) => s.field === "newsletter")).toBeTruthy();
    expect(plan.unmappedRequired.map((u) => u.field)).toEqual(["phone"]); // no phone in profile -> human, never invented
  });

  test("file uploads are never automated (the worker never reads local files for tenant data)", () => {
    const f = page(`<form method="post"><input name="company" required><input name="site" type="url" required>
      <input type="file" name="logo"><input type="file" name="proof" required></form>`).forms[0]!;
    const plan = planFill(f, values, source(true));
    expect(plan.skipped.find((s) => s.field === "logo")?.reason).toMatch(/never automated/);
    expect(plan.unmappedRequired.map((u) => u.field)).toEqual(["proof"]);
    expect(plan).not.toHaveProperty("files");
  });

  test("terms are only accepted when a person recorded acceptance", () => {
    expect(planFill(form, values, source(false)).unmappedRequired.map((u) => u.field)).toContain("tos");
    expect(
      semanticFor({
        name: "captcha_answer",
        type: "text",
        id: null,
        label: "What is 3+4?",
        placeholder: "",
        required: true,
        options: [],
        accept: null
      })
    ).toBeNull();
  });
});

describe("Submission state machine", () => {
  test("VERIFIED is only reachable after publication evidence; terminal states are terminal", () => {
    const into = (s: string) =>
      Object.entries(TRANSITIONS)
        .filter(([, to]) => (to as string[]).includes(s))
        .map(([from]) => from)
        .sort();
    expect(into("VERIFIED")).toEqual(["LOST", "PENDING_VERIFICATION", "PUBLISHED"]);
    expect(canTransition("SUBMITTED", "VERIFIED")).toBe(false); // must be crawled first
    expect(canTransition("AWAITING_APPROVAL", "SUBMITTING")).toBe(false); // no execution without approval
    expect(TRANSITIONS.REJECTED).toEqual([]);
    expect(TRANSITIONS.CANCELLED).toEqual([]);
  });
});

describe("Asset generation", () => {
  const dest = { name: "Dir", domain: "dir.example", type: "industry_directory" };
  test("short description fits 160 chars; copy only uses approved facts", () => {
    const s = renderAsset("short_description", PROFILE, dest, 3)!;
    expect(s.body.length).toBeLessThanOrEqual(160);
    for (const t of [
      "long_description",
      "company_profile",
      "directory_listing",
      "guest_post_pitch",
      "resource_request",
      "partnership_pitch"
    ] as const) {
      const a = renderAsset(t, PROFILE, dest, 7)!;
      expect(factCheck(`${a.title ?? ""}\n${a.body}`, PROFILE, [dest.name, dest.domain]).passed, t).toBe(true);
    }
  });
  test("verified facts may be claimed; anything else is flagged", () => {
    expect(factCheck("Winner of the 2024 Example Startup Award", PROFILE).passed).toBe(true);
    const r = factCheck("Rated #1 by 10,000 customers, call +44 20 7946 0000, 99% uptime", PROFILE);
    expect(r.passed).toBe(false);
    expect(
      r.claims
        .filter((c) => !c.supported)
        .map((c) => c.kind)
        .sort()
    ).toEqual(expect.arrayContaining(["phone", "statistic", "superlative"]));
  });
  test("destination names are cleaned from page titles", () => {
    expect(cleanSiteName("GitHub · Change is constant. GitHub keeps you ahead. · GitHub", "github.com")).toBe("GitHub");
    expect(cleanSiteName("SaaSHub - Software Alternatives and Reviews", "saashub.com")).toBe("SaaSHub");
    expect(cleanSiteName("A very long marketing headline without any separators at all here", "x.example")).toBe("x.example");
    expect(cleanSiteName(null, "x.example")).toBe("x.example");
  });
  test("variation produces distinct copy per destination", () => {
    const a = renderAsset("long_description", PROFILE, dest, 1)!.body;
    const b = renderAsset("long_description", PROFILE, dest, 2)!.body;
    expect(similarity(a, a)).toBe(1);
    expect(a === b ? 1 : 0).toBe(0);
  });
});

describe("Discovery inputs", () => {
  test("generic and competitor CSV imports", () => {
    const g = csvCandidates("URL,Type\nhttps://a.example/resources,resource page\nnope,x\n");
    expect(g.candidates).toHaveLength(1);
    expect(g.errors).toHaveLength(1);
    const ahrefs =
      '"Referring page URL"\t"Anchor"\t"Domain rating"\n"https://b.example/links"\t"Rival"\t"80"\n"https://b.example/links2"\t"R"\t"80"\n"https://b.example/links3"\t"R"\t"80"\n';
    const c = competitorCsvCandidates(ahrefs, "rival.example");
    expect(c.format).toBe("ahrefs");
    expect(c.candidates).toHaveLength(2); // max two pages per referring domain
    expect(c.candidates[0]!.evidence).not.toHaveProperty("domain_rating");
  });
  test("site expansion finds submission / contribution pages", () => {
    const p = page('<a href="/write-for-us">Write for us</a><a href="/submit-site">Submit your site</a><a href="https://other.example/submit">x</a>');
    const types = expansionCandidates(p)
      .map((c) => c.type)
      .sort();
    expect(types).toEqual(["guest_post", "industry_directory"]);
    expect(inferType("https://x.example/resources/")).toBe("resource_page");
    expect(inferType("https://x.example/resources")).toBe("resource_page"); // regression: no trailing slash
    expect(inferType("https://x.example/page", "Contribute an article")).toBe("guest_post");
  });
  test("query templates are for manual research only (no search URLs)", () => {
    const t = searchQueryTemplates({ industry: "healthcare", target_countries: ["IN"], target_keywords: ["dental clinic"] });
    expect(t.length).toBeGreaterThan(3);
    expect(t.some((x) => /google\.|bing\.|https?:/.test(x.query))).toBe(false);
  });
});

describe("Verification matching", () => {
  test("direct, redirect-wrapped and non-matching links", () => {
    expect(linkMatchesTarget("https://www.brightlane.example/analytics?ref=dir", "https://brightlane.example/analytics")).toBe("direct");
    expect(linkMatchesTarget("https://dir.example/out?url=https%3A%2F%2Fbrightlane.example%2F", "https://brightlane.example/")).toBe("redirect");
    expect(linkMatchesTarget("https://brightlane.example/pricing", "https://brightlane.example/analytics")).toBeNull();
    expect(diagnose({ result: "page_unavailable" } as any)).toBe("page_gone");
  });
});

describe("Autopilot policy", () => {
  const src: SourceInfo = {
    id: "src",
    organization_id: null,
    domain: "d",
    name: "D",
    homepage_url: "",
    submission_url: null,
    automation_permission: "explicit_permission",
    permission_evidence: {},
    form_mapping: {},
    api_config: {}
  };
  test("requires mode, opt-in per source, explicit permission, autopilot-capable adapter and clean content", () => {
    const ok = autopilotDecision({
      mode: "autopilot",
      approvalRequired: false,
      adapter: ADAPTERS["listing-api-v1"]!,
      source: src,
      websiteAutopilotSources: ["src"],
      factCheckPassed: true
    });
    expect(ok.eligible).toBe(true);
    const bad = autopilotDecision({
      mode: "autopilot",
      approvalRequired: false,
      adapter: ADAPTERS["http-form"]!,
      source: { ...src, automation_permission: "tos_permits_form" },
      websiteAutopilotSources: [],
      factCheckPassed: false
    });
    expect(bad.eligible).toBe(false);
    expect(bad.reasons.length).toBe(3);
    expect(
      autopilotDecision({
        mode: "autopilot",
        approvalRequired: false,
        adapter: ADAPTERS["wordpress-draft"]!,
        source: src,
        websiteAutopilotSources: ["src"],
        factCheckPassed: true
      }).eligible
    ).toBe(false);
  });
  test("manual adapters are never reported as automation-supported", () => {
    expect(isAutomationSupported("manual-editorial")).toBe(false);
    expect(isAutomationSupported("listing-api-v1")).toBe(true);
    expect(isAutomationSupported("does-not-exist")).toBe(false);
  });
});

describe("Error classification", () => {
  test("retryable vs permanent", () => {
    expect(isRetryable(new RetryableError("x"))).toBe(true);
    expect(isRetryable(new PermanentError("x"))).toBe(false);
    expect(isRetryable(Object.assign(new Error("reset"), { code: "ECONNRESET" }))).toBe(true);
    expect(isRetryable(new PolicyBlockedError("private_address", "x"))).toBe(false);
    expect(isRetryable(new PolicyBlockedError("timeout", "x"))).toBe(true);
  });
});
