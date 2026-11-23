import { Building2 } from "lucide-react";
import { backlinkCatalogue, getBusinessProfile } from "@sge/backlinks";
import { can, getWebsite } from "@sge/core";
import { ActionForm, SubmitButton } from "@/components/form";
import { Alert, Badge, Card, CardHeader, Field, Input, Select, Textarea } from "@/components/ui";
import { db } from "@/lib/db";
import { currentActor, requireWorkspace } from "@/lib/session";
import { approveProfileAction, saveProfileAction } from "../actions";
import { fmtWhen } from "../ui";

const join = (v: unknown) => (Array.isArray(v) ? v.join("\n") : "");

export default async function ProfilePage({ params }: PageProps<"/w/[slug]/websites/[websiteId]/backlinks/profile">) {
  const { slug, websiteId } = await params;
  const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
  const [{ website: w }, p] = await Promise.all([getWebsite(db(), actor, access, websiteId), getBusinessProfile(db(), actor, access, websiteId)]);
  const { industries } = backlinkCatalogue();
  const canEdit = can(access.role, "work.run");
  const canApprove = can(access.role, "work.approve");
  const pages = (p?.target_landing_pages ?? []).map((l) => `${l.url}${l.label ? ` ${l.label}` : ""}`).join("\n");

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader
          icon={<Building2 className="size-4" />}
          title="Business profile"
          description="The only source of facts for generated listings and pitches. Anything not here (awards, statistics, addresses, founders) is never claimed."
          actions={p ? <Badge tone={p.status === "approved" ? "success" : "warning"}>{p.status === "approved" ? `approved v${p.version} · ${fmtWhen(p.approved_at)}` : `draft v${p.version}`}</Badge> : <Badge>not created</Badge>}
        />
        {p && p.status !== "approved" && canApprove && (
          <div className="mb-4">
            <Alert tone="warning">Saved changes return the profile to draft. Approve it so campaigns can prepare content from it.</Alert>
            <ActionForm action={approveProfileAction.bind(null, slug, websiteId)} className="mt-3">
              <SubmitButton>Approve profile</SubmitButton>
            </ActionForm>
          </div>
        )}
        <ActionForm action={saveProfileAction.bind(null, slug, websiteId)} className="grid gap-4 md:grid-cols-2">
          <fieldset disabled={!canEdit} className="contents">
            <Field label="Business name" htmlFor="business_name">
              <Input id="business_name" name="business_name" required defaultValue={p?.business_name ?? w.displayName ?? ""} />
            </Field>
            <Field label="Website URL" htmlFor="website_url">
              <Input id="website_url" name="website_url" type="url" required defaultValue={p?.website_url ?? `${w.url}/`} />
            </Field>
            <Field label="Industry" htmlFor="industry">
              <Select id="industry" name="industry" defaultValue={p?.industry ?? "other"}>
                {industries.map((i) => (
                  <option key={i.key} value={i.key}>
                    {i.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Target countries" htmlFor="target_countries" hint="ISO codes, comma separated (e.g. IN, GB)">
              <Input id="target_countries" name="target_countries" defaultValue={(p?.target_countries ?? []).join(", ")} />
            </Field>
            <div className="md:col-span-2">
              <Field label="Description" htmlFor="description" hint="At least 20 characters. Plain facts about what the business does.">
                <Textarea id="description" name="description" rows={4} required minLength={20} defaultValue={p?.description ?? ""} />
              </Field>
            </div>
            <Field label="Products and services" htmlFor="products_services" hint="One per line">
              <Textarea id="products_services" name="products_services" rows={4} defaultValue={join(p?.products_services)} />
            </Field>
            <Field label="Landing pages" htmlFor="target_landing_pages" hint="One per line: URL, then an optional label">
              <Textarea id="target_landing_pages" name="target_landing_pages" rows={4} defaultValue={pages} />
            </Field>
            <Field label="Approved anchor texts" htmlFor="approved_anchor_texts" hint="One per line. Default: the business name.">
              <Textarea id="approved_anchor_texts" name="approved_anchor_texts" rows={3} defaultValue={join(p?.approved_anchor_texts)} />
            </Field>
            <Field label="Target keywords" htmlFor="target_keywords" hint="One per line">
              <Textarea id="target_keywords" name="target_keywords" rows={3} defaultValue={join(p?.target_keywords)} />
            </Field>
            <Field label="Brand descriptions" htmlFor="brand_descriptions" hint="Approved one-liners, one per line">
              <Textarea id="brand_descriptions" name="brand_descriptions" rows={3} defaultValue={join(p?.brand_descriptions)} />
            </Field>
            <Field label="Verified facts" htmlFor="verified_facts" hint="Awards, certifications, statistics you can prove. One per line.">
              <Textarea id="verified_facts" name="verified_facts" rows={3} defaultValue={join(p?.verified_facts)} />
            </Field>
            <Field label="Contact email" htmlFor="contact_email">
              <Input id="contact_email" name="contact_email" type="email" defaultValue={p?.contact_email ?? ""} />
            </Field>
            <Field label="Contact phone" htmlFor="contact_phone">
              <Input id="contact_phone" name="contact_phone" defaultValue={p?.contact_phone ?? ""} />
            </Field>
            <Field label="Logo URL" htmlFor="logo_url" hint="Shown to you for uploads; files are never uploaded automatically">
              <Input id="logo_url" name="logo_url" type="url" defaultValue={p?.logo_url ?? ""} />
            </Field>
            <Field label="Founded (year)" htmlFor="founded_year">
              <Input id="founded_year" name="founded_year" type="number" min={1800} max={2100} defaultValue={p?.founded_year ?? ""} />
            </Field>
            <Field label="Founder name" htmlFor="founder_name" hint="Leave empty and no founder bio is ever written">
              <Input id="founder_name" name="founder_name" defaultValue={p?.founder?.name ?? ""} />
            </Field>
            <Field label="Founder title" htmlFor="founder_title">
              <Input id="founder_title" name="founder_title" defaultValue={p?.founder?.title ?? ""} />
            </Field>
            <div className="md:col-span-2">
              <Field label="Founder bio" htmlFor="founder_bio">
                <Textarea id="founder_bio" name="founder_bio" rows={2} defaultValue={p?.founder?.bio ?? ""} />
              </Field>
            </div>
            {canEdit && (
              <div className="md:col-span-2">
                <SubmitButton pending="Saving…">Save as draft</SubmitButton>
              </div>
            )}
          </fieldset>
        </ActionForm>
      </Card>
    </div>
  );
}
