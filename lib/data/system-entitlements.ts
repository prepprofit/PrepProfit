import type { TenantClient } from '@/lib/db/tenant';
import type { PlanTier } from '@/lib/entitlements';
import { getMirroredPlan } from '@/lib/data/subscriptions';

/**
 * Cron-safe tier resolution for SYSTEM jobs (React Email migration).
 *
 * The request-time entitlement helpers in lib/entitlements.ts read Clerk live via
 * `auth().has()`, which is only valid inside an authenticated REQUEST — a Vercel
 * Cron run has no such context, so those helpers would fail closed to `starter`
 * for every org. This resolver instead reads the durable subscription MIRROR for a
 * given org, so a system job (e.g. deciding whether to enqueue an optional weekly
 * report) can classify an arbitrary org's plan.
 *
 * IMPORTANT: this is NOT a request-time entitlement source. The mirror never grants
 * access to a live request (RULE: gating reads Clerk). It is used only by background
 * jobs choosing whether to send optional outbound mail.
 *
 * Fail-closed order: a COMPED org → `business`; else the mirrored tier; else (no
 * mirror row yet) `starter`. MUST run inside `withOrg(orgId, …)` — {@link getMirroredPlan}
 * reads the RLS-scoped `subscriptions` row.
 */

/** Parse the operator comp allowlist fresh each call (mirrors lib/entitlements.ts). */
function compedOrgIds(): Set<string> {
  return new Set(
    (process.env.COMPED_ORG_IDS ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

export async function resolveSystemJobTier(
  db: TenantClient,
  organizationId: string,
): Promise<PlanTier> {
  if (compedOrgIds().has(organizationId)) return 'business';
  const mirrored = await getMirroredPlan(db, organizationId);
  return mirrored ?? 'starter';
}
