import { extractSeo, compactSeo } from "@sge/crawler";
import type { AuditInput, AuditPage } from "../src/audit";

/** Builds a full HTML document. */
export function doc(o: {
  /** Path of the page: seeds a unique title, description, body and self-canonical. */
  path: string;
  title?: string | null;
  titles?: number;
  description?: string | null;
  h1?: string[];
  h2?: string[];
  body?: string;
  extraBody?: string;
  links?: string[];
  head?: string;
  lang?: string | null;
  viewport?: boolean;
  canonical?: string | null;
  og?: boolean;
  schema?: boolean;
}) {
  const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i % 50}`).join(" ");
  const title = o.title === null ? "" : `<title>${o.title ?? `Fixture page about ${o.path} for testing`}</title>`.repeat(o.titles ?? 1);
  const desc =
    o.description === null
      ? ""
      : `<meta name="description" content="${o.description ?? `Description for ${o.path}: a helpful summary of this page, long enough for search results.`}">`;
  return `<!doctype html><html${o.lang === null ? "" : ` lang="${o.lang ?? "en"}"`}><head>${title}${desc}
${o.viewport === false ? "" : '<meta name="viewport" content="width=device-width, initial-scale=1">'}
${o.canonical === null ? "" : `<link rel="canonical" href="${o.canonical ?? `https://fixture.test${o.path}`}">`}
${o.og === false ? "" : '<meta property="og:title" content="t"><meta property="og:image" content="https://fixture.test/i.png">'}
${o.schema === false ? "" : '<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage"}</script>'}
${o.head ?? ""}</head><body>
${(o.h1 ?? ["Main heading"]).map((h) => `<h1>${h}</h1>`).join("")}
${(o.h2 ?? []).map((h) => `<h2>${h}</h2>`).join("")}
<p>${o.body ?? `${words(250)} unique-${o.path.replace(/\W/g, "")}`}</p>
${o.extraBody ?? ""}
${(o.links ?? []).map((l) => `<a href="${l}">link</a>`).join(" ")}
</body></html>`;
}

export const ORIGIN = "https://fixture.test";
export const U = (path: string) => `${ORIGIN}${path}`;

type Spec = Partial<Omit<AuditPage, "url" | "seo">> & { html?: string };

/** Turns path → spec into AuditPages, parsing HTML exactly like the crawler. */
export function site(specs: Record<string, Spec>, extra: Partial<AuditInput> = {}): AuditInput {
  const pages: AuditPage[] = Object.entries(specs).map(([path, s]) => {
    const url = U(path);
    const status = s.status ?? "fetched";
    const httpStatus = s.httpStatus === undefined ? (status === "fetched" ? 200 : null) : s.httpStatus;
    const finalUrl = s.finalUrl ?? null;
    const parsedFrom = finalUrl ?? url;
    const seo = s.html && status === "fetched" && httpStatus !== null && httpStatus < 300 ? compactSeo(extractSeo(s.html, parsedFrom)) : null;
    return {
      url,
      source: s.source ?? (path === "/" ? "start" : "link"),
      status,
      httpStatus,
      finalUrl,
      redirects: s.redirects ?? [],
      redirectStatuses: s.redirectStatuses ?? [],
      error: s.error ?? null,
      skipReason: s.skipReason ?? null,
      bytes: s.bytes ?? (s.html ? s.html.length : null),
      durationMs: s.durationMs ?? 120,
      seo
    };
  });
  return { startUrl: U("/"), robotsStatus: 200, sitemapUrlCount: 10, hitPageLimit: false, pages, ...extra };
}
