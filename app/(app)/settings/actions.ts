'use server';

import { revalidatePath } from 'next/cache';
import { getOrgId, isManager } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { upsertOrgSettings } from '@/lib/data/org-settings';
import { auditActor, writeAuditEvent } from '@/lib/data/audit';
import { orgSettingsSchema } from '@/lib/validation/org-settings';
import type { ActionResult } from '@/lib/action-result';

/**
 * Saves the current org's settings. RULE #1: the org id is derived from Clerk on
 * the server (never the client), and the write runs inside `withOrg` so RLS is
 * active. Input is validated with Zod (`safeParse`, never a throwing `parse`).
 * Manager-only — kitchen-role users are blocked in the page AND refused here
 * (defense-in-depth against a forged POST), with a typed `FORBIDDEN` code.
 *
 * Signature is `useActionState`-shaped (prevState, formData) so the form surfaces
 * the typed result via `useActionError`, consistent with every other action.
 */
export async function updateOrgSettingsAction(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };

  const parsed = orgSettingsSchema.safeParse({
    currency: formData.get('currency'),
    measurementSystem: formData.get('measurementSystem'),
    businessName: formData.get('businessName'),
    businessAddress: formData.get('businessAddress'),
    businessTaxId: formData.get('businessTaxId'),
    businessEmail: formData.get('businessEmail'),
    businessLogoUrl: formData.get('businessLogoUrl'),
    // The tax rate is entered as a percentage; Zod converts it to basis points.
    defaultTaxRateBps: formData.get('defaultTaxRatePercent'),
    stockControlStartDate: formData.get('stockControlStartDate'),
    weeklyCfoReportEmailEnabled: formData.get('weeklyCfoReportEmailEnabled'),
  });
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  await withOrg(organizationId, async (tx) => {
    await upsertOrgSettings(tx, organizationId, parsed.data);
    await writeAuditEvent(tx, organizationId, actor, {
      action: 'settings.update',
      entityType: 'organizationSettings',
      entityId: organizationId,
      // Non-sensitive descriptors only: currency/units + which seller fields are
      // now set (booleans, never the address/tax id/email values themselves).
      metadata: {
        currency: parsed.data.currency,
        measurementSystem: parsed.data.measurementSystem,
        businessIdentitySet: {
          name: parsed.data.businessName !== null,
          address: parsed.data.businessAddress !== null,
          taxId: parsed.data.businessTaxId !== null,
          email: parsed.data.businessEmail !== null,
          logoUrl: parsed.data.businessLogoUrl !== null,
        },
        // Fiscal config (Sprint F5): the bps value + whether a start date is set.
        // Not PII — a rate and a flag.
        defaultTaxRateBps: parsed.data.defaultTaxRateBps,
        stockControlStartDateSet: parsed.data.stockControlStartDate !== null,
        // Notifications: the opt-in boolean only, never the email address.
        weeklyCfoReportEmailEnabled: parsed.data.weeklyCfoReportEmailEnabled,
      },
    });
  });
  revalidatePath('/settings');
  return { ok: true, data: undefined };
}
