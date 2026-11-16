import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * Guards the tenancy invariants so a future migration can't silently weaken them.
 */
const owner = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL_OWNER, max: 1 });
afterAll(() => owner.end());

describe("schema tenancy invariants", () => {
  it("every public table has RLS enabled AND forced", async () => {
    const { rows } = await owner.query<{ table: string; enabled: boolean; forced: boolean }>(`
      SELECT c.relname AS table, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p')`);
    expect(rows.length).toBeGreaterThan(0);
    const weak = rows.filter((r) => !r.enabled || !r.forced).map((r) => r.table);
    expect(weak, `tables without forced RLS: ${weak.join(", ")}`).toEqual([]);
  });

  it("every table with organization_id has a tenant_isolation policy bound to app_current_org()", async () => {
    const { rows } = await owner.query<{ table: string; qual: string | null; check: string | null }>(`
      SELECT c.table_name AS table, p.qual, p.with_check AS check
      FROM information_schema.columns c
      LEFT JOIN pg_policies p
        ON p.schemaname = 'public' AND p.tablename = c.table_name AND p.policyname = 'tenant_isolation'
      WHERE c.table_schema = 'public' AND c.column_name = 'organization_id'`);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.qual, `${r.table} USING`).toContain("app_current_org()");
      expect(r.check, `${r.table} WITH CHECK`).toContain("app_current_org()");
    }
  });

  it("app_user cannot bypass RLS and owns nothing", async () => {
    const role = await owner.query(`SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'app_user'`);
    expect(role.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
    const owned = await owner.query(`
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND pg_get_userbyid(c.relowner) = 'app_user'`);
    expect(owned.rows).toEqual([]);
  });
});
