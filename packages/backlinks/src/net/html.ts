import * as cheerio from "cheerio";

export interface LinkInfo {
  href: string;
  text: string;
  rel: string[];
  internal: boolean;
}

export interface FormField {
  name: string;
  type: string;
  id: string | null;
  label: string;
  placeholder: string;
  required: boolean;
  options: string[];
  accept: string | null;
}

export interface FormInfo {
  index: number;
  action: string;
  method: "GET" | "POST";
  enctype: string;
  fields: FormField[];
  hiddenFields: Record<string, string>;
  submitText: string;
  hasCaptcha: boolean;
  hasPassword: boolean;
  hasFileUpload: boolean;
}

export interface CaptchaSignal {
  kind: "recaptcha" | "hcaptcha" | "turnstile" | "friendlycaptcha" | "arkose" | "generic";
  evidence: string;
}

export interface PageInfo {
  url: string;
  title: string;
  description: string;
  lang: string | null;
  metaRobots: string;
  noindex: boolean;
  nofollowAll: boolean;
  canonical: string | null;
  hreflangs: string[];
  h1: string[];
  text: string;
  wordCount: number;
  links: LinkInfo[];
  forms: FormInfo[];
  captcha: CaptchaSignal | null;
  emails: string[];
  hasContactLink: boolean;
  hasAboutLink: boolean;
  hasPrivacyLink: boolean;
  jsonLdTypes: string[];
  generator: string | null;
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,24}/gi;

export function detectCaptcha(html: string): CaptchaSignal | null {
  const checks: [CaptchaSignal["kind"], RegExp][] = [
    ["recaptcha", /(google\.com\/recaptcha|recaptcha\/api\.js|class=["'][^"']*g-recaptcha|grecaptcha\.)/i],
    ["hcaptcha", /(hcaptcha\.com|class=["'][^"']*h-captcha)/i],
    ["turnstile", /(challenges\.cloudflare\.com\/turnstile|class=["'][^"']*cf-turnstile)/i],
    ["friendlycaptcha", /(friendlycaptcha|frc-captcha)/i],
    ["arkose", /(arkoselabs|funcaptcha)/i],
    ["generic", /(name=["'][^"']*captcha[^"']*["']|id=["'][^"']*captcha[^"']*["']|data-captcha)/i]
  ];
  for (const [kind, re] of checks) {
    const m = html.match(re);
    if (m) return { kind, evidence: m[0].slice(0, 120) };
  }
  return null;
}

function abs(href: string, base: string): string | null {
  try {
    const u = new URL(href, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

function hostNoWww(u: string): string {
  try {
    return new URL(u).host.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function extractForms($: cheerio.CheerioAPI, baseUrl: string): FormInfo[] {
  const forms: FormInfo[] = [];
  $("form").each((index, el) => {
    const f = $(el);
    const fields: FormField[] = [];
    const hidden: Record<string, string> = {};
    f.find("input, textarea, select").each((_, inp) => {
      const i = $(inp);
      const tag = inp.tagName.toLowerCase();
      const type = (tag === "input" ? (i.attr("type") ?? "text") : tag).toLowerCase();
      const name = i.attr("name") ?? "";
      if (!name) return;
      if (type === "hidden") {
        hidden[name] = i.attr("value") ?? "";
        return;
      }
      if (["submit", "button", "image", "reset"].includes(type)) return;
      const id = i.attr("id") ?? null;
      let label = "";
      if (id) label = $(`label[for="${id}"]`).first().text().trim();
      if (!label) label = i.closest("label").text().trim();
      if (!label) label = i.attr("aria-label") ?? "";
      fields.push({
        name,
        type,
        id,
        label: label.replace(/\s+/g, " ").slice(0, 120),
        placeholder: i.attr("placeholder") ?? "",
        required: i.is("[required]") || i.attr("aria-required") === "true",
        options:
          tag === "select"
            ? i
                .find("option")
                .map((_, o) => $(o).attr("value") ?? $(o).text())
                .get()
            : [],
        accept: i.attr("accept") ?? null
      });
    });
    const formHtml = $.html(f);
    forms.push({
      index,
      action: abs(f.attr("action") ?? baseUrl, baseUrl) ?? baseUrl,
      method: (f.attr("method") ?? "GET").toUpperCase() === "POST" ? "POST" : "GET",
      enctype: f.attr("enctype") ?? "application/x-www-form-urlencoded",
      fields,
      hiddenFields: hidden,
      submitText:
        f.find("button[type=submit], input[type=submit], button:not([type])").first().text().trim() ||
        f.find("input[type=submit]").attr("value") ||
        "",
      hasCaptcha: !!detectCaptcha(formHtml),
      hasPassword: fields.some((x) => x.type === "password"),
      hasFileUpload: fields.some((x) => x.type === "file")
    });
  });
  return forms;
}

export function extractPage(html: string, url: string, headers: Record<string, unknown> = {}): PageInfo {
  const $ = cheerio.load(html);
  const host = hostNoWww(url);
  const metaRobots = [$('meta[name="robots"]').attr("content") ?? "", String(headers["x-robots-tag"] ?? "")].join(",").toLowerCase();
  const links: LinkInfo[] = [];
  $("a[href]").each((_, a) => {
    const el = $(a);
    const href = abs(el.attr("href") ?? "", url);
    if (!href) return;
    links.push({
      href,
      text: el.text().replace(/\s+/g, " ").trim().slice(0, 200),
      rel: (el.attr("rel") ?? "").toLowerCase().split(/\s+/).filter(Boolean),
      internal: hostNoWww(href) === host
    });
  });
  const jsonLdTypes: string[] = [];
  $('script[type="application/ld+json"]').each((_, s) => {
    try {
      const data = JSON.parse($(s).text());
      const items = Array.isArray(data) ? data : (data["@graph"] ?? [data]);
      for (const it of items) if (it && it["@type"]) jsonLdTypes.push(...[].concat(it["@type"]));
    } catch {
      /* ignore malformed JSON-LD */
    }
  });
  const captcha = detectCaptcha(html);
  const forms = extractForms($, url);
  $("script, style, noscript, svg, template").remove();
  const text = $("body").text().replace(/\s+/g, " ").trim().slice(0, 60_000);
  const emails = new Set<string>();
  $('a[href^="mailto:"]').each((_, a) => {
    const e = (($(a).attr("href") ?? "").slice(7).split("?")[0] ?? "").trim().toLowerCase();
    if (e.includes("@")) emails.add(e);
  });
  for (const m of text.match(EMAIL_RE) ?? []) emails.add(m.toLowerCase());
  const linkText = links.map((l) => `${l.text} ${l.href}`.toLowerCase());
  return {
    url,
    title: $("title").first().text().trim().slice(0, 300),
    description: ($('meta[name="description"]').attr("content") ?? "").trim().slice(0, 500),
    lang: $("html").attr("lang")?.toLowerCase() ?? null,
    metaRobots,
    noindex: /\bnoindex\b|\bnone\b/.test(metaRobots),
    nofollowAll: /\bnofollow\b|\bnone\b/.test(metaRobots),
    canonical: abs($('link[rel="canonical"]').attr("href") ?? "", url),
    hreflangs: $('link[rel="alternate"][hreflang]')
      .map((_, l) => ($(l).attr("hreflang") ?? "").toLowerCase())
      .get(),
    h1: $("h1")
      .map((_, h) => $(h).text().trim())
      .get()
      .slice(0, 5),
    text,
    wordCount: text ? text.split(" ").length : 0,
    links,
    forms,
    captcha,
    emails: [...emails].filter((e) => !/\.(png|jpe?g|gif|webp|svg)$/.test(e)).slice(0, 20),
    hasContactLink: linkText.some((t) => /contact/.test(t)),
    hasAboutLink: linkText.some((t) => /about/.test(t)),
    hasPrivacyLink: linkText.some((t) => /privacy/.test(t)),
    jsonLdTypes,
    generator: $('meta[name="generator"]').attr("content") ?? null
  };
}
