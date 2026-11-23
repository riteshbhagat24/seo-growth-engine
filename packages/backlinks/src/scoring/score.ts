/**
 * Opportunity Scoring Engine. Produces a 0-100 score with a reason for every factor.
 *
 * Deliberately NOT used: third-party "Domain Authority"/"Domain Rating" style metrics. They are vendor
 * estimates, not Google ranking factors. Organic visibility only scores when verifiable data has been
 * supplied (e.g. imported from the user's own analytics/Search Console); otherwise it scores 0 and says so.
 */
import type { PageSignals } from "../qualification/signals";
import type { OpportunityType } from "../discovery/discovery";

export interface ScoreFactor {
  factor: string;
  points: number;
  max: number;
  reason: string;
}

export interface ScoreResult {
  score: number;
  breakdown: ScoreFactor[];
  hardRejects: string[];
}

export interface ScoreInput {
  home: PageSignals;
  opportunityType: OpportunityType;
  targetCountries: string[];
  keywords: string[];
  curatedVerified: boolean;
  sourceAutomation: string | null;
  /** Verified organic visibility from user-supplied data (0-1). null = not verifiable. */
  verifiedVisibility?: number | null;
  opportunityPageNoindex?: boolean;
  robotsAllowsOpportunityPage?: boolean;
}

const PLACEMENT: Record<OpportunityType, [number, string]> = {
  guest_post: [5, "Editorial in-content link (guest article) — strongest placement, requires editorial review"],
  resource_page: [4, "Curated resource page link — editorial placement"],
  partner: [4, "Partner/association page — relationship-based editorial link"],
  association: [4, "Association member listing — credible, relationship-based"],
  industry_directory: [3, "Industry directory profile link"],
  agency_directory: [3, "Agency directory profile link"],
  startup_directory: [3, "Startup directory profile link"],
  business_listing: [3, "Business listing / citation — valuable for local relevance, often nofollow"],
  review_platform: [2, "Review platform profile — trust and referral value, link usually nofollow"],
  other: [1, "Placement type unclear"]
};

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export function scoreOpportunity(input: ScoreInput): ScoreResult {
  const s = input.home;
  const breakdown: ScoreFactor[] = [];
  const hardRejects: string[] = [];
  const r = s.risk;

  // ---- Automatic rejections -------------------------------------------------------------
  if (r.blocklisted) hardRejects.push("Domain is on the platform blocklist");
  if (r.malware.length) hardRejects.push(`Malware indicators: ${r.malware.join("; ")}`);
  if (r.phishing.length) hardRejects.push(`Phishing indicators: ${r.phishing.join("; ")}`);
  if (r.hacked.length) hardRejects.push(`Hacked-site indicators: ${r.hacked.join("; ")}`);
  if (r.linkSelling.length) hardRejects.push(`Sells links / deceptive link schemes: ${r.linkSelling.join("; ")}`);
  if (r.linkFarm.length) hardRejects.push(`Link farm pattern: ${r.linkFarm.join("; ")}`);
  if (r.spamDirectory.length >= 2) hardRejects.push(`Spam directory practices: ${r.spamDirectory.join("; ")}`);
  if (r.spamTerms.length >= 3) hardRejects.push(`Spam content (${r.spamTerms.join(", ")})`);
  if ([401, 403, 429].includes(s.httpStatus)) {
    hardRejects.push(
      `Not evaluable: the site refused automated access (HTTP ${s.httpStatus}). This is not a quality judgement — review manually if relevant.`
    );
  } else if (s.httpStatus >= 400) hardRejects.push(`Site returned HTTP ${s.httpStatus}`);

  // ---- Industry relevance (20) ------------------------------------------------------------
  {
    const general = ["business_listing", "review_platform"].includes(input.opportunityType);
    const ind = s.industryMatches.length;
    const kw = s.keywordMatches.length;
    let pts = Math.min(12, ind * 3) + Math.min(8, kw * 4);
    let reason = `${ind} industry term(s) [${s.industryMatches.slice(0, 5).join(", ")}] and ${kw} campaign keyword(s) [${s.keywordMatches.slice(0, 4).join(", ")}] found on the site`;
    if (general && pts < 10) {
      pts = 10;
      reason += "; general business listing — relevant to any legitimate business (citation value)";
    }
    breakdown.push({ factor: "industry_relevance", points: clamp(pts, 0, 20), max: 20, reason });
  }

  // ---- Geographic relevance (10) ----------------------------------------------------------
  {
    let pts = 0;
    const reasons: string[] = [];
    if (!input.targetCountries.length) {
      pts = 6;
      reasons.push("campaign has no country restriction");
    } else {
      if (s.countryMatches.length) {
        pts += 6;
        reasons.push(`mentions/targets ${s.countryMatches.join(", ")}`);
      }
      if (s.tldCountry && input.targetCountries.includes(s.tldCountry)) {
        pts += 4;
        reasons.push(`country-code domain (.${s.tldCountry.toLowerCase()})`);
      }
      if (!pts) {
        pts = 3;
        reasons.push("no country signal found — treated as international");
      }
    }
    breakdown.push({ factor: "geographic_relevance", points: clamp(pts, 0, 10), max: 10, reason: reasons.join("; ") });
  }

  // ---- Editorial quality (15) -------------------------------------------------------------
  {
    let pts = 0;
    const reasons: string[] = [];
    if (s.title) ((pts += 2), reasons.push("has a title"));
    if (s.description) ((pts += 2), reasons.push("has a meta description"));
    if (s.wordCount >= 300) ((pts += 5), reasons.push(`${s.wordCount} words of visible content`));
    else if (s.wordCount >= 100) ((pts += 2), reasons.push(`thin content (${s.wordCount} words)`));
    else reasons.push(`very thin content (${s.wordCount} words)`);
    if (s.hasAbout) ((pts += 3), reasons.push("about page"));
    if (s.internalLinks >= 10) ((pts += 3), reasons.push("navigable site structure"));
    breakdown.push({ factor: "editorial_quality", points: clamp(pts, 0, 15), max: 15, reason: reasons.join("; ") });
  }

  // ---- Credibility (10) -------------------------------------------------------------------
  {
    let pts = 0;
    const reasons: string[] = [];
    if (s.https) ((pts += 3), reasons.push("HTTPS"));
    else reasons.push("no HTTPS");
    if (s.hasContact || s.publicEmails.length) ((pts += 2), reasons.push("public contact details"));
    if (s.hasPrivacy) ((pts += 2), reasons.push("privacy policy"));
    if (s.organisationMarkup) ((pts += 1), reasons.push("organisation structured data"));
    if (input.curatedVerified) ((pts += 2), reasons.push("curated source verified by platform"));
    if (s.redirectedOffsite) ((pts -= 3), reasons.push("homepage redirects to another domain"));
    breakdown.push({ factor: "credibility", points: clamp(pts, 0, 10), max: 10, reason: reasons.join("; ") });
  }

  // ---- Organic visibility (5) — only when verifiable --------------------------------------
  if (input.verifiedVisibility == null) {
    breakdown.push({
      factor: "organic_visibility",
      points: 0,
      max: 5,
      reason: "Not verifiable without paid data; import Search Console/analytics data to score this factor (DA/DR not used)"
    });
  } else {
    breakdown.push({
      factor: "organic_visibility",
      points: clamp(Math.round(input.verifiedVisibility * 5), 0, 5),
      max: 5,
      reason: "From user-supplied verified visibility data"
    });
  }

  // ---- Referral traffic potential (10) ----------------------------------------------------
  {
    const rel = breakdown.find((b) => b.factor === "industry_relevance")!.points;
    const typeBonus = [
      "business_listing",
      "review_platform",
      "industry_directory",
      "agency_directory",
      "startup_directory",
      "resource_page"
    ].includes(input.opportunityType)
      ? 3
      : 2;
    const pts = clamp(Math.round(rel / 3) + typeBonus, 0, 10);
    breakdown.push({
      factor: "referral_potential",
      points: pts,
      max: 10,
      reason: `Estimated from topical relevance (${rel}/20) and placement type; no traffic data is fabricated`
    });
  }

  // ---- Outbound link quality (10) ---------------------------------------------------------
  {
    let pts = 10;
    const reasons: string[] = [`${s.externalLinks} outbound links to ${s.externalDomains} domains`];
    if (s.externalRatio > 0.6 && s.externalLinks > 50) ((pts -= 5), reasons.push("outbound-heavy page"));
    if (s.externalDomains > 80) ((pts -= 3), reasons.push("links to very many domains"));
    if (s.sponsoredOutbound > 0) reasons.push(`${s.sponsoredOutbound} properly labelled sponsored links`);
    if (r.spamTerms.length) ((pts -= 2 * r.spamTerms.length), reasons.push(`spam terms present: ${r.spamTerms.join(", ")}`));
    breakdown.push({ factor: "outbound_link_quality", points: clamp(pts, 0, 10), max: 10, reason: reasons.join("; ") });
  }

  // ---- Submission accessibility (10) ------------------------------------------------------
  {
    const sub = s.submission;
    let pts: number;
    let reason: string;
    if (["explicit_permission", "own_property", "test_destination"].includes(input.sourceAutomation ?? "")) {
      pts = 10;
      reason = "Automation explicitly permitted for this source";
    } else if (sub.loginRequired) {
      pts = 4;
      reason = "Account/login required — will be handled as a manual task";
    } else if (sub.formFound && sub.captcha) {
      pts = 5;
      reason = `Submission form protected by ${sub.captcha} — a human must complete it (no CAPTCHA bypass)`;
    } else if (sub.formFound) {
      pts = 8;
      reason = `Public submission form with ${sub.requiredFields.length} required field(s)`;
    } else if (["guest_post", "resource_page", "partner"].includes(input.opportunityType)) {
      pts = s.publicEmails.length || s.hasContact ? 6 : 3;
      reason = s.publicEmails.length || s.hasContact ? "Editorial outreach via public business contact" : "No public contact route found";
    } else {
      pts = 3;
      reason = "No submission route identified yet — manual research task";
    }
    breakdown.push({ factor: "submission_accessibility", points: pts, max: 10, reason });
  }

  // ---- Link placement type (5) ------------------------------------------------------------
  {
    const [pts, reason] = PLACEMENT[input.opportunityType];
    breakdown.push({ factor: "link_placement", points: pts, max: 5, reason });
  }

  // ---- Indexability / publication conditions (5) ------------------------------------------
  {
    let pts = 5;
    const reasons: string[] = [];
    if (s.noindex) ((pts = 0), reasons.push("homepage is noindex"));
    if (input.opportunityPageNoindex) ((pts = Math.min(pts, 1)), reasons.push("opportunity page is noindex"));
    if (input.robotsAllowsOpportunityPage === false) ((pts = Math.min(pts, 1)), reasons.push("opportunity page disallowed by robots.txt"));
    if (!reasons.length) reasons.push("indexable; crawlable");
    breakdown.push({ factor: "indexability", points: pts, max: 5, reason: reasons.join("; ") });
  }

  // ---- Spam risk penalty ------------------------------------------------------------------
  {
    const penalty = Math.min(25, r.spamTerms.length * 6 + r.spamDirectory.length * 8);
    breakdown.push({
      factor: "spam_risk",
      points: -penalty,
      max: 0,
      reason: penalty ? `Penalty for spam signals: ${[...r.spamTerms, ...r.spamDirectory].join("; ")}` : "No spam signals detected"
    });
  }

  const total = breakdown.reduce((n, b) => n + b.points, 0);
  return { score: hardRejects.length ? 0 : clamp(Math.round(total), 0, 100), breakdown, hardRejects };
}
