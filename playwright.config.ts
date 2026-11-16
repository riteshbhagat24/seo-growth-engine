import { defineConfig } from "@playwright/test";
import { readFileSync } from "node:fs";

/** Runs the real production bundle (standalone server) against the dev database + Mailpit. */
function loadEnv(file: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]!] = m[2]!.replace(/^"(.*)"$/, "$1");
  }
  return env;
}

const PORT = 3123;
export const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: BASE_URL, trace: "retain-on-failure" },
  webServer: {
    command: "node apps/web/.next/standalone/apps/web/server.js",
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { ...loadEnv("apps/web/.env.local"), NODE_ENV: "production", PORT: String(PORT), APP_URL: BASE_URL, HOSTNAME: "localhost" }
  }
});
