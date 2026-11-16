import { describe, expect, it } from "vitest";
import { ACTIONS, assignableRoles, can, canAssignRole, canManageMember, ROLES, type Action, type Role } from "../src/permissions";

// Expected matrix, written out independently of the implementation (docs/SECURITY.md §3).
const Y = true, N = false;
const EXPECTED: Record<Action, [owner: boolean, admin: boolean, manager: boolean, specialist: boolean, viewer: boolean, client: boolean]> = {
  "workspace.view":      [Y, Y, Y, Y, Y, Y],
  "workspace.update":    [Y, Y, N, N, N, N],
  "workspace.delete":    [Y, N, N, N, N, N],
  "workspace.transfer":  [Y, N, N, N, N, N],
  "branding.manage":     [Y, Y, Y, N, N, N],
  "members.view":        [Y, Y, Y, Y, Y, N],
  "members.manage":      [Y, Y, N, N, N, N],
  "audit.view":          [Y, Y, N, N, N, N],
  "plan.view":           [Y, Y, N, N, N, N],
  "plan.manage":         [Y, N, N, N, N, N],
  "clients.manage":      [Y, Y, Y, N, N, N],
  "websites.manage":     [Y, Y, Y, N, N, N],
  "work.run":            [Y, Y, Y, Y, N, N],
  "work.approve":        [Y, Y, Y, N, N, N],
  "automation.enable":   [Y, Y, N, N, N, N],
  "integrations.manage": [Y, Y, N, N, N, N],
  "apikeys.manage":      [Y, Y, N, N, N, N]
};

describe("permission matrix", () => {
  it("covers exactly the documented actions", () => {
    expect([...ACTIONS].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const action of ACTIONS) {
    ROLES.forEach((role, i) => {
      it(`${role} ${EXPECTED[action][i] ? "can" : "cannot"} ${action}`, () => {
        expect(can(role, action)).toBe(EXPECTED[action][i]);
      });
    });
  }
});

describe("role assignment", () => {
  it("nobody can grant owner", () => {
    for (const r of ROLES) expect(canAssignRole(r, "owner")).toBe(false);
  });

  it("admins may grant up to admin, never above", () => {
    expect(assignableRoles("admin")).toEqual(["admin", "manager", "specialist", "viewer", "client"]);
  });

  it("non-managers can grant nothing", () => {
    for (const r of ["manager", "specialist", "viewer", "client"] as Role[]) expect(assignableRoles(r)).toEqual([]);
  });

  it("the owner can't be managed by anyone", () => {
    for (const r of ROLES) expect(canManageMember(r, "owner")).toBe(false);
  });

  it("admins manage admins and below; managers manage no one", () => {
    expect(canManageMember("admin", "admin")).toBe(true);
    expect(canManageMember("admin", "viewer")).toBe(true);
    expect(canManageMember("manager", "viewer")).toBe(false);
  });
});
