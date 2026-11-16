import { notFound } from "next/navigation";
import { can } from "@sge/core";
import { ActionForm, SubmitButton } from "@/components/form";
import { Card, Field, Input, PageHeader } from "@/components/ui";
import { requireWorkspace } from "@/lib/session";
import { updateBrandingAction, updateGeneralAction } from "../actions";

export default async function WorkspaceSettings({ params }: PageProps<"/w/[slug]/settings">) {
  const { slug } = await params;
  const { workspace: ws, role } = await requireWorkspace(slug);
  const canRename = can(role, "workspace.update");
  const canBrand = can(role, "branding.manage");
  if (!canRename && !canBrand) notFound();

  return (
    <>
      <PageHeader title="Workspace settings" description="Name and branding shown in the app, client portal and reports." />
      <div className="flex max-w-2xl flex-col gap-6">
        {canRename && (
          <Card>
            <h2 className="mb-4 font-semibold">General</h2>
            <ActionForm action={updateGeneralAction.bind(null, slug)} className="flex flex-col gap-4">
              <Field label="Workspace name" htmlFor="name">
                <Input id="name" name="name" defaultValue={ws.name} required minLength={2} maxLength={80} />
              </Field>
              <div>
                <SubmitButton pending="Saving…">Save</SubmitButton>
              </div>
            </ActionForm>
          </Card>
        )}
        {canBrand && (
          <Card>
            <h2 className="font-semibold">Branding</h2>
            <p className="mt-1 mb-4 text-sm text-muted">Applied to this workspace's app header and, later, to client reports.</p>
            <ActionForm action={updateBrandingAction.bind(null, slug)} className="flex flex-col gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Primary colour" htmlFor="primary" hint="Hex, e.g. #1f4e79">
                  <Input id="primary" name="primary" defaultValue={ws.branding.primary ?? ""} placeholder="#1f4e79" pattern="#[0-9a-fA-F]{6}" />
                </Field>
                <Field label="Accent colour" htmlFor="accent" hint="Hex, e.g. #e8833a">
                  <Input id="accent" name="accent" defaultValue={ws.branding.accent ?? ""} placeholder="#e8833a" pattern="#[0-9a-fA-F]{6}" />
                </Field>
              </div>
              <Field label="Logo URL" htmlFor="logoUrl" hint="An https link to a PNG or SVG. File upload arrives with storage support.">
                <Input id="logoUrl" name="logoUrl" type="url" defaultValue={ws.branding.logoUrl ?? ""} placeholder="https://…" />
              </Field>
              <div>
                <SubmitButton pending="Saving…">Save branding</SubmitButton>
              </div>
            </ActionForm>
          </Card>
        )}
      </div>
    </>
  );
}
