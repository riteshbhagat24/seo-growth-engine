import { and, eq, schema, type Db, type Tx } from "@sge/db";
import { audit } from "./audit";
import { inWorkspace, requireAction, type Actor, type WorkspaceAccess } from "./context";
import { AppError } from "./errors";
import { decryptSecret, encryptSecret, keyHint } from "./secrets";

const { integrations } = schema;

/** Providers that take a simple API key (OAuth providers arrive in M5). */
export type KeyProvider = "psi";

const aadFor = (organizationId: string, provider: string) => `${organizationId}:${provider}`;
const KEY_FORMAT = /^[A-Za-z0-9_-]{20,128}$/;

export interface IntegrationStatus {
  connected: boolean;
  keyHint: string | null;
  lastError: string | null;
  updatedAt: Date | null;
}

export async function getKeyIntegration(db: Db, actor: Actor, access: WorkspaceAccess, provider: KeyProvider): Promise<IntegrationStatus> {
  return inWorkspace(db, actor, access, async (tx) => {
    const [row] = await tx
      .select()
      .from(integrations)
      .where(and(eq(integrations.organizationId, access.workspace.id), eq(integrations.provider, provider)));
    return {
      connected: Boolean(row?.credentialsEnc && row.status === "active"),
      keyHint: row?.keyHint ?? null,
      lastError: row?.lastError ?? null,
      updatedAt: row?.updatedAt ?? null
    };
  });
}

export async function setApiKey(db: Db, actor: Actor, access: WorkspaceAccess, provider: KeyProvider, rawKey: string): Promise<void> {
  const key = rawKey.trim();
  if (!KEY_FORMAT.test(key)) throw new AppError("invalid_input", "That doesn't look like a Google API key");
  await inWorkspace(db, actor, access, async (tx, { role }) => {
    requireAction(role, "integrations.manage");
    const values = {
      credentialsEnc: encryptSecret(key, aadFor(access.workspace.id, provider)),
      keyHint: keyHint(key),
      status: "active",
      lastError: null,
      connectedByUserId: actor.userId,
      updatedAt: new Date()
    };
    await tx
      .insert(integrations)
      .values({ organizationId: access.workspace.id, provider, ...values })
      .onConflictDoUpdate({ target: [integrations.organizationId, integrations.provider], set: values });
    await audit(tx, {
      organizationId: access.workspace.id,
      actorUserId: actor.userId,
      action: "integration.key_set",
      entityType: "integration",
      metadata: { provider, keyHint: values.keyHint },
      ip: actor.ip,
      userAgent: actor.userAgent
    });
  });
}

export async function removeApiKey(db: Db, actor: Actor, access: WorkspaceAccess, provider: KeyProvider): Promise<void> {
  await inWorkspace(db, actor, access, async (tx, { role }) => {
    requireAction(role, "integrations.manage");
    await tx.delete(integrations).where(and(eq(integrations.organizationId, access.workspace.id), eq(integrations.provider, provider)));
    await audit(tx, {
      organizationId: access.workspace.id,
      actorUserId: actor.userId,
      action: "integration.key_removed",
      entityType: "integration",
      metadata: { provider },
      ip: actor.ip,
      userAgent: actor.userAgent
    });
  });
}

/** Decrypted key for background jobs (tenant transaction). Null if none or undecryptable. */
export async function workspaceApiKey(tx: Tx, organizationId: string, provider: KeyProvider): Promise<string | null> {
  const [row] = await tx
    .select()
    .from(integrations)
    .where(and(eq(integrations.organizationId, organizationId), eq(integrations.provider, provider), eq(integrations.status, "active")));
  if (!row?.credentialsEnc) return null;
  try {
    return decryptSecret(row.credentialsEnc, aadFor(organizationId, provider));
  } catch {
    return null;
  }
}

export async function recordIntegrationError(tx: Tx, organizationId: string, provider: KeyProvider, error: string | null): Promise<void> {
  await tx
    .update(integrations)
    .set({ lastError: error?.slice(0, 300) ?? null, updatedAt: new Date() })
    .where(and(eq(integrations.organizationId, organizationId), eq(integrations.provider, provider)));
}
