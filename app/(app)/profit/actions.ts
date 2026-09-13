'use server';

import { revalidatePath } from 'next/cache';
import { getOrgId, isManager } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { auditActor, writeAuditEvent } from '@/lib/data/audit';
import { updateProductProfit, upsertProfitSettings } from '@/lib/data/profit';
import { productProfitSchema, profitSettingsSchema } from '@/lib/validation/profit';
import type { ActionResult } from '@/lib/action-result';

/**
 * Server Actions for the Profit section (Hour Engine). MANAGER-ONLY — fixed costs,
 * owner income and prices are financial data, so every action returns FORBIDDEN
 * before any data access. Canonical order: RBAC → Zod → withOrg(mutation + audit
 * in one tx) → revalidate. RULE #1: org id from Clerk, never the client.
 *
 * Audit metadata is ids, flags and changed field names only — never a cost,
 * income or price value (CLAUDE.md).
 */

function revalidateProfit(recipeId?: string): void {
  revalidatePath('/profit');
  if (recipeId) {
    revalidatePath(`/profit/${recipeId}`);
    revalidatePath(`/recipes/${recipeId}`);
  }
}

export async function saveProfitSettingsAction(input: unknown): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };

  const parsed = profitSettingsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  await withOrg(organizationId, async (tx) => {
    await upsertProfitSettings(tx, organizationId, parsed.data);
    await writeAuditEvent(tx, organizationId, actor, {
      action: 'profit.settingsUpdate',
      entityType: 'profitSettings',
      entityId: organizationId,
      metadata: { subletEnabled: parsed.data.subletEnabled },
    });
  });
  revalidateProfit();
  return { ok: true, data: undefined };
}

export async function saveProductProfitAction(
  recipeId: string,
  input: unknown,
): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };

  if (typeof recipeId !== 'string' || recipeId.trim() === '') {
    return { ok: false, code: 'INVALID_INPUT' };
  }
  const parsed = productProfitSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  const result = await withOrg(organizationId, async (tx) => {
    const updated = await updateProductProfit(tx, organizationId, recipeId, parsed.data);
    if (updated.status === 'done' && (updated.changedFields.length > 0 || updated.priceChanged)) {
      await writeAuditEvent(tx, organizationId, actor, {
        action: 'recipe.profitUpdate',
        entityType: 'recipe',
        entityId: recipeId,
        metadata: {
          changedFields: updated.changedFields,
          priceChanged: updated.priceChanged,
        },
      });
    }
    return updated;
  });
  if (result.status === 'not_found') return { ok: false, code: 'NOT_FOUND' };

  revalidateProfit(recipeId);
  return { ok: true, data: undefined };
}
