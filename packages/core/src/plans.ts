import { and, eq, sql, schema, type Db, type Tx } from "@sge/db";
import type { LimitKey, Organization, PlanLimits } from "@sge/db/schema";
import { inWorkspace, requireAction, type Actor, type WorkspaceAccess } from "./context";
import { AppError } from "./errors";

const { plans, subscriptions, websites, clients, memberships, invitations } = schema;

/** -1 = unlimited. */
export const UNLIMITED = -1;

export const LIMIT_LABEL: Record<LimitKey, string> = {
  websites: "Websites",
  clients: "Clients",
  members: "Team members",
  pages_crawled_month: "Pages crawled / month",
  keywords: "Tracked keywords",
  backlinks_monitored: "Backlinks monitored",
  reports_month: "Reports / month",
  psi_runs_month: "Core Web Vitals tests / month"
};

/** Limits counted from existing rows; the rest are metered per calendar month. */
const STOCK: LimitKey[] = ["websites", "clients", "members", "keywords", "backlinks_monitored"];
export const METERED: LimitKey[] = ["pages_crawled_month", "reports_month", "psi_runs_month"];

export async function defaultPlanFor(tx: Tx, type: Organization["type"]): Promise<string> {
  const [p] = await tx
    .select({ id: plans.id })
    .from(plans)
    .where(and(eq(plans.isDefault, true), eq(plans.workspaceType, type)))
    .limit(1);
  if (!p) throw new Error(`No default plan configured for ${type} workspaces`);
  return p.id;
}

export interface PlanState {
  planId: string;
  planName: string;
  status: string;
  limits: PlanLimits;
}

/** Plan limits with per-workspace overrides applied. Requires tenant context. */
export async function planState(tx: Tx, organizationId: string): Promise<PlanState> {
  const [row] = await tx
    .select({ sub: subscriptions, plan: plans })
    .from(subscriptions)
    .innerJoin(plans, eq(plans.id, subscriptions.planId))
    .where(eq(subscriptions.organizationId, organizationId));
  if (!row) throw new Error("Workspace has no subscription");
  return {
    planId: row.plan.id,
    planName: row.plan.name,
    status: row.sub.status,
    limits: { ...row.plan.limits, ...row.sub.overrides }
  };
}

/** Counts across the whole workspace, regardless of the actor's client scope. */
async function stockUsage(tx: Tx, organizationId: string, key: LimitKey): Promise<number> {
  const prev = (await tx.execute<{ s: string | null }>(sql`select current_setting('app.client_scope', true) as s`)).rows[0]?.s ?? "";
  await tx.execute(sql`select set_config('app.client_scope', '*', true)`);
  try {
    const count = async (q: Promise<{ n: number }[]>) => (await q)[0]?.n ?? 0;
    switch (key) {
      case "websites":
        return count(tx.select({ n: sql<number>`count(*)::int` }).from(websites).where(eq(websites.organizationId, organizationId)));
      case "clients":
        return count(
          tx.select({ n: sql<number>`count(*)::int` }).from(clients).where(and(eq(clients.organizationId, organizationId), eq(clients.status, "active")))
        );
      case "members": {
        const m = await count(tx.select({ n: sql<number>`count(*)::int` }).from(memberships).where(eq(memberships.organizationId, organizationId)));
        const i = await count(
          tx
            .select({ n: sql<number>`count(*)::int` })
            .from(invitations)
            .where(and(eq(invitations.organizationId, organizationId), eq(invitations.status, "pending"), sql`${invitations.expiresAt} > now()`))
        );
        return m + i;
      }
      default:
        return 0; // keywords / backlinks: tables arrive in later milestones
    }
  } finally {
    await tx.execute(sql`select set_config('app.client_scope', ${prev}, true)`);
  }
}

/**
 * Throws if adding `adding` more of `key` would exceed the plan. Takes a
 * per-workspace, per-limit transaction lock so concurrent requests can't both
 * slip under the limit.
 */
export async function assertWithinLimit(tx: Tx, organizationId: string, key: LimitKey, adding = 1): Promise<void> {
  if (!STOCK.includes(key)) throw new Error(`${key} is metered; use consumeUsage`);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${organizationId}:${key}`}))`);
  const { limits, planName } = await planState(tx, organizationId);
  const limit = limits[key];
  if (limit === UNLIMITED) return;
  const used = await stockUsage(tx, organizationId, key);
  if (used + adding > limit)
    throw new AppError(
      "limit_reached",
      `Your ${planName} plan allows ${limit} ${LIMIT_LABEL[key].toLowerCase()}. Remove one or upgrade to add more.`
    );
}

/**
 * Atomically adds `amount` to this month's counter if it stays within the
 * plan; returns false (and changes nothing) otherwise.
 */
export async function consumeUsage(tx: Tx, organizationId: string, key: LimitKey, amount: number): Promise<boolean> {
  if (!METERED.includes(key)) throw new Error(`${key} is not metered`);
  if (!Number.isInteger(amount) || amount <= 0) throw new Error("amount must be a positive integer");
  const { limits } = await planState(tx, organizationId);
  const limit = limits[key];
  const r = await tx.execute<{ value: number }>(sql`
    insert into usage_counters (organization_id, metric, period_start, value)
    select ${organizationId}::uuid, ${key}::text, date_trunc('month', now())::date, ${amount}::bigint
    where ${limit}::bigint = -1 or ${amount}::bigint <= ${limit}::bigint
    on conflict (organization_id, metric, period_start) do update
      set value = usage_counters.value + excluded.value, updated_at = now()
      where ${limit}::bigint = -1 or usage_counters.value + excluded.value <= ${limit}::bigint
    returning value`);
  return r.rows.length === 1;
}

async function meteredUsage(tx: Tx, organizationId: string, key: LimitKey): Promise<number> {
  const r = await tx.execute<{ value: number | string }>(sql`
    select value from usage_counters
    where organization_id = ${organizationId} and metric = ${key} and period_start = date_trunc('month', now())::date`);
  return Number(r.rows[0]?.value ?? 0);
}

export interface UsageLine {
  key: LimitKey;
  label: string;
  used: number;
  limit: number;
  metered: boolean;
}

export async function usageSummary(db: Db, actor: Actor, access: WorkspaceAccess): Promise<PlanState & { lines: UsageLine[] }> {
  return inWorkspace(db, actor, access, async (tx, { role }) => {
    requireAction(role, "plan.view");
    const state = await planState(tx, access.workspace.id);
    const keys = Object.keys(LIMIT_LABEL) as LimitKey[];
    const lines: UsageLine[] = [];
    for (const key of keys) {
      const metered = METERED.includes(key);
      lines.push({
        key,
        label: LIMIT_LABEL[key],
        used: metered ? await meteredUsage(tx, access.workspace.id, key) : await stockUsage(tx, access.workspace.id, key),
        limit: state.limits[key],
        metered
      });
    }
    return { ...state, lines };
  });
}
