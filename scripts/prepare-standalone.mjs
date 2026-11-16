// Copies static assets into the standalone bundle so `node server.js` serves
// CSS/JS/images. Required after every `next build` (also for cPanel deploys).
import { cpSync, existsSync } from "node:fs";
import path from "node:path";

const web = path.resolve("apps/web");
const out = path.join(web, ".next/standalone/apps/web");
if (!existsSync(out)) throw new Error("Run `pnpm --filter @sge/web build` first");
cpSync(path.join(web, ".next/static"), path.join(out, ".next/static"), { recursive: true });
if (existsSync(path.join(web, "public"))) cpSync(path.join(web, "public"), path.join(out, "public"), { recursive: true });
console.log("standalone bundle ready:", path.relative(process.cwd(), out));
