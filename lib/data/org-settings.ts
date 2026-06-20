import { eq, isNull } from 'drizzle-orm';
import { organizationSettings } from '@/lib/db/schema';
import type { MeasurementSystem, OrganizationSettings } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';
import { getOrgId } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import type { OrgSettingsInput } from '@/lib/validation/org-settings';

/**
 * Access to `organization_settings` is ALWAYS scoped by `organizationId`
 * (application layer, primary defense); RLS is the second layer. See
 * lib/data/ingredients.ts for the shared pattern.
 */

/**
 * The values the rest of the app reads: currency + measurement system, plus the
 * optional seller identity used by generated documents (Sprint 3.5A). Seller
 * fields are null until the org fills them in `/settings`.
 */
export type OrgSettingsValues = {
  currency: string;
  measurementSystem: MeasurementSystem;
  businessName: string | null;
  businessAddress: string | null;
  businessTaxId: string | null;
  businessEmail: string | null;
  businessLogoUrl: string | null;
  /** Set-once onboarding completion marker (Sprint 4d); null = not onboarded. */
  onboardedAt: Date | null;
};

/** Used until the org saves its own settings. */
export const DEFAULT_ORG_SETTINGS: OrgSettingsValues = {
  currency: 'EUR',
  measurementSystem: 'metric',
  businessName: null,
  businessAddress: null,
  businessTaxId: null,
  businessEmail: null,
  businessLogoUrl: null,
  onboardedAt: null,
};

export async function getOrgSettingsRow(
  db: TenantClient,
  organizationId: string,
): Promise<OrganizationSettings | null> {
  const rows = await db
    .select()
    .from(organizationSettings)
    .where(eq(organizationSettings.organizationId, organizationId))
    .limit(1);
  return rows[0] ?? null;
}

export async function upsertOrgSettings(
  db: TenantClient,
  organizationId: string,
  input: OrgSettingsInput,
): Promise<OrganizationSettings> {
  const [row] = await db
    .insert(organizationSettings)
    .values({ organizationId, ...input })
    .onConflictDoUpdate({
      target: organizationSettings.organizationId,
      // `$onUpdate` only fires on Drizzle .update(), not on upsert — stamp it here.
      set: { ...input, updatedAt: new Date() },
    })
    .returning();
  if (!row) throw new Error('Failed to save organization settings.');
  return row;
}

/**
 * Ensures a settings row exists for a freshly-created org (Sprint 4d), seeded
 * with the DB column defaults (currency/measurement system). Idempotent via
 * `ON CONFLICT DO NOTHING`, so it never clobbers an org that already saved
 * settings. Called eagerly from the `organization.created` webhook; the rest of
 * the app tolerates a missing row (it falls back to {@link DEFAULT_ORG_SETTINGS})
 * so this is a priming convenience, not a correctness requirement. Must run
 * inside `withOrg` (RLS GUC set there).
 */
export async function ensureOrgSettingsRow(
  db: TenantClient,
  organizationId: string,
): Promise<void> {
  await db
    .insert(organizationSettings)
    .values({ organizationId })
    .onConflictDoNothing({ target: organizationSettings.organizationId });
}

/**
 * Marks the org's onboarding as complete (Sprint 4d) — SET ONCE. Creates the
 * settings row with DB defaults if none exists yet (a brand-new org that never
 * touched `/settings`), otherwise stamps `onboarded_at` only while it is still
 * NULL (`setWhere`), so re-running never overwrites the original timestamp or
 * disturbs the seller identity. Must run inside `withOrg` (RLS GUC set there).
 */
export async function markOnboarded(
  db: TenantClient,
  organizationId: string,
): Promise<void> {
  await db
    .insert(organizationSettings)
    .values({ organizationId, onboardedAt: new Date() })
    .onConflictDoUpdate({
      target: organizationSettings.organizationId,
      set: { onboardedAt: new Date(), updatedAt: new Date() },
      setWhere: isNull(organizationSettings.onboardedAt),
    });
}

/** A pending GDPR deletion request's state (Sprint 5e); all null = none pending. */
export type AccountDeletionState = {
  requestedAt: Date | null;
  requestedBy: string | null;
  reason: string | null;
};

/** Read the pending-deletion fields off a settings row (null row = no request). */
export function readAccountDeletionState(
  row: OrganizationSettings | null,
): AccountDeletionState {
  return {
    requestedAt: row?.deletionRequestedAt ?? null,
    requestedBy: row?.deletionRequestedBy ?? null,
    reason: row?.deletionReason ?? null,
  };
}

/**
 * Records a manager's request to erase the org's data (Sprint 5e). This ONLY marks
 * the request — it deletes nothing; org self-delete is disabled in Clerk (Sprint
 * 4e) and an operator fulfils erasure out-of-band. Upserts so a brand-new org with
 * no settings row still works; re-requesting refreshes the timestamp/reason. Must
 * run inside `withOrg`.
 */
export async function requestAccountDeletion(
  db: TenantClient,
  organizationId: string,
  params: { userId: string | null; reason: string | null },
): Promise<void> {
  const now = new Date();
  await db
    .insert(organizationSettings)
    .values({
      organizationId,
      deletionRequestedAt: now,
      deletionRequestedBy: params.userId,
      deletionReason: params.reason,
    })
    .onConflictDoUpdate({
      target: organizationSettings.organizationId,
      set: {
        deletionRequestedAt: now,
        deletionRequestedBy: params.userId,
        deletionReason: params.reason,
        updatedAt: now,
      },
    });
}

/** Clears a pending deletion request (Sprint 5e). Must run inside `withOrg`. */
export async function cancelAccountDeletion(
  db: TenantClient,
  organizationId: string,
): Promise<void> {
  await db
    .update(organizationSettings)
    .set({
      deletionRequestedAt: null,
      deletionRequestedBy: null,
      deletionReason: null,
      updatedAt: new Date(),
    })
    .where(eq(organizationSettings.organizationId, organizationId));
}

/**
 * Server convenience: current org's settings (currency + measurement system),
 * falling back to {@link DEFAULT_ORG_SETTINGS} before the org has saved any.
 * Use this anywhere money or quantities are displayed. RULE #1: the org id comes
 * from Clerk via `getOrgId()`, never the client.
 */
export async function getOrgSettings(): Promise<OrgSettingsValues> {
  const organizationId = await getOrgId();
  const row = await withOrg(organizationId, (tx) =>
    getOrgSettingsRow(tx, organizationId),
  );
  return row ?? DEFAULT_ORG_SETTINGS;
}
