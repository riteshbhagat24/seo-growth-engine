// Creates local env files from .env.example with freshly generated secrets.
// Never overwrites an existing file. Local development and CI only.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const template = readFileSync(".env.example", "utf8")
  .replace(/^BETTER_AUTH_SECRET=$/m, `BETTER_AUTH_SECRET=${randomBytes(32).toString("base64url")}`)
  .replace(/^ENCRYPTION_KEY=$/m, `ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`)
  .replace(/^CRON_SECRET=$/m, `CRON_SECRET=${randomBytes(24).toString("base64url")}`);

for (const file of [".env", "apps/web/.env.local", "apps/worker/.env", "packages/db/.env"]) {
  if (existsSync(file)) {
    console.log(`kept     ${file}`);
    continue;
  }
  writeFileSync(file, template);
  console.log(`created  ${file}`);
}
