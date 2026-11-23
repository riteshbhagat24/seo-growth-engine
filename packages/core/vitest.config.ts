import { defineConfig } from "vitest/config";

// TEST_PG_HOST overrides the Postgres host:port (default: the Docker Compose port).
const PG = process.env.TEST_PG_HOST ?? "localhost:54329";

// Own database so it can run in parallel with @sge/db's suite.
// Set on process.env (not test.env) so globalSetup sees the same values.
process.env.TEST_DATABASE_URL_OWNER =
  process.env.CORE_TEST_DATABASE_URL_OWNER ?? `postgres://app_owner:app_owner@${PG}/sge_test_core`;
process.env.TEST_WORKER_DATABASE_URL = `postgres://worker_user:worker_user@${PG}/sge_test_core`;
process.env.TEST_DATABASE_URL =
  process.env.CORE_TEST_DATABASE_URL ?? `postgres://app_user:app_user@${PG}/sge_test_core`;

export default defineConfig({
  test: {
    globalSetup: ["../db/test/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 20_000
  }
});
