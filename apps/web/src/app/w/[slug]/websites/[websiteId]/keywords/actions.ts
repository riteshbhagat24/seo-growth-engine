"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { addKeywords, AppError, deleteKeywords, keywordsFromCsv, updateKeyword } from "@sge/core";
import type { ActionResult } from "@/components/form";
import { field, runAction } from "@/lib/actions";
import { db } from "@/lib/db";
import { currentActor, requireWorkspace } from "@/lib/session";

const kwPath = (slug: string, websiteId: string) => `/w/${slug}/websites/${websiteId}/keywords`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export async function addKeywordsAction(slug: string, websiteId: string, _: ActionResult, data: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
    const lines = field(data, "keywords")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const shared = { groupName: field(data, "group") || null, tags: field(data, "tags"), intent: field(data, "intent") || null };
    const r = await addKeywords(db(), actor, access, websiteId, lines.map((keyword) => ({ keyword, ...shared })));
    revalidatePath(`/w/${slug}/websites/${websiteId}`, "layout");
    return { ok: `Added ${plural(r.added, "keyword")}${r.updated ? `, updated ${r.updated}` : ""}${r.skipped ? `, skipped ${r.skipped} already tracked` : ""}.` };
  });
}

export async function trackKeywordAction(slug: string, websiteId: string, keyword: string, _: ActionResult): Promise<ActionResult> {
  return runAction(async () => {
    const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
    await addKeywords(db(), actor, access, websiteId, [{ keyword }]);
    revalidatePath(`/w/${slug}/websites/${websiteId}`, "layout");
    return { ok: "Tracking" };
  });
}

export async function importKeywordsAction(slug: string, websiteId: string, _: ActionResult, data: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
    const file = data.get("file");
    if (!(file instanceof File) || file.size === 0) throw new AppError("invalid_input", "Choose a CSV file");
    if (file.size > 2 * 1024 * 1024) throw new AppError("invalid_input", "The file is larger than 2 MB");
    const { inputs, columns } = keywordsFromCsv(await file.text());
    const r = await addKeywords(db(), actor, access, websiteId, inputs, { source: field(data, "source") || null });
    revalidatePath(`/w/${slug}/websites/${websiteId}`, "layout");
    return { ok: `Imported ${plural(r.added, "new keyword")}, updated ${r.updated}. Columns used: ${columns.length ? columns.join(", ") : "keyword"}.` };
  });
}

export async function updateKeywordAction(slug: string, websiteId: string, keywordId: string, _: ActionResult, data: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
    await updateKeyword(db(), actor, access, keywordId, {
      groupName: field(data, "group"),
      tags: field(data, "tags"),
      targetUrl: field(data, "targetUrl"),
      intent: field(data, "intent"),
      notes: field(data, "notes")
    });
    revalidatePath(`/w/${slug}/websites/${websiteId}`, "layout");
    return { ok: "Saved." };
  });
}

export async function deleteKeywordsAction(slug: string, websiteId: string, _: ActionResult, data: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
    const ids = data.getAll("id").filter((v): v is string => typeof v === "string");
    if (!ids.length) throw new AppError("invalid_input", "Select keywords to remove");
    const n = await deleteKeywords(db(), actor, access, websiteId, ids);
    revalidatePath(`/w/${slug}/websites/${websiteId}`, "layout");
    return { ok: `Removed ${plural(n, "keyword")}.` };
  });
}

export async function deleteOneKeywordAction(slug: string, websiteId: string, keywordId: string, _: ActionResult): Promise<ActionResult> {
  return runAction(async () => {
    const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
    await deleteKeywords(db(), actor, access, websiteId, [keywordId]);
    redirect(kwPath(slug, websiteId));
  });
}
