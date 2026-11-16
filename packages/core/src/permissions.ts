import type { MemberRole } from "@sge/db/schema";

export type Role = MemberRole;

export const ROLES: readonly Role[] = ["owner", "admin", "manager", "specialist", "viewer", "client"];

/** Higher = more privileged. Used for "may not grant above yourself" rules. */
export const ROLE_RANK: Record<Role, number> = {
  owner: 6,
  admin: 5,
  manager: 4,
  specialist: 3,
  viewer: 2,
  client: 1
};

export const ROLE_LABEL: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
  manager: "Manager",
  specialist: "Specialist",
  viewer: "Viewer",
  client: "Client"
};

/**
 * Permission matrix (docs/SECURITY.md §3). Single source of truth: the UI hides
 * what `can` denies, and every service re-checks it server-side.
 */
const MATRIX = {
  "workspace.view": ["owner", "admin", "manager", "specialist", "viewer", "client"],
  "workspace.update": ["owner", "admin"],
  "workspace.delete": ["owner"],
  "workspace.transfer": ["owner"],
  "branding.manage": ["owner", "admin", "manager"],
  "members.view": ["owner", "admin", "manager", "specialist", "viewer"],
  "members.manage": ["owner", "admin"],
  "audit.view": ["owner", "admin"],
  "plan.view": ["owner", "admin"],
  "plan.manage": ["owner"],
  "clients.manage": ["owner", "admin", "manager"],
  "websites.manage": ["owner", "admin", "manager"],
  "work.run": ["owner", "admin", "manager", "specialist"],
  "work.approve": ["owner", "admin", "manager"],
  "automation.enable": ["owner", "admin"],
  "integrations.manage": ["owner", "admin"],
  "apikeys.manage": ["owner", "admin"]
} as const satisfies Record<string, readonly Role[]>;

export type Action = keyof typeof MATRIX;
export const ACTIONS = Object.keys(MATRIX) as Action[];

export function can(role: Role, action: Action): boolean {
  return (MATRIX[action] as readonly Role[]).includes(role);
}

/** Roles that may be granted through invitations or role changes (never "owner"). */
export function assignableRoles(actor: Role): Role[] {
  if (!can(actor, "members.manage")) return [];
  return ROLES.filter((r) => r !== "owner" && ROLE_RANK[r] <= ROLE_RANK[actor]);
}

export function canAssignRole(actor: Role, target: Role): boolean {
  return assignableRoles(actor).includes(target);
}

/** May `actor` change or remove a member whose current role is `member`? */
export function canManageMember(actor: Role, member: Role): boolean {
  return can(actor, "members.manage") && member !== "owner" && ROLE_RANK[member] <= ROLE_RANK[actor];
}
