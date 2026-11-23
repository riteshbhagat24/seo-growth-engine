import * as cheerio from "cheerio";
/**
 * Maps a destination form's fields to approved business information. Handles website-specific variations
 * through (1) an explicit per-source mapping (backlink_sources.form_mapping.fields) and (2) label/name/
 * placeholder heuristics. Required fields we cannot fill from approved data are NEVER invented — the
 * submission is paused and handed to a human.
 */
import type { FormField, FormInfo } from "../net/html";
import type { SourceInfo, SubmissionValues } from "./types";

export type Semantic = keyof SubmissionValues | "terms" | "newsletter" | "ignore";

const PATTERNS: [Semantic, RegExp][] = [
  ["terms", /(terms|agree|consent|accept|tos|policy)/i],
  ["newsletter", /(newsletter|subscribe|marketing|updates|promotions?)/i],
  ["email", /e-?mail/i],
  ["phone", /(phone|tel|mobile|whatsapp)/i],
  ["contact_name", /((contact|your|full|first)[\s_-]*name|^name$|submitter)/i],
  ["website_url", /(url|website|web[\s_-]*site|site[\s_-]*address|homepage|link)/i],
  ["business_name", /((business|company|site|organi[sz]ation|listing|brand|product|startup)[\s_-]*(name|title)?$|^title$)/i],
  ["short_description", /(short|summary|tagline|excerpt|headline|one[\s_-]*liner)/i],
  ["long_description", /(description|about|details|content|body|message|info)/i],
  ["category", /(category|industry|sector|niche|type)/i],
  ["country", /country/i],
  ["city", /(city|town|location)/i],
  ["address", /(address|street)/i],
  ["keywords", /(keywords?|tags)/i],
  ["logo_url", /(logo|image|icon|photo|screenshot)/i]
];

function describe(f: FormField): string {
  return `${f.name} ${f.id ?? ""} ${f.label} ${f.placeholder}`.trim();
}

export function semanticFor(f: FormField, explicit: Record<string, string> = {}): Semantic | null {
  if (explicit[f.name]) return explicit[f.name] as Semantic;
  if (f.type === "email") return "email";
  if (f.type === "tel") return "phone";
  if (f.type === "url") return "website_url";
  if (f.type === "file") return "logo_url";
  if (f.type === "checkbox") {
    if (/(terms|agree|consent|accept|tos)/i.test(describe(f))) return "terms";
    if (/(newsletter|subscribe|marketing)/i.test(describe(f))) return "newsletter";
    return null;
  }
  if (/captcha/i.test(describe(f))) return null;
  const d = describe(f);
  for (const [sem, re] of PATTERNS) {
    if (sem === "terms" || sem === "newsletter" || sem === "logo_url") continue;
    if (re.test(d)) {
      // a textarea named "name" is unlikely; a textarea is usually a description
      if (f.type === "textarea" && (sem === "business_name" || sem === "contact_name")) return "long_description";
      return sem;
    }
  }
  if (f.type === "textarea") return "long_description";
  return null;
}

function chooseOption(options: string[], wanted: string | null): string | null {
  if (!wanted || !options.length) return null;
  const w = wanted.toLowerCase();
  return options.find((o) => o.toLowerCase() === w) ?? options.find((o) => o && (o.toLowerCase().includes(w) || w.includes(o.toLowerCase()))) ?? null;
}

export interface FillPlan {
  values: Record<string, string>;
  checkboxes: string[];
  unmappedRequired: { field: string; label: string; reason: string }[];
  skipped: { field: string; reason: string }[];
  mapping: Record<string, string>;
}

export function termsAccepted(source: SourceInfo | null): boolean {
  const ev = source?.permission_evidence ?? {};
  return Boolean(ev.terms_accepted_by && ev.terms_accepted_at);
}

/** Choose the most plausible submission form on the page. */
export function chooseForm(forms: FormInfo[], source: SourceInfo | null): FormInfo | null {
  const idx = source?.form_mapping?.form_index;
  if (typeof idx === "number" && forms[idx]) return forms[idx];
  const candidates = forms.filter((f) => f.fields.length >= 2 && !f.fields.every((x) => x.type === "search"));
  return candidates.sort((a, b) => score(b) - score(a))[0] ?? null;
  function score(f: FormInfo) {
    return f.fields.filter((x) => semanticFor(x) && semanticFor(x) !== "ignore").length + (f.method === "POST" ? 2 : 0);
  }
}

export function planFill(form: FormInfo, values: SubmissionValues, source: SourceInfo | null): FillPlan {
  const explicit: Record<string, string> = source?.form_mapping?.fields ?? {};
  const plan: FillPlan = { values: {}, checkboxes: [], unmappedRequired: [], skipped: [], mapping: {} };
  for (const f of form.fields) {
    const sem = semanticFor(f, explicit);
    if (!sem || sem === "ignore") {
      if (f.required)
        plan.unmappedRequired.push({
          field: f.name,
          label: f.label || f.placeholder || f.name,
          reason: "No approved information maps to this required field"
        });
      else plan.skipped.push({ field: f.name, reason: "not mapped" });
      continue;
    }
    plan.mapping[f.name] = sem;
    if (sem === "newsletter") {
      plan.skipped.push({ field: f.name, reason: "Marketing opt-ins are never ticked automatically" });
      continue;
    }
    if (sem === "terms") {
      if (termsAccepted(source)) plan.checkboxes.push(f.name);
      else
        plan.unmappedRequired.push({
          field: f.name,
          label: f.label || f.name,
          reason: "The destination's terms must be reviewed and accepted by a person first"
        });
      continue;
    }
    if (sem === "logo_url") {
      // File uploads are never automated: the worker must not read files on behalf of tenant data.
      if (f.required)
        plan.unmappedRequired.push({
          field: f.name,
          label: f.label || f.name,
          reason: "File uploads are done by a person (upload the approved logo yourself)"
        });
      else plan.skipped.push({ field: f.name, reason: "file uploads are never automated" });
      continue;
    }
    // A "website" field receives the campaign's target page — that is where the backlink must point.
    let v = values[(sem === "website_url" ? "target_url" : sem) as keyof SubmissionValues] as string | null;
    if (f.options.length) v = chooseOption(f.options, v);
    if (v == null || v === "") {
      if (f.required)
        plan.unmappedRequired.push({ field: f.name, label: f.label || f.name, reason: `Approved profile has no value for ${sem} (never invented)` });
      else plan.skipped.push({ field: f.name, reason: `no approved value for ${sem}` });
      continue;
    }
    plan.values[f.name] = v;
  }
  return plan;
}

export const CONFIRMATION_RE =
  /(thank you|thanks|submitted|received|pending (review|approval|moderation)|under review|awaiting (approval|review)|success(fully)?)/i;
export const FORM_ERROR_RE = /\b(error|invalid|is required|already (exists|listed|submitted)|duplicate|rejected|not allowed)\b/i;
export const EMAIL_VERIFY_RE = /(verify your email|confirmation (email|link)|check your (inbox|email)|activate your (account|listing))/i;

/** The destination's own confirmation message (prefers explicit status/alert elements over page chrome). */
export function confirmationSnippet(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, noscript, nav, header, footer").remove();
  for (const sel of [".confirmation", '[role="status"]', '[role="alert"]', ".alert-success", ".success", ".notice", ".message"]) {
    const t = $(sel).first().text().replace(/\s+/g, " ").trim();
    if (t && CONFIRMATION_RE.test(t)) return t.slice(0, 400);
  }
  const main = ($("main").text() || $("body").text()).replace(/\s+/g, " ").trim();
  const sentences = main.split(/(?<=[.!?])\s+/);
  const i = sentences.findIndex((x) => CONFIRMATION_RE.test(x));
  return (i >= 0 ? sentences.slice(i, i + 3).join(" ") : main.slice(0, 200)).slice(0, 400);
}

/** Text used to judge a submission outcome: main content only, without page chrome, emails or URLs. */
export function outcomeText(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, noscript, nav, header, footer, template").remove();
  const t = ($("main").text() || $("body").text()).replace(/\s+/g, " ");
  return t
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,24}/gi, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .trim();
}
