import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
  schemaFilter: ["public", "auth"],
  dbCredentials: { url: process.env.DATABASE_URL_OWNER ?? "" },
  strict: true
});
