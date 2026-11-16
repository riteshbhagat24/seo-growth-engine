import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Rebuilds the test database from migrations before the suite runs. */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL_OWNER ?? "postgres://app_owner:app_owner@localhost:54329/sge_test";
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
    await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await pool.query("CREATE SCHEMA public");
    const here = path.dirname(fileURLToPath(import.meta.url));
    await migrate(drizzle(pool), { migrationsFolder: path.join(here, "..", "migrations") });
  } finally {
    await pool.end();
  }
}
