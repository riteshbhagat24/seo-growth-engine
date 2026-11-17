import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, can, getClient, isUuidLike, listMembers, ROLE_LABEL } from "@sge/core";
import { ActionForm, SubmitButton } from "@/components/form";
import { Badge, Card, Field, Input, LinkButton, PageHeader } from "@/components/ui";
import { VerificationBadge } from "@/components/verification-badge";
import { db } from "@/lib/db";
import { currentActor, requireWorkspace } from "@/lib/session";
import { archiveClientAction, updateClientAction } from "../actions";

export default async function ClientPage({ params }: PageProps<"/w/[slug]/clients/[clientId]">) {
  const { slug, clientId } = await params;
  if (!isUuidLike(clientId)) notFound();
  const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
  if (access.workspace.type !== "agency") notFound();
  const data = await getClient(db(), actor, access, clientId).catch((e) => {
    if (e instanceof AppError && e.code === "not_found") notFound();
    throw e;
  });
  const { client: c, websites } = data;
  const manage = can(access.role, "clients.manage") && access.allClients;
  const addSites = can(access.role, "websites.manage");
  const members = can(access.role, "members.view") ? await listMembers(db(), actor, access) : [];
  const assigned = members.filter((m) => data.assignedMembershipIds.includes(m.membershipId));
  const archived = c.status === "archived";

  return (
    <>
      <Link href={`/w/${slug}/clients`} className="text-sm text-muted hover:text-foreground">
        ← Clients
      </Link>
      <div className="mt-3">
        <PageHeader
          title={c.name}
          description={[c.contactName, c.contactEmail, c.website].filter(Boolean).join(" · ") || undefined}
          actions={archived ? <Badge>Archived</Badge> : undefined}
        />
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <Card className="p-0">
            <div className="flex items-center justify-between px-6 pt-5 pb-3">
              <h2 className="font-semibold">Websites</h2>
              {addSites && !archived && (
                <LinkButton href={`/w/${slug}/websites?client=${c.id}`} variant="secondary" className="h-8 px-3">
                  Add website
                </LinkButton>
              )}
            </div>
            {websites.length === 0 ? (
              <p className="px-6 pb-6 text-sm text-muted">No websites for this client yet.</p>
            ) : (
              <ul className="divide-y divide-border border-t border-border">
                {websites.map((w) => (
                  <li key={w.id} className="flex items-center justify-between px-6 py-3 text-sm">
                    <Link href={`/w/${slug}/websites/${w.id}`} className="font-medium text-brand hover:underline">
                      {w.displayName ?? w.domain}
                    </Link>
                    <VerificationBadge status={w.verificationStatus} />
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {manage && (
            <Card>
              <h2 className="mb-4 font-semibold">Client details</h2>
              <ActionForm action={updateClientAction.bind(null, slug, c.id)} className="flex flex-col gap-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Name" htmlFor="name">
                    <Input id="name" name="name" defaultValue={c.name} required minLength={2} maxLength={120} />
                  </Field>
                  <Field label="Website" htmlFor="website">
                    <Input id="website" name="website" type="url" defaultValue={c.website ?? ""} placeholder="https://…" />
                  </Field>
                  <Field label="Contact name" htmlFor="contactName">
                    <Input id="contactName" name="contactName" defaultValue={c.contactName ?? ""} maxLength={120} />
                  </Field>
                  <Field label="Contact email" htmlFor="contactEmail">
                    <Input id="contactEmail" name="contactEmail" type="email" defaultValue={c.contactEmail ?? ""} maxLength={254} />
                  </Field>
                </div>
                <Field label="Notes" htmlFor="notes">
                  <textarea
                    id="notes"
                    name="notes"
                    defaultValue={c.notes ?? ""}
                    maxLength={2000}
                    rows={4}
                    className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm focus:border-brand focus:outline-none"
                  />
                </Field>
                <div>
                  <SubmitButton pending="Saving…">Save</SubmitButton>
                </div>
              </ActionForm>
            </Card>
          )}
        </div>

        <div className="flex flex-col gap-6">
          {members.length > 0 && (
            <Card>
              <h2 className="font-semibold">Restricted access</h2>
              <p className="mt-1 mb-3 text-sm text-muted">
                People limited to specific clients who can see {c.name}. Members with “All clients” access also see it.
              </p>
              {assigned.length === 0 ? (
                <p className="text-sm text-muted">Nobody yet. Assign people from the Members page.</p>
              ) : (
                <ul className="flex flex-col gap-2 text-sm">
                  {assigned.map((m) => (
                    <li key={m.membershipId} className="flex justify-between gap-2">
                      <span className="truncate">{m.name}</span>
                      <Badge>{ROLE_LABEL[m.role]}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
          {manage && (
            <Card>
              <h2 className="font-semibold">{archived ? "Restore client" : "Archive client"}</h2>
              <p className="mt-1 mb-4 text-sm text-muted">
                {archived
                  ? "Makes the client active again (counts towards your plan)."
                  : "Hides the client from active lists and frees a plan slot. History is kept."}
              </p>
              <ActionForm action={archiveClientAction.bind(null, slug, c.id, !archived)} confirm={archived ? undefined : `Archive ${c.name}?`}>
                <SubmitButton variant={archived ? "secondary" : "danger"}>{archived ? "Restore" : "Archive"}</SubmitButton>
              </ActionForm>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
