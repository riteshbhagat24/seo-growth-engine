import { Bot, Globe } from "lucide-react";
import { backlinkCatalogue, getAutomation, listSources, SOURCE_TYPES, WORKSPACE_PERMISSIONS } from "@sge/backlinks";
import { can } from "@sge/core";
import { ActionForm, SubmitButton } from "@/components/form";
import { Alert, Badge, Card, CardHeader, Field, Input, Select, Textarea } from "@/components/ui";
import { db } from "@/lib/db";
import { currentActor, requireWorkspace } from "@/lib/session";
import { automationAction, saveSourceAction } from "../actions";
import { SafeLink } from "../ui";

const MODES = [
  ["supervised", "Supervised: every submission is approved by a person (default)"],
  ["manual", "Manual: prepare everything; a person submits"],
  ["autopilot", "Autopilot: only for destinations that explicitly permit automation and are ticked below"]
] as const;

export default async function BacklinkSettingsPage({ params }: PageProps<"/w/[slug]/websites/[websiteId]/backlinks/settings">) {
  const { slug, websiteId } = await params;
  const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
  const [automation, sources] = await Promise.all([getAutomation(db(), actor, access, websiteId), listSources(db(), actor, access)]);
  const { adapters } = backlinkCatalogue();
  const canEnable = can(access.role, "automation.enable");
  const canRun = can(access.role, "work.run");
  const own = sources.filter((s) => s.organization_id);
  const catalogue = sources.filter((s) => !s.organization_id);

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader icon={<Bot className="size-4" />} title="Automation mode" description="Owners and admins can change this. Enabling autopilot needs a recorded reason." />
        <ActionForm action={automationAction.bind(null, slug, websiteId)} className="flex flex-col gap-4">
          <fieldset disabled={!canEnable} className="contents">
            <div className="flex flex-col gap-2">
              {MODES.map(([v, l]) => (
                <label key={v} className="flex items-start gap-2 text-sm">
                  <input type="radio" name="mode" value={v} defaultChecked={automation.mode === v} className="mt-1 accent-[var(--brand)]" />
                  {l}
                </label>
              ))}
            </div>
            <div>
              <div className="mb-1 text-sm font-medium">Destinations allowed on autopilot</div>
              {automation.eligibleSources.length === 0 ? (
                <p className="text-sm text-muted">None. A destination qualifies only with explicit permission (or as your own verified property).</p>
              ) : (
                automation.eligibleSources.map((s) => (
                  <label key={s.id} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" name="source" value={s.id} defaultChecked={automation.autopilotSourceIds.includes(s.id)} className="accent-[var(--brand)]" />
                    {s.name} <span className="text-muted">({s.domain} · {s.automation_permission.replace(/_/g, " ")})</span>
                  </label>
                ))
              )}
            </div>
            <Field label="Permission note" htmlFor="note" hint="Who allowed autopilot for this website, and why">
              <Input id="note" name="note" defaultValue={automation.note ?? ""} />
            </Field>
            {canEnable && (
              <div>
                <SubmitButton>Save</SubmitButton>
              </div>
            )}
          </fieldset>
        </ActionForm>
      </Card>

      {canRun && (
        <Card>
          <CardHeader icon={<Globe className="size-4" />} title="Add a destination" description="Your own list of directories and partners, on top of the catalogue. Permission other than manual needs an owner or admin." />
          <ActionForm action={saveSourceAction.bind(null, slug, websiteId)} className="grid gap-4 md:grid-cols-2">
            <Field label="Name" htmlFor="s_name">
              <Input id="s_name" name="name" required />
            </Field>
            <Field label="Homepage" htmlFor="homepage_url">
              <Input id="homepage_url" name="homepage_url" type="url" required />
            </Field>
            <Field label="Submission page" htmlFor="submission_url">
              <Input id="submission_url" name="submission_url" type="url" />
            </Field>
            <Field label="Type" htmlFor="source_type">
              <Select id="source_type" name="source_type" defaultValue="industry_directory">
                {SOURCE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t.replace(/_/g, " ")}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="How to submit" htmlFor="adapter_key">
              <Select id="adapter_key" name="adapter_key" defaultValue="manual-editorial">
                {adapters.map((a) => (
                  <option key={a.key} value={a.key}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Permission" htmlFor="permission">
              <Select id="permission" name="permission" defaultValue="manual_only">
                {WORKSPACE_PERMISSIONS.map((p) => (
                  <option key={p} value={p}>
                    {p.replace(/_/g, " ")}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="md:col-span-2">
              <Field label="Permission note" htmlFor="permission_note" hint="Required for anything beyond manual: who granted permission and on what basis">
                <Textarea id="permission_note" name="permission_note" rows={2} />
              </Field>
            </div>
            <Field label="API endpoint (Listing API)" htmlFor="api_endpoint">
              <Input id="api_endpoint" name="api_endpoint" type="url" />
            </Field>
            <Field label="API username (WordPress)" htmlFor="api_username">
              <Input id="api_username" name="api_username" />
            </Field>
            <Field label="Token or application password" htmlFor="secret" hint="Stored encrypted; only the last 4 characters are ever shown">
              <Input id="secret" name="secret" type="password" autoComplete="off" />
            </Field>
            <label className="flex items-center gap-2 self-end text-sm">
              <input type="checkbox" name="terms_accepted" className="accent-[var(--brand)]" />I read and accept this destination&apos;s terms
            </label>
            <div className="md:col-span-2">
              <SubmitButton>Save destination</SubmitButton>
            </div>
          </ActionForm>
        </Card>
      )}

      <Card className="p-0 sm:p-0">
        <div className="p-6 pb-3">
          <CardHeader title="Destinations" description={`${own.length} added by this workspace · ${catalogue.length} in the curated catalogue (manual submission only; none permits automation).`} />
        </div>
        <div className="max-h-[480px] overflow-auto">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 border-y border-border bg-surface text-xs uppercase tracking-wider text-muted">
              <tr>
                <th className="px-6 py-3 font-medium">Destination</th>
                <th className="px-6 py-3 font-medium">Type</th>
                <th className="px-6 py-3 font-medium">Method</th>
                <th className="px-6 py-3 font-medium">Permission</th>
                <th className="px-6 py-3 font-medium">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {[...own, ...catalogue].map((s) => (
                <tr key={s.id} className={s.curation_status === "retired" ? "opacity-60" : undefined}>
                  <td className="px-6 py-2">
                    <div className="font-medium">
                      {s.name} {s.organization_id && <Badge tone="brand">yours</Badge>} {s.curation_status === "retired" && <Badge>retired</Badge>}
                    </div>
                    <SafeLink href={s.homepage_url}>{s.domain}</SafeLink>
                  </td>
                  <td className="px-6 py-2 text-muted">{s.source_type.replace(/_/g, " ")}</td>
                  <td className="px-6 py-2 text-muted">{s.adapter_key}</td>
                  <td className="px-6 py-2">
                    {s.automation_permission.replace(/_/g, " ")}
                    {s.credentials_hint && <div className="text-xs text-subtle">credentials {s.credentials_hint}</div>}
                  </td>
                  <td className="max-w-[360px] px-6 py-2 text-xs text-muted">{s.notes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <CardHeader title="Submission methods" description="A destination counts as supported for automation only when its method is implemented and tested." />
        <Alert tone="info">No third-party website has been submitted to automatically. Automated methods are tested end to end against the project&apos;s own test directory.</Alert>
        <ul className="mt-3 space-y-2 text-sm">
          {adapters.map((a) => (
            <li key={a.key}>
              <span className="font-medium">{a.name}</span> <Badge tone={a.testStatus === "live_tested" ? "success" : a.testStatus === "contract_tested" ? "brand" : "warning"}>{a.testStatus.replace(/_/g, " ")}</Badge>{" "}
              {a.supportsAutopilot ? <Badge>autopilot-capable</Badge> : <Badge>always supervised</Badge>}
              <div className="text-muted">{a.description}</div>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
