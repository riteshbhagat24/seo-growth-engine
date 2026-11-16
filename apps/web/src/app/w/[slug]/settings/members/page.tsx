import { notFound } from "next/navigation";
import {
  assignableRoles,
  can,
  canManageMember,
  listMembers,
  listPendingInvitations,
  ROLE_LABEL
} from "@sge/core";
import { ActionForm, SubmitButton } from "@/components/form";
import { Badge, Card, Field, Input, PageHeader, Select } from "@/components/ui";
import { db } from "@/lib/db";
import { currentActor, requireWorkspace } from "@/lib/session";
import {
  changeRoleAction,
  inviteAction,
  leaveWorkspaceAction,
  removeMemberAction,
  revokeInvitationAction,
  transferOwnershipAction
} from "../../actions";

const fmt = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

export default async function MembersPage({ params }: PageProps<"/w/[slug]/settings/members">) {
  const { slug } = await params;
  const [actor, access] = await Promise.all([currentActor(), requireWorkspace(slug)]);
  if (!can(access.role, "members.view")) notFound();
  const { workspace: ws, role } = access;
  const isAgency = ws.type === "agency";
  const manage = isAgency && can(role, "members.manage");

  const [members, invitations] = await Promise.all([
    listMembers(db(), actor, access),
    manage ? listPendingInvitations(db(), actor, access) : Promise.resolve([])
  ]);
  const grantable = assignableRoles(role).filter((r) => r !== "client");
  const others = members.filter((m) => m.membershipId !== access.membershipId && m.role !== "client");

  return (
    <>
      <PageHeader
        title="Members"
        description={isAgency ? "People with access to this workspace." : "Personal workspaces have a single member."}
      />
      <div className="flex flex-col gap-6">
        {manage && (
          <Card>
            <h2 className="mb-4 font-semibold">Invite someone</h2>
            <ActionForm action={inviteAction.bind(null, slug)} className="flex flex-col gap-4 sm:flex-row sm:items-end">
              <div className="flex-1">
                <Field label="Email" htmlFor="invite-email">
                  <Input id="invite-email" name="email" type="email" required placeholder="name@company.com" />
                </Field>
              </div>
              <Field label="Role" htmlFor="invite-role">
                <Select id="invite-role" name="role" defaultValue={grantable.includes("specialist") ? "specialist" : grantable[0]}>
                  {grantable.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABEL[r]}
                    </option>
                  ))}
                </Select>
              </Field>
              <SubmitButton pending="Sending…">Send invitation</SubmitButton>
            </ActionForm>
            <p className="mt-3 text-xs text-muted">Invitations expire after 7 days. They must be accepted with the same email address.</p>
          </Card>
        )}

        <Card className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border text-xs uppercase tracking-wider text-muted">
                <tr>
                  <th className="px-6 py-3 font-medium">Member</th>
                  <th className="px-6 py-3 font-medium">Role</th>
                  <th className="px-6 py-3 font-medium">Joined</th>
                  <th className="px-6 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {members.map((m) => {
                  const self = m.membershipId === access.membershipId;
                  const editable = manage && !self && canManageMember(role, m.role);
                  return (
                    <tr key={m.membershipId}>
                      <td className="px-6 py-3">
                        <div className="font-medium">
                          {m.name} {self && <span className="text-xs font-normal text-muted">(you)</span>}
                        </div>
                        <div className="text-xs text-muted">{m.email}</div>
                      </td>
                      <td className="px-6 py-3">
                        {editable ? (
                          <ActionForm action={changeRoleAction.bind(null, slug)} className="flex items-center gap-2">
                            <input type="hidden" name="membershipId" value={m.membershipId} />
                            <Select name="role" defaultValue={m.role} aria-label={`Role for ${m.name}`} className="h-8">
                              {grantable.map((r) => (
                                <option key={r} value={r}>
                                  {ROLE_LABEL[r]}
                                </option>
                              ))}
                            </Select>
                            <SubmitButton variant="secondary" className="h-8 px-3">
                              Save
                            </SubmitButton>
                          </ActionForm>
                        ) : (
                          <Badge>{ROLE_LABEL[m.role]}</Badge>
                        )}
                      </td>
                      <td className="px-6 py-3 text-muted">{fmt(m.joinedAt)}</td>
                      <td className="px-6 py-3 text-right">
                        {editable && (
                          <ActionForm action={removeMemberAction.bind(null, slug)} confirm={`Remove ${m.name} from ${ws.name}?`}>
                            <input type="hidden" name="membershipId" value={m.membershipId} />
                            <SubmitButton variant="danger" className="h-8 px-3">
                              Remove
                            </SubmitButton>
                          </ActionForm>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>

        {manage && invitations.length > 0 && (
          <Card>
            <h2 className="mb-4 font-semibold">Pending invitations</h2>
            <ul className="divide-y divide-border">
              {invitations.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
                  <span>
                    <span className="font-medium">{i.email}</span>
                    <span className="ml-2 text-muted">
                      {ROLE_LABEL[i.role]} · expires {fmt(i.expiresAt)}
                    </span>
                  </span>
                  <ActionForm action={revokeInvitationAction.bind(null, slug)}>
                    <input type="hidden" name="invitationId" value={i.id} />
                    <SubmitButton variant="ghost" className="h-8 px-3">
                      Revoke
                    </SubmitButton>
                  </ActionForm>
                </li>
              ))}
            </ul>
          </Card>
        )}

        {isAgency && role === "owner" && others.length > 0 && (
          <Card>
            <h2 className="font-semibold">Transfer ownership</h2>
            <p className="mt-1 mb-4 text-sm text-muted">The new owner gets full control. You'll become an admin.</p>
            <ActionForm
              action={transferOwnershipAction.bind(null, slug)}
              confirm="Transfer ownership? You will no longer be the owner of this workspace."
              className="flex flex-col gap-3 sm:flex-row sm:items-end"
            >
              <Field label="New owner" htmlFor="new-owner">
                <Select id="new-owner" name="membershipId">
                  {others.map((m) => (
                    <option key={m.membershipId} value={m.membershipId}>
                      {m.name} ({m.email})
                    </option>
                  ))}
                </Select>
              </Field>
              <SubmitButton variant="danger">Transfer</SubmitButton>
            </ActionForm>
          </Card>
        )}

        {isAgency && role !== "owner" && (
          <Card>
            <h2 className="font-semibold">Leave workspace</h2>
            <p className="mt-1 mb-4 text-sm text-muted">You'll lose access until someone invites you again.</p>
            <ActionForm action={leaveWorkspaceAction.bind(null, slug)} confirm={`Leave ${ws.name}?`}>
              <SubmitButton variant="danger">Leave {ws.name}</SubmitButton>
            </ActionForm>
          </Card>
        )}
      </div>
    </>
  );
}
