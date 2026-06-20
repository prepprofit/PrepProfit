'use server';

import { revalidatePath } from 'next/cache';
import { getOrgId, getUserId, isManager } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import {
  requestAccountDeletion,
  cancelAccountDeletion,
} from '@/lib/data/org-settings';
import { auditActor, writeAuditEvent } from '@/lib/data/audit';
import { accountDeletionRequestSchema } from '@/lib/validation/account';
import { unexpected } from '@/lib/observability';
import type { ActionResult } from '@/lib/action-result';

/**
 * GDPR account-deletion request (Sprint 5e). Manager-only, defense-in-depth (the
 * page also hides it from kitchen). This ONLY records the request — it deletes
 * nothing; org self-delete is disabled in Clerk (Sprint 4e) and an operator
 * fulfils erasure out-of-band per the retention runbook. `useActionState`-shaped.
 *
 * Audit metadata is PII-free: whether a reason was supplied, never its text.
 */
export async function requestAccountDeletionAction(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };

  const parsed = accountDeletionRequestSchema.safeParse({
    reason: formData.get('reason') ?? undefined,
  });
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  try {
    const userId = await getUserId();
    const actor = await auditActor();
    await withOrg(organizationId, async (tx) => {
      await requestAccountDeletion(tx, organizationId, {
        userId,
        reason: parsed.data.reason,
      });
      await writeAuditEvent(tx, organizationId, actor, {
        action: 'account.deletionRequest',
        entityType: 'organization',
        entityId: organizationId,
        metadata: { hasReason: parsed.data.reason !== null },
      });
    });
    revalidatePath('/settings');
    return { ok: true, data: undefined };
  } catch (err) {
    return unexpected('requestAccountDeletionAction', err, organizationId);
  }
}

/** Cancels a pending deletion request (Sprint 5e). Manager-only. */
export async function cancelAccountDeletionAction(
  _prevState: ActionResult | null,
  _formData: FormData,
): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };

  const organizationId = await getOrgId();
  try {
    const actor = await auditActor();
    await withOrg(organizationId, async (tx) => {
      await cancelAccountDeletion(tx, organizationId);
      await writeAuditEvent(tx, organizationId, actor, {
        action: 'account.deletionCancel',
        entityType: 'organization',
        entityId: organizationId,
      });
    });
    revalidatePath('/settings');
    return { ok: true, data: undefined };
  } catch (err) {
    return unexpected('cancelAccountDeletionAction', err, organizationId);
  }
}
