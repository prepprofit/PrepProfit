import { eq } from 'drizzle-orm';
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

/** The two values the rest of the app reads (currency + measurement system). */
export type OrgSettingsValues = {
  currency: string;
  measurementSystem: MeasurementSystem;
};

/** Used until the org saves its own settings. */
export const DEFAULT_ORG_SETTINGS: OrgSettingsValues = {
  currency: 'EUR',
  measurementSystem: 'metric',
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
