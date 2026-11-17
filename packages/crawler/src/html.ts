import { load } from "cheerio";

/** Content values of <meta name="…"> tags (case-insensitive name match). */
export function metaContents(html: string, name: string): string[] {
  const $ = load(html);
  const wanted = name.toLowerCase();
  return $("meta")
    .toArray()
    .filter((el) => ($(el).attr("name") ?? "").toLowerCase() === wanted)
    .map((el) => ($(el).attr("content") ?? "").trim());
}
