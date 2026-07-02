import { eq, sql } from 'drizzle-orm';
import { subscriptions } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';
import type { PlanTier } from '@/lib/entitlements';

/**
 * Subscription mirror data layer (Sprint 4c). Pure helpers that translate a
 * verified Clerk billing webhook payload into the resolved state we store, plus a
 * single idempotent, order-safe upsert.
 *
 * Reminder (lib/db/schema.ts): this mirror NEVER grants access — entitlement
 * gating reads Clerk live via `auth().has()` (lib/entitlements.ts, fail-closed).
 * So these helpers only need to be faithful for DISPLAY/observability, not to be
 * the authority on what a request may do.
 */

/**
 * Map a Clerk plan slug (configured in clerk/billing.json) to our PlanTier.
 * Unknown / free / null slugs collapse to `starter` — the safe baseline tier.
 */
export function planSlugToTier(slug: string | null | undefined): PlanTier {
  switch (slug) {
    case 'business':
      return 'business';
    case 'pro':
      return 'pro';
    case 'solo':
      return 'solo';
    // 'free_org' and anything unrecognized → the baseline.
    default:
      return 'starter';
  }
}

/** Rank used to pick the HIGHEST active tier when a subscription has many items. */
const TIER_RANK: Record<PlanTier, number> = {
  starter: 0,
  solo: 1,
  pro: 2,
  business: 3,
};

/**
 * Compare two plan tiers by rank: negative if `a` is lower than `b`, positive if
 * higher, 0 if equal. Used by the billing webhook to classify a subscription change
 * as an upgrade vs a downgrade (which drives which notification email is sent).
 */
export function comparePlanTiers(a: PlanTier, b: PlanTier): number {
  return TIER_RANK[a] - TIER_RANK[b];
}

/** Which billing-lifecycle email a plan change should trigger (null = stay quiet). */
export type PlanChangeKind = 'subscribed' | 'upgraded' | 'downgraded';

/**
 * Classify a plan change for the billing email. Returns the email kind, or null
 * when the tier did not change (e.g. a renewal) so we stay quiet. A move up from
 * no/free plan is "subscribed"; up from a paid plan is "upgraded"; any move down
 * (including a cancellation back to free) is "downgraded".
 */
export function classifyPlanChange(
  oldPlan: PlanTier | null,
  newPlan: PlanTier,
): PlanChangeKind | null {
  const previous: PlanTier = oldPlan ?? 'starter';
  const delta = comparePlanTiers(newPlan, previous);
  if (delta === 0) return null;
  if (delta > 0) return previous === 'starter' ? 'subscribed' : 'upgraded';
  return 'downgraded';
}

/**
 * Item statuses that mean the org is CURRENTLY on that item's plan. `past_due`
 * counts (they keep the plan, in arrears, until it actually ends/cancels);
 * `upcoming`/`ended`/`canceled`/`abandoned`/`incomplete`/`expired` do not.
 */
const CURRENT_ITEM_STATUSES = new Set(['active', 'past_due']);

/** Minimal shape the route adapts a Clerk `subscription_items` entry into. */
export type SubscriptionItemInput = {
  /** Clerk subscription-item status. */
  status: string;
  /** Plan slug (`pro` / `business` / `free_org` / …); null when absent. */
  planSlug: string | null;
  /** Period end as epoch milliseconds (Clerk timestamps are ms); null if unknown. */
  periodEnd: number | null;
};

/**
 * The highest tier among the subscription's CURRENT items. No current paid item
 * → `starter`. Picking the max keeps a multi-item subscription on its best plan.
 */
export function resolvePlanTier(items: SubscriptionItemInput[]): PlanTier {
  let best: PlanTier = 'starter';
  for (const item of items) {
    if (!CURRENT_ITEM_STATUSES.has(item.status)) continue;
    const tier = planSlugToTier(item.planSlug);
    if (TIER_RANK[tier] > TIER_RANK[best]) best = tier;
  }
  return best;
}

/**
 * The latest period end among CURRENT items, as a Date (or null if none carry
 * one). Used only for display on `/billing`.
 */
export function resolveCurrentPeriodEnd(
  items: SubscriptionItemInput[],
): Date | null {
  let latest: number | null = null;
  for (const item of items) {
    if (!CURRENT_ITEM_STATUSES.has(item.status)) continue;
    if (item.periodEnd != null && (latest == null || item.periodEnd > latest)) {
      latest = item.periodEnd;
    }
  }
  return latest == null ? null : new Date(latest);
}

/** Resolved state for one org, ready to persist. */
export type SubscriptionMirrorInput = {
  plan: PlanTier;
  /** Raw Clerk subscription status. */
  status: string;
  clerkSubscriptionId: string | null;
  currentPeriodEnd: Date | null;
  /** Webhook event type that produced this state (e.g. 'subscription.active'). */
  eventType: string;
  /** The source event's own timestamp — drives the out-of-order guard. */
  eventAt: Date;
};

/**
 * Upsert the org's mirror row. MUST run inside `withOrg(orgId, …)` so RLS scopes
 * it. Idempotent and ORDER-SAFE: on conflict it only overwrites when the stored
 * `last_event_at` is at or before the incoming event's timestamp, so a late /
 * out-of-order Svix delivery can never roll a newer state back to an older one.
 */
export async function upsertSubscriptionMirror(
  db: TenantClient,
  organizationId: string,
  input: SubscriptionMirrorInput,
): Promise<void> {
  const row = {
    plan: input.plan,
    status: input.status,
    clerkSubscriptionId: input.clerkSubscriptionId,
    currentPeriodEnd: input.currentPeriodEnd,
    lastEventType: input.eventType,
    lastEventAt: input.eventAt,
  };
  await db
    .insert(subscriptions)
    .values({ organizationId, ...row })
    .onConflictDoUpdate({
      target: subscriptions.organizationId,
      set: row,
      // Only advance the row when the incoming event is newer-or-equal.
      setWhere: sql`${subscriptions.lastEventAt} <= ${input.eventAt}`,
    });
}

/**
 * The org's currently-mirrored plan tier, or `null` if no mirror row exists yet.
 * Read INSIDE `withOrg(orgId, …)` BEFORE an upsert so the billing webhook can
 * compare the old plan against the incoming one (upgrade vs downgrade). Never
 * gates access — display/notification use only.
 */
export async function getMirroredPlan(
  db: TenantClient,
  organizationId: string,
): Promise<PlanTier | null> {
  const rows = await db
    .select({ plan: subscriptions.plan })
    .from(subscriptions)
    .where(eq(subscriptions.organizationId, organizationId))
    .limit(1);
  // The mirror only ever stores a resolved PlanTier (upsertSubscriptionMirror), so
  // narrowing the untyped text column here is safe.
  return (rows[0]?.plan as PlanTier | undefined) ?? null;
}
