import { defineConfig } from "vitest/config";

// TEST_PG_HOST overrides the Postgres host:port (default: the Docker Compose port).
const PG = process.env.TEST_PG_HOST ?? "localhost:54329";

// Set on process.env (not test.env) so globalSetup sees the same values.
process.env.TEST_DATABASE_URL_OWNER ??= `postgres://app_owner:app_owner@${PG}/sge_test`;
process.env.TEST_DATABASE_URL ??= `postgres://app_user:app_user@${PG}/sge_test`;

export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    // Tests share one database; run files sequentially.
    fileParallelism: false,
    testTimeout: 20_000
  }
});
