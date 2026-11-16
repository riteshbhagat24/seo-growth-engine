import "server-only";
import { createDb } from "@sge/db";
import { serverEnv } from "@sge/config";

/** Runtime database handle (app_user). Tenant data must go through withTenant(). */
export function db() {
  return createDb(serverEnv().DATABASE_URL);
}
