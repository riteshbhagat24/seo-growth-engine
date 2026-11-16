import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Applies migrations as the schema owner. Never run with the app_user URL. */
async function main() {
  const url = process.env.DATABASE_URL_OWNER;
  if (!url) throw new Error("DATABASE_URL_OWNER is required to run migrations");
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  const here = path.dirname(fileURLToPath(import.meta.url));
  try {
    await migrate(drizzle(pool), { migrationsFolder: path.join(here, "..", "migrations") });
    console.log("migrations applied");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
