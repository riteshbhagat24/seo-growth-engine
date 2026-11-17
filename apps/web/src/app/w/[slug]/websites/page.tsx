import Link from "next/link";
import { can, latestAuditScores, listClients, listWebsites } from "@sge/core";
import { scoreTone } from "@/components/audit-ui";
import { ActionForm, SubmitButton } from "@/components/form";
import { Card, Field, Input, PageHeader, Select } from "@/components/ui";
import { VerificationBadge } from "@/components/verification-badge";
import { db } from "@/lib/db";
import { currentActor, requireWorkspace } from "@/lib/session";
import { addWebsiteAction } from "./actions";

export default async function WebsitesPage({ params, searchParams }: PageProps<"/w/[slug]/websites">) {
  const { slug } = await params;
  const sp = await searchParams;
  const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
  const isAgency = access.workspace.type === "agency";
  const manage = can(access.role, "websites.manage");
  const [rows, clients, scores] = await Promise.all([
    listWebsites(db(), actor, access),
    isAgency ? listClients(db(), actor, access) : Promise.resolve([]),
    latestAuditScores(db(), actor, access)
  ]);
  const preselect = typeof sp.client === "string" ? sp.client : "";

  return (
    <>
      <PageHeader
        title="Websites"
        description={manage ? "Add the sites you manage, then verify ownership to unlock audits and outreach." : "Websites you have access to."}
      />
      <div className="flex flex-col gap-6">
        {manage && (
          <Card>
            <h2 className="mb-4 font-semibold">Add a website</h2>
            <ActionForm action={addWebsiteAction.bind(null, slug)} className="grid gap-4 sm:grid-cols-[2fr_1.5fr_1.5fr_auto] sm:items-end">
              <Field label="Website address" htmlFor="url">
                <Input id="url" name="url" required placeholder="example.com" autoComplete="url" />
              </Field>
              <Field label="Display name (optional)" htmlFor="displayName">
                <Input id="displayName" name="displayName" maxLength={120} placeholder="Main site" />
              </Field>
              {isAgency ? (
                <Field label="Client" htmlFor="clientId">
                  <Select id="clientId" name="clientId" defaultValue={preselect} required={!access.allClients}>
                    {access.allClients && <option value="">No client (agency site)</option>}
                    {clients.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : (
                <span className="hidden sm:block" />
              )}
              <SubmitButton pending="Adding…">Add website</SubmitButton>
            </ActionForm>
          </Card>
        )}

        <Card className="p-0">
          {rows.length === 0 ? (
            <p className="p-6 text-sm text-muted">{manage ? "No websites yet. Add your first one above." : "No websites have been shared with you yet."}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-border text-xs uppercase tracking-wider text-muted">
                  <tr>
                    <th className="px-6 py-3 font-medium">Website</th>
                    {isAgency && <th className="px-6 py-3 font-medium">Client</th>}
                    <th className="px-6 py-3 font-medium">Ownership</th>
                    <th className="px-6 py-3 text-right font-medium">Health</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map(({ website: w, clientName }) => (
                    <tr key={w.id}>
                      <td className="px-6 py-3">
                        <Link href={`/w/${slug}/websites/${w.id}`} className="font-medium text-brand hover:underline">
                          {w.displayName ?? w.domain}
                        </Link>
                        <div className="text-xs text-muted">{w.url}</div>
                      </td>
                      {isAgency && <td className="px-6 py-3 text-muted">{clientName ?? "Agency"}</td>}
                      <td className="px-6 py-3">
                        <VerificationBadge status={w.verificationStatus} />
                      </td>
                      <td className={`px-6 py-3 text-right font-semibold tabular-nums ${scoreTone(scores.get(w.id)?.healthScore ?? null)}`}>
                        {scores.get(w.id)?.healthScore ?? <span className="font-normal text-muted">—</span>}
                      </td>
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
