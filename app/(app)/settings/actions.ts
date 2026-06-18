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
      metadata: {
        currency: parsed.data.currency,
        measurementSystem: parsed.data.measurementSystem,
      },
    });
  });
  revalidatePath('/settings');
  return { ok: true, data: undefined };
}
