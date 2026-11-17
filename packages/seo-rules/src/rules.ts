export type Severity = "critical" | "warning" | "notice";
export type Category =
  | "crawlability"
  | "indexability"
  | "links"
  | "content"
  | "performance"
  | "security"
  | "mobile"
  | "international"
  | "structured_data"
  | "sitemaps";

export interface Rule {
  code: string;
  category: Category;
  severity: Severity;
  /** "site" rules have no URL; "page" rules attach to one URL. */
  scope: "page" | "site";
  title: string;
  explanation: string;
  howToFix: string;
}

export const CATEGORY_LABEL: Record<Category, string> = {
  crawlability: "Crawlability",
  indexability: "Indexability",
  links: "Links",
  content: "Content",
  performance: "Performance",
  security: "Security",
  mobile: "Mobile",
  international: "International",
  structured_data: "Structured data",
  sitemaps: "Sitemaps"
};

export const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, notice: 2 };

const r = (code: string, category: Category, severity: Severity, title: string, explanation: string, howToFix: string, scope: Rule["scope"] = "page"): Rule => ({
  code,
  category,
  severity,
  scope,
  title,
  explanation,
  howToFix
});

/** The audit rule catalogue. Thresholds live in `audit.ts` next to the checks. */
export const RULES_LIST: Rule[] = [
  // ── Crawlability ───────────────────────────────────────────────────────────
  r("http_4xx", "crawlability", "critical", "Page returns a 4xx error",
    "The page responds with a client error (such as 404 Not Found), so visitors and search engines reach a dead end.",
    "Restore the page, or 301-redirect the URL to the most relevant live page, and update links that point to it."),
  r("http_5xx", "crawlability", "critical", "Page returns a 5xx server error",
    "The server failed to deliver the page. Repeated server errors make search engines crawl less and can drop pages from the index.",
    "Check server logs for the failing URL, fix the application or hosting error, and re-run the audit."),
  r("fetch_failed", "crawlability", "critical", "Page couldn't be fetched",
    "The request timed out or the connection failed, so the page couldn't be read.",
    "Make sure the page loads quickly and reliably; check hosting, firewall or bot-protection settings that may block crawlers."),
  r("redirect_chain", "crawlability", "warning", "Redirect chain",
    "Reaching the page takes two or more redirects. Each hop slows users down and wastes crawl budget; long chains may not be followed.",
    "Redirect the original URL straight to the final destination and update internal links to the final URL."),
  r("temporary_redirect", "crawlability", "notice", "Temporary (302/307) redirect",
    "The URL redirects with a temporary status, which tells search engines to keep the old URL indexed.",
    "If the move is permanent, use a 301 (or 308) redirect instead."),
  r("blocked_by_robots", "crawlability", "notice", "Blocked by robots.txt",
    "robots.txt stops crawlers from fetching this URL, so search engines can't read its content.",
    "If the page should appear in search, remove or narrow the Disallow rule that matches it."),
  r("meta_refresh", "crawlability", "notice", "Meta refresh redirect",
    "The page uses a <meta http-equiv=\"refresh\"> redirect, which is slower and less reliable than a server redirect.",
    "Replace it with a 301 redirect on the server."),
  r("robots_txt_missing", "crawlability", "notice", "No robots.txt file",
    "The site has no robots.txt. Crawlers will fetch everything, and you can't point them to your sitemap from there.",
    "Add a /robots.txt file, even a minimal one, and include a Sitemap: line.", "site"),
  r("robots_blocks_homepage", "crawlability", "critical", "robots.txt blocks the homepage",
    "robots.txt disallows the start page, so search engines can't crawl the site from its homepage.",
    "Remove the Disallow rule that matches the homepage (often a stray \"Disallow: /\").", "site"),
  r("crawl_limit_reached", "crawlability", "notice", "Audit stopped at the page limit",
    "The crawl reached its page limit before visiting every URL, so this audit covers part of the site.",
    "Verify the website to raise the per-audit limit, or upgrade the plan for more pages.", "site"),

  // ── Indexability ───────────────────────────────────────────────────────────
  r("noindex_page", "indexability", "notice", "Page is set to noindex",
    "A robots meta tag or X-Robots-Tag header asks search engines not to index this page.",
    "Fine for thank-you, login or filter pages. If this page should rank, remove the noindex directive."),
  r("nofollow_page", "indexability", "notice", "Page is set to nofollow",
    "The page tells search engines not to follow any of its links, so it passes no link value.",
    "Remove the page-level nofollow unless there's a specific reason for it."),
  r("canonical_missing", "indexability", "notice", "No canonical tag",
    "Without a canonical tag, search engines guess which URL version to index when duplicates exist (parameters, http/https, trailing slashes).",
    "Add <link rel=\"canonical\" href=\"…\"> pointing to the page's preferred URL (usually itself)."),
  r("canonical_points_elsewhere", "indexability", "notice", "Canonicalised to another URL",
    "The canonical tag names a different URL, so this page probably won't be indexed itself.",
    "Expected for duplicates. If this page should rank on its own, make the canonical point to itself."),
  r("canonical_to_bad_url", "indexability", "warning", "Canonical points to a broken or redirected URL",
    "The canonical target returns an error or redirects, which sends search engines a conflicting signal.",
    "Point the canonical at the final, live (200) URL."),
  r("multiple_canonicals", "indexability", "warning", "More than one canonical tag",
    "Several canonical tags give conflicting signals; search engines may ignore all of them.",
    "Keep a single canonical tag in the <head>. Check that plugins and themes don't add their own."),

  // ── Links ─────────────────────────────────────────────────────────────────
  r("broken_internal_link", "links", "critical", "Links to a broken internal page",
    "This page links to internal URLs that return errors, which frustrates visitors and wastes crawl budget.",
    "Update or remove the broken links, or restore the target pages."),
  r("broken_external_link", "links", "warning", "Links to a broken external page",
    "This page links to other websites' pages that no longer exist or are failing.",
    "Replace the links with working sources or remove them."),
  r("internal_link_to_redirect", "links", "notice", "Links to a redirecting internal URL",
    "Internal links point to URLs that redirect, adding an extra hop for every visit and crawl.",
    "Update the links to point directly to the final URL."),
  r("orphan_page", "links", "warning", "Orphan page (in sitemap, no internal links)",
    "The page is listed in the sitemap but no crawled page links to it, so visitors can't find it and it gets little link value.",
    "Link to it from relevant pages or navigation, or remove it from the sitemap if it's obsolete."),
  r("deep_page", "links", "notice", "Page is 4+ clicks from the homepage",
    "Pages buried deep in the site get crawled less often and receive less internal link value.",
    "Link to important deep pages from the homepage, hubs or navigation."),
  r("nofollow_internal_links", "links", "notice", "Nofollow on internal links",
    "Internal links marked rel=\"nofollow\" stop link value flowing inside your own site.",
    "Remove nofollow from internal links (use noindex on the target if you want to keep it out of search)."),
  r("internal_http_links", "links", "notice", "Links to http:// pages of your own site",
    "This https page links to insecure http URLs on the same site, causing redirects or insecure pages.",
    "Update internal links to use https://."),

  // ── Content ───────────────────────────────────────────────────────────────
  r("missing_title", "content", "critical", "Missing title tag",
    "The page has no <title>. Titles are the main headline in search results and a strong relevance signal.",
    "Add a unique, descriptive title of about 30–60 characters."),
  r("title_too_long", "content", "warning", "Title too long (over 60 characters)",
    "Search engines truncate long titles in results, which can cut off the important part.",
    "Shorten the title to about 60 characters, keeping the main keyword near the start."),
  r("title_too_short", "content", "notice", "Title too short (under 30 characters)",
    "A very short title misses the chance to describe the page and include relevant terms.",
    "Expand the title to about 30–60 characters."),
  r("multiple_titles", "content", "warning", "More than one title tag",
    "Several <title> tags confuse search engines about which one to show.",
    "Keep exactly one <title> in the <head>."),
  r("duplicate_title", "content", "warning", "Duplicate title",
    "Several pages share the same title, making it hard for search engines (and users) to tell them apart.",
    "Give each page a unique title that describes its specific content."),
  r("missing_meta_description", "content", "warning", "Missing meta description",
    "Without a meta description, search engines pick a snippet themselves, which is often less compelling.",
    "Add a unique description of about 70–160 characters that summarises the page and invites the click."),
  r("meta_description_too_long", "content", "notice", "Meta description too long (over 160 characters)",
    "Long descriptions are truncated in search results.",
    "Trim it to about 160 characters."),
  r("meta_description_too_short", "content", "notice", "Meta description too short (under 70 characters)",
    "A very short description doesn't use the space available in search results.",
    "Expand it to about 70–160 characters."),
  r("duplicate_meta_description", "content", "warning", "Duplicate meta description",
    "Several pages share the same description, so their search snippets look identical.",
    "Write a unique description for each page."),
  r("multiple_meta_descriptions", "content", "notice", "More than one meta description",
    "Several description tags are present; search engines may pick the wrong one.",
    "Keep a single meta description tag."),
  r("missing_h1", "content", "warning", "Missing H1 heading",
    "The page has no H1. The main heading helps users and search engines understand the topic.",
    "Add one H1 that describes the page's main topic."),
  r("multiple_h1", "content", "notice", "More than one H1",
    "Several H1 headings blur the page's main topic. It's allowed, but one clear H1 is best practice.",
    "Use a single H1 and turn the others into H2/H3 subheadings."),
  r("low_word_count", "content", "notice", "Thin content (under 200 words)",
    "Pages with very little text often struggle to rank because they don't fully answer the searcher's question.",
    "Add useful, original content, or noindex the page if it isn't meant to rank."),
  r("duplicate_content", "content", "warning", "Duplicate content",
    "The visible text is identical to other pages. Search engines pick one version and may ignore the others.",
    "Merge the pages, make each unique, or add a canonical tag pointing to the main version."),
  r("images_missing_alt", "content", "warning", "Images without alt text",
    "Images lack an alt attribute, which screen readers and image search rely on.",
    "Add descriptive alt text to meaningful images (use alt=\"\" for purely decorative ones)."),

  // ── Performance ───────────────────────────────────────────────────────────
  r("slow_response", "performance", "warning", "Slow server response (over 3 s)",
    "The HTML took more than 3 seconds to download, which hurts user experience and Core Web Vitals.",
    "Enable page caching, optimise database queries, use a CDN, or upgrade hosting."),
  r("page_too_large", "performance", "warning", "Large HTML page (over 1 MB)",
    "Very large HTML slows down loading and parsing, especially on mobile.",
    "Remove inline data and bloated markup, paginate long lists, and load heavy content on demand."),
  r("url_too_long", "performance", "notice", "URL longer than 115 characters",
    "Long URLs are harder to share and read, and get truncated in search results.",
    "Use short, descriptive URLs."),
  r("url_uppercase", "performance", "notice", "Uppercase letters in URL",
    "URLs are case-sensitive; mixed case can create duplicate URLs and broken links.",
    "Use lowercase URLs and redirect uppercase variants."),
  r("url_underscores", "performance", "notice", "Underscores in URL",
    "Search engines treat hyphens as word separators but not underscores.",
    "Use hyphens instead of underscores in new URLs."),

  // ── Security ──────────────────────────────────────────────────────────────
  r("no_https", "security", "critical", "Site isn't served over HTTPS",
    "The homepage loads over insecure http. Browsers warn visitors and HTTPS is a ranking signal.",
    "Install a TLS certificate (free from Let's Encrypt or your host) and 301-redirect http to https.", "site"),
  r("mixed_content", "security", "critical", "Mixed content (http resources on an https page)",
    "The secure page loads images, scripts or styles over http. Browsers block or warn about these.",
    "Load every resource over https://."),

  // ── Mobile ────────────────────────────────────────────────────────────────
  r("missing_viewport", "mobile", "warning", "Missing viewport meta tag",
    "Without a viewport tag, mobile browsers render the page at desktop width. Google indexes the mobile version.",
    "Add <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">."),

  // ── International ─────────────────────────────────────────────────────────
  r("missing_lang", "international", "notice", "Missing language attribute",
    "The <html> tag has no lang attribute, which helps browsers, screen readers and search engines.",
    "Add the page's language, for example <html lang=\"en\">."),
  r("hreflang_invalid", "international", "warning", "Invalid hreflang code",
    "An hreflang annotation uses a language or region code search engines don't recognise (e.g. en-UK instead of en-GB).",
    "Use ISO 639-1 language codes, optionally with ISO 3166-1 region codes (en, en-GB, x-default)."),
  r("hreflang_no_return", "international", "warning", "hreflang without a return link",
    "This page names an alternate that doesn't link back. Search engines ignore hreflang pairs without return links.",
    "Make every alternate page list all the others (including itself)."),

  // ── Structured data ───────────────────────────────────────────────────────
  r("invalid_json_ld", "structured_data", "warning", "Invalid JSON-LD",
    "A structured-data block can't be parsed, so search engines ignore it.",
    "Fix the JSON syntax (validate it with Google's Rich Results Test or schema.org validator)."),
  r("no_structured_data", "structured_data", "notice", "No structured data",
    "The page has no schema.org markup, which can enable rich results such as FAQs, products, reviews or breadcrumbs.",
    "Add relevant JSON-LD (Organization, BreadcrumbList, Article, Product, LocalBusiness…)."),
  r("missing_open_graph", "structured_data", "notice", "Missing Open Graph tags",
    "Without og:title and og:image, links shared on social media show poor previews.",
    "Add og:title, og:description and og:image meta tags."),

  // ── Sitemaps ──────────────────────────────────────────────────────────────
  r("sitemap_missing", "sitemaps", "warning", "No XML sitemap found",
    "No sitemap was listed in robots.txt or found at /sitemap.xml. Sitemaps help search engines discover pages.",
    "Generate a sitemap (most CMSs and SEO plugins do this), and reference it in robots.txt.", "site"),
  r("sitemap_bad_url", "sitemaps", "warning", "Sitemap lists a broken or redirected URL",
    "The sitemap includes a URL that redirects or returns an error. Sitemaps should list only final, live pages.",
    "Remove or update the URL in the sitemap."),
  r("noindex_in_sitemap", "sitemaps", "warning", "Noindex page listed in the sitemap",
    "The sitemap asks search engines to index a page that tells them not to.",
    "Remove noindex pages from the sitemap, or remove the noindex if the page should rank.")
];

export const RULES: Record<string, Rule> = Object.fromEntries(RULES_LIST.map((x) => [x.code, x]));

export function ruleFor(code: string): Rule {
  const found = RULES[code];
  if (!found) throw new Error(`Unknown audit rule: ${code}`);
  return found;
}
