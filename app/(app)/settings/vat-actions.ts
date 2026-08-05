'use server';

import { revalidatePath } from 'next/cache';
import { getOrgId, isManager } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { auditActor, writeAuditEvent } from '@/lib/data/audit';
import {
  createVatCategory,
  deleteVatCategory,
  updateVatCategory,
} from '@/lib/data/vat-categories';
import { vatCategorySchema } from '@/lib/validation/vat-categories';
import type { ActionResult } from '@/lib/action-result';

/**
 * Purchase VAT bands (Settings). MANAGER-ONLY — every action returns FORBIDDEN
 * before touching data, mirroring the rest of `/settings`. Rates are org
 * configuration, so each change is audited; the metadata is a name and a rate,
 * never PII.
 */

export async function createVatCategoryAction(input: unknown): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };

  const parsed = vatCategorySchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  const outcome = await withOrg(organizationId, async (tx) => {
    const result = await createVatCategory(tx, organizationId, parsed.data);
    if (result.status !== 'ok') return result.status;
    await writeAuditEvent(tx, organizationId, actor, {
      action: 'settings.vatCategoryCreate',
      entityType: 'vatCategory',
      entityId: result.category.id,
      metadata: { name: result.category.name, rateBps: result.category.rateBps },
    });
    return 'ok' as const;
  });

  if (outcome === 'duplicate_name') return { ok: false, code: 'DUPLICATE_NAME' };
  revalidatePath('/settings');
  revalidatePath('/ingredients');
  return { ok: true, data: undefined };
}

export async function updateVatCategoryAction(
  id: string,
  input: unknown,
): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };

  const parsed = vatCategorySchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  const outcome = await withOrg(organizationId, async (tx) => {
    const result = await updateVatCategory(tx, organizationId, id, parsed.data);
    if (result.status !== 'ok') return result.status;
    await writeAuditEvent(tx, organizationId, actor, {
      action: 'settings.vatCategoryUpdate',
      entityType: 'vatCategory',
      entityId: id,
      metadata: { name: result.category.name, rateBps: result.category.rateBps },
    });
    return 'ok' as const;
  });

  if (outcome === 'not_found') return { ok: false, code: 'NOT_FOUND' };
  if (outcome === 'duplicate_name') return { ok: false, code: 'DUPLICATE_NAME' };
  revalidatePath('/settings');
  revalidatePath('/ingredients');
  return { ok: true, data: undefined };
}

export async function deleteVatCategoryAction(id: string): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  const outcome = await withOrg(organizationId, async (tx) => {
    const result = await deleteVatCategory(tx, organizationId, id);
    if (result.status !== 'ok') return result.status;
    await writeAuditEvent(tx, organizationId, actor, {
      action: 'settings.vatCategoryDelete',
      entityType: 'vatCategory',
      entityId: id,
      metadata: {},
    });
    return 'ok' as const;
  });

  if (outcome === 'not_found') return { ok: false, code: 'NOT_FOUND' };
  if (outcome === 'in_use') return { ok: false, code: 'VAT_CATEGORY_IN_USE' };
  if (outcome === 'is_default') return { ok: false, code: 'VAT_CATEGORY_IS_DEFAULT' };
  revalidatePath('/settings');
  revalidatePath('/ingredients');
  return { ok: true, data: undefined };
}
