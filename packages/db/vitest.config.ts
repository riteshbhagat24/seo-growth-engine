import { defineConfig } from "vitest/config";

// Set on process.env (not test.env) so globalSetup sees the same values.
process.env.TEST_DATABASE_URL_OWNER ??= "postgres://app_owner:app_owner@localhost:54329/sge_test";
process.env.TEST_DATABASE_URL ??= "postgres://app_user:app_user@localhost:54329/sge_test";

export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    // Tests share one database; run files sequentially.
    fileParallelism: false,
    testTimeout: 20_000
  }
});
