import pg from "pg";
import { uuidv7 } from "uuidv7";
import { withContext, type Db, type Tx } from "@sge/db";

/**
 * Parameterised SQL inside a Drizzle transaction.
 *
 * The engine was written against plain SQL (`$1` placeholders). Rather than rewrite ~200 statements, it runs
 * them on the *same* pooled connection and transaction that `withContext()` / `inWorkspace()` opened, so the
 * transaction-local tenant settings (`app.org_id`, `app.client_scope`) and therefore RLS apply to every
 * statement exactly as they do to Drizzle queries. Counts (int8) and numerics come back as numbers.
 */
const TYPES = {
  getTypeParser(oid: number, format?: "text" | "binary") {
    if (oid === 20) return (v: string) => Number.parseInt(v, 10); // int8 (count(*))
    if (oid === 1700) return (v: string) => Number.parseFloat(v); // numeric
    return pg.types.getTypeParser(oid, format);
  }
};

interface QueryClient {
  query(cfg: { text: string; values: unknown[]; types: typeof TYPES }): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

/** The pg client Drizzle's node-postgres transaction runs on (drizzle-orm 0.45: `tx.session.client`). */
function clientOf(tx: Tx): QueryClient {
  const client = (tx as unknown as { session?: { client?: unknown } }).session?.client as QueryClient | undefined;
  if (!client || typeof client.query !== "function") throw new Error("SqlTx: could not reach the transaction's connection");
  return client;
}

export class SqlTx {
  private readonly client: QueryClient;
  constructor(
    /** The Drizzle transaction (for @sge/jobs, @sge/core helpers). */
    readonly tx: Tx,
    /** Workspace this transaction is scoped to. */
    readonly orgId: string
  ) {
    this.client = clientOf(tx);
  }

  async q<T = Record<string, any>>(text: string, params: unknown[] = []): Promise<T[]> {
    const r = await this.client.query({ text, values: params, types: TYPES });
    return r.rows as T[];
  }

  async one<T = Record<string, any>>(text: string, params: unknown[] = []): Promise<T> {
    const rows = await this.q<T>(text, params);
    if (rows.length !== 1) throw new NotFoundError(`Expected exactly one row, got ${rows.length}`);
    return rows[0]!;
  }

  async maybe<T = Record<string, any>>(text: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.q<T>(text, params);
    return rows[0] ?? null;
  }

  async exec(text: string, params: unknown[] = []): Promise<number> {
    const r = await this.client.query({ text, values: params, types: TYPES });
    return r.rowCount ?? 0;
  }
}

/** A row the caller expected isn't there (or isn't visible under RLS). */
export class NotFoundError extends Error {
  constructor(message = "Not found") {
    super(message);
    this.name = "NotFoundError";
  }
}

/**
 * Tenant transaction for background work: RLS scoped to `orgId`, all of its clients. Job handlers use this with
 * the organisation id from the job row (re-checked by RLS on every statement).
 */
export function tenant<T>(db: Db, orgId: string, fn: (tx: SqlTx) => Promise<T>): Promise<T> {
  return withContext(db, { organizationId: orgId, clientScope: "*" }, (tx) => fn(new SqlTx(tx, orgId)));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ActorType = "user" | "system" | "worker" | "cron";

/** Writes to the workspace audit log (same table and shape as @sge/core's audit()). */
export async function audit(
  tx: SqlTx,
  orgId: string,
  actorType: ActorType,
  actorId: string | null,
  action: string,
  subjectType: string,
  subjectId: string,
  data: unknown = {}
): Promise<void> {
  const userId = actorType === "user" && actorId && UUID.test(actorId) ? actorId : null;
  await tx.exec(
    `insert into audit_logs (id, organization_id, actor_user_id, action, entity_type, entity_id, metadata)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [uuidv7(), orgId, userId, action, subjectType, subjectId, JSON.stringify({ actor_type: actorType, actor_id: actorId, ...(data as object) })]
  );
}
