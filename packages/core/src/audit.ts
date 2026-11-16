import { desc, eq, schema, type Tx } from "@sge/db";

export interface AuditEntry {
  organizationId: string | null;
  actorUserId: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
}

/** Writes inside the caller's transaction, so the audit row commits with the change. */
export async function audit(tx: Tx, entry: AuditEntry): Promise<void> {
  await tx.insert(schema.auditLogs).values({
    organizationId: entry.organizationId,
    actorUserId: entry.actorUserId,
    action: entry.action,
    entityType: entry.entityType ?? null,
    entityId: entry.entityId ?? null,
    metadata: entry.metadata ?? {},
    ip: entry.ip ?? null,
    userAgent: entry.userAgent?.slice(0, 500) ?? null
  });
}

export async function listAuditLogs(tx: Tx, organizationId: string, limit = 100) {
  return tx
    .select()
    .from(schema.auditLogs)
    .where(eq(schema.auditLogs.organizationId, organizationId))
    .orderBy(desc(schema.auditLogs.createdAt))
    .limit(Math.min(limit, 500));
}
