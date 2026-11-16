import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    // Tests share one database; run files sequentially.
    fileParallelism: false,
    testTimeout: 20_000,
    env: {
      TEST_DATABASE_URL_OWNER:
        process.env.TEST_DATABASE_URL_OWNER ?? "postgres://app_owner:app_owner@localhost:54329/sge_test",
      TEST_DATABASE_URL:
        process.env.TEST_DATABASE_URL ?? "postgres://app_user:app_user@localhost:54329/sge_test"
    }
  }
});
