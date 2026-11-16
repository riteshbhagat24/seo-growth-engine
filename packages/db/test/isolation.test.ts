import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { createDb, getPool, withTenant } from "../src/client";
import { organizations, websites } from "../src/schema";

const db = createDb(process.env.TEST_DATABASE_URL!);
const orgA = uuidv7();
const orgB = uuidv7();
let siteA = "";

beforeAll(async () => {
  for (const [id, slug] of [
    [orgA, "org-a"],
    [orgB, "org-b"]
  ] as const) {
    await withTenant(db, { organizationId: id }, (tx) =>
      tx.insert(organizations).values({ id, slug: `${slug}-${id.slice(-6)}`, name: slug, type: "agency" })
    );
  }
  const [row] = await withTenant(db, { organizationId: orgA }, (tx) =>
    tx.insert(websites).values({ organizationId: orgA, url: "https://a.example", domain: "a.example" }).returning()
  );
  siteA = row!.id;
  await withTenant(db, { organizationId: orgB }, (tx) =>
    tx.insert(websites).values({ organizationId: orgB, url: "https://b.example", domain: "b.example" })
  );
});

afterAll(() => getPool(process.env.TEST_DATABASE_URL!).end());

/** Drizzle wraps driver errors; the Postgres message is on `cause`. */
async function expectRlsViolation(p: Promise<unknown>) {
  const err = await p.then(
    () => null,
    (e: unknown) => e as { message?: string; cause?: { message?: string; code?: string } }
  );
  expect(err, "expected the query to be rejected").not.toBeNull();
  expect(err?.cause?.code ?? "").toBe("42501"); // insufficient_privilege
  expect(err?.cause?.message ?? err?.message).toMatch(/row-level security/);
}

describe("tenant isolation (RLS as app_user)", () => {
  it("a tenant sees only its own rows", async () => {
    const rows = await withTenant(db, { organizationId: orgB }, (tx) => tx.select().from(websites));
    expect(rows.map((r) => r.domain)).toEqual(["b.example"]);
    const orgs = await withTenant(db, { organizationId: orgB }, (tx) => tx.select().from(organizations));
    expect(orgs.map((o) => o.id)).toEqual([orgB]);
  });

  it("fails closed with no tenant context", async () => {
    expect(await db.select().from(websites)).toEqual([]);
    expect(await db.select().from(organizations)).toEqual([]);
  });

  it("cannot read another tenant's row by id", async () => {
    const rows = await withTenant(db, { organizationId: orgB }, (tx) =>
      tx.select().from(websites).where(eq(websites.id, siteA))
    );
    expect(rows).toEqual([]);
  });

  it("cannot update or delete another tenant's rows", async () => {
    const updated = await withTenant(db, { organizationId: orgB }, (tx) =>
      tx.update(websites).set({ displayName: "hijacked" }).where(eq(websites.id, siteA)).returning()
    );
    expect(updated).toEqual([]);
    const deleted = await withTenant(db, { organizationId: orgB }, (tx) =>
      tx.delete(websites).where(eq(websites.id, siteA)).returning()
    );
    expect(deleted).toEqual([]);
    const stillThere = await withTenant(db, { organizationId: orgA }, (tx) =>
      tx.select().from(websites).where(eq(websites.id, siteA))
    );
    expect(stillThere[0]?.displayName).toBeNull();
  });

  it("cannot insert a row into another tenant", async () => {
    await expectRlsViolation(
      withTenant(db, { organizationId: orgB }, (tx) =>
        tx.insert(websites).values({ organizationId: orgA, url: "https://x.example", domain: "x.example" })
      )
    );
  });

  it("cannot move a row to another tenant", async () => {
    await expectRlsViolation(
      withTenant(db, { organizationId: orgA }, (tx) =>
        tx.update(websites).set({ organizationId: orgB }).where(eq(websites.id, siteA))
      )
    );
  });

  it("tenant settings do not leak to the next use of a pooled connection", async () => {
    await withTenant(db, { organizationId: orgA }, async () => undefined);
    const pool = getPool(process.env.TEST_DATABASE_URL!);
    // Exhaust the pool's idle connections and check every one of them.
    const clients = await Promise.all(Array.from({ length: 5 }, () => pool.connect()));
    try {
      for (const c of clients) {
        const r = await c.query(`SELECT app_current_org() AS org, (SELECT count(*) FROM websites)::int AS n`);
        expect(r.rows[0]).toEqual({ org: null, n: 0 });
      }
    } finally {
      clients.forEach((c) => c.release());
    }
  });

  it("rejects malformed tenant ids before touching the database", async () => {
    await expect(withTenant(db, { organizationId: "x' OR 1=1 --" }, async () => 1)).rejects.toThrow(/invalid/);
  });

  it("app_user cannot disable RLS or run DDL", async () => {
    await expect(db.execute(sql`ALTER TABLE websites DISABLE ROW LEVEL SECURITY`)).rejects.toThrow();
    await expect(db.execute(sql`CREATE TABLE evil (id int)`)).rejects.toThrow();
  });
});
