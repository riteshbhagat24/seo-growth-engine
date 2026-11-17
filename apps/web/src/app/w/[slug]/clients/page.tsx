import Link from "next/link";
import { notFound } from "next/navigation";
import { can, listClients } from "@sge/core";
import { ActionForm, SubmitButton } from "@/components/form";
import { Badge, Card, Field, Input, PageHeader } from "@/components/ui";
import { db } from "@/lib/db";
import { currentActor, requireWorkspace } from "@/lib/session";
import { createClientAction } from "./actions";

export default async function ClientsPage({ params, searchParams }: PageProps<"/w/[slug]/clients">) {
  const { slug } = await params;
  const sp = await searchParams;
  const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
  if (access.workspace.type !== "agency") notFound();
  const showArchived = sp.archived === "1";
  const manage = can(access.role, "clients.manage") && access.allClients;
  const clients = await listClients(db(), actor, access, { includeArchived: showArchived });

  return (
    <>
      <PageHeader
        title="Clients"
        description={manage ? "The businesses you manage SEO for. Each client can have several websites." : "Clients you have access to."}
        actions={
          <Link href={showArchived ? `/w/${slug}/clients` : `/w/${slug}/clients?archived=1`} className="text-sm text-muted hover:text-foreground">
            {showArchived ? "Hide archived" : "Show archived"}
          </Link>
        }
      />
      <div className="flex flex-col gap-6">
        {manage && (
          <Card>
            <h2 className="mb-4 font-semibold">Add a client</h2>
            <ActionForm action={createClientAction.bind(null, slug)} className="grid gap-4 sm:grid-cols-[1.5fr_1fr_1.5fr_auto] sm:items-end">
              <Field label="Client name" htmlFor="name">
                <Input id="name" name="name" required minLength={2} maxLength={120} placeholder="Acme Pvt Ltd" />
              </Field>
              <Field label="Contact name" htmlFor="contactName">
                <Input id="contactName" name="contactName" maxLength={120} />
              </Field>
              <Field label="Contact email" htmlFor="contactEmail">
                <Input id="contactEmail" name="contactEmail" type="email" maxLength={254} />
              </Field>
              <SubmitButton pending="Adding…">Add client</SubmitButton>
            </ActionForm>
          </Card>
        )}
        <Card className="p-0">
          {clients.length === 0 ? (
            <p className="p-6 text-sm text-muted">{manage ? "No clients yet." : "No clients have been shared with you."}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-border text-xs uppercase tracking-wider text-muted">
                  <tr>
                    <th className="px-6 py-3 font-medium">Client</th>
                    <th className="px-6 py-3 font-medium">Contact</th>
                    <th className="px-6 py-3 font-medium">Websites</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {clients.map((c) => (
                    <tr key={c.id}>
                      <td className="px-6 py-3">
                        <Link href={`/w/${slug}/clients/${c.id}`} className="font-medium text-brand hover:underline">
                          {c.name}
                        </Link>
                        {c.status === "archived" && (
                          <span className="ml-2">
                            <Badge>Archived</Badge>
                          </span>
                        )}
                      </td>
                      <td className="px-6 py-3 text-muted">{[c.contactName, c.contactEmail].filter(Boolean).join(" · ") || "—"}</td>
                      <td className="px-6 py-3 text-muted">{c.websiteCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
