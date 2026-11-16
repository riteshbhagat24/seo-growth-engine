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

export interface DbContext {
  organizationId?: string;
  userId?: string;
  /** "*" = all clients in the org; otherwise the client ids this member may see. */
  clientScope?: "*" | string[];
  /** sha256 hex of an invitation token; reveals only that invitation. */
  inviteTokenHash?: string;
}

export interface TenantContext extends DbContext {
  organizationId: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;

export const isUuid = (v: string) => UUID_RE.test(v);

/**
 * Runs `fn` in a transaction with the given RLS context.
 *
 * Settings are transaction-local (`set_config(..., true)`), so they can never
 * leak to another request through a pooled connection. Callers must have
 * verified membership before passing an organizationId; RLS is the second
 * line of defence.
 */
export async function withContext<T>(db: Db, ctx: DbContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (ctx.organizationId !== undefined && !UUID_RE.test(ctx.organizationId))
    throw new Error("withContext: invalid organizationId");
  if (ctx.userId !== undefined && !UUID_RE.test(ctx.userId)) throw new Error("withContext: invalid userId");
  if (ctx.inviteTokenHash !== undefined && !SHA256_RE.test(ctx.inviteTokenHash))
    throw new Error("withContext: invalid inviteTokenHash");
  const scope = ctx.clientScope ?? "*";
  if (scope !== "*" && !scope.every((s) => UUID_RE.test(s))) throw new Error("withContext: invalid clientScope");
  const scopeValue = scope === "*" ? "*" : scope.join(",");

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.org_id', ${ctx.organizationId ?? ""}, true),
                 set_config('app.user_id', ${ctx.userId ?? ""}, true),
                 set_config('app.client_scope', ${scopeValue}, true),
                 set_config('app.invite_token', ${ctx.inviteTokenHash ?? ""}, true)`
    );
    return fn(tx);
  });
}

/** Switch the tenant inside an open transaction (e.g. right after joining a workspace). */
export async function setTenant(tx: Tx, organizationId: string): Promise<void> {
  if (!UUID_RE.test(organizationId)) throw new Error("setTenant: invalid organizationId");
  await tx.execute(sql`select set_config('app.org_id', ${organizationId}, true)`);
}

/** Tenant-scoped transaction. Equivalent to withContext with a required organizationId. */
export async function withTenant<T>(db: Db, ctx: TenantContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withContext(db, ctx, fn).catch((err: unknown) => {
    if (err instanceof Error) err.message = err.message.replace("withContext:", "withTenant:");
    throw err;
  });
}
