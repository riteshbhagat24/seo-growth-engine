import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import pg from "pg";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const pools = new Map<string, pg.Pool>();

/** One pool per connection string, reused across hot reloads and requests. */
export function getPool(connectionString: string): pg.Pool {
  const g = globalThis as unknown as { __sgePools?: Map<string, pg.Pool> };
  const store = (g.__sgePools ??= pools);
  let pool = store.get(connectionString);
  if (!pool) {
    pool = new pg.Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000 });
    store.set(connectionString, pool);
  }
  return pool;
}

export function createDb(connectionString: string): Db {
  return drizzle(getPool(connectionString), { schema });
}

export interface TenantContext {
  organizationId: string;
  userId?: string;
  /** "*" = all clients in the org; otherwise the client ids this member may see. */
  clientScope?: "*" | string[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs `fn` in a transaction where Postgres RLS sees the given tenant.
 *
 * Settings are transaction-local (`set_config(..., true)`), so they can never
 * leak to another request through a pooled connection. Callers must have
 * verified membership before calling this; RLS is the second line of defence.
 */
export async function withTenant<T>(db: Db, ctx: TenantContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!UUID_RE.test(ctx.organizationId)) throw new Error("withTenant: invalid organizationId");
  if (ctx.userId !== undefined && !UUID_RE.test(ctx.userId)) throw new Error("withTenant: invalid userId");
  const scope = ctx.clientScope ?? "*";
  if (scope !== "*" && !scope.every((s) => UUID_RE.test(s))) throw new Error("withTenant: invalid clientScope");
  const scopeValue = scope === "*" ? "*" : scope.join(",");

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.org_id', ${ctx.organizationId}, true),
                 set_config('app.user_id', ${ctx.userId ?? ""}, true),
                 set_config('app.client_scope', ${scopeValue}, true)`
    );
    return fn(tx);
  });
}
