'use server';

import { revalidatePath } from 'next/cache';
import { getOrgId, isManager } from '@/lib/auth';
import { getDb, withOrg } from '@/lib/db';
import { isUniqueViolation } from '@/lib/db/errors';
import { enforceRateLimit } from '@/lib/rate-limit';
import { unexpected } from '@/lib/observability';
import { auditActor, writeAuditEvent, type AuditActor } from '@/lib/data/audit';
import { createArea, renameArea, softDeleteArea } from '@/lib/data/storage-areas';
import {
  createAreaSchema,
  renameAreaSchema,
  deleteAreaSchema,
} from '@/lib/validation/inventory-areas';
import type { ActionResult } from '@/lib/action-result';
import type { StorageArea } from '@/lib/db/schema';

/**
 * Storage-area CRUD Server Actions (Sprint 12c). Areas are org CONFIG → MANAGER-ONLY
 * (D5). Canonical order per action: RBAC (`isManager()`) → rate limit → Zod →
 * `withOrg`(mutation + audit in one tx) → targeted revalidate. Kitchen gets `FORBIDDEN`
 * before any data access. Audit metadata is ids/names-free counts only — areas are
 * money-free, so there is never an amount to leak.
 */

function revalidateInventory(): void {
  revalidatePath('/inventory');
}

type GuardResult =
  | { denied: 'FORBIDDEN' | 'RATE_LIMITED' }
  | { organizationId: string; actor: AuditActor };

/** RBAC + rate-limit guard shared by area CRUD. Returns the org id + actor, or a code. */
async function managerGuard(): Promise<GuardResult> {
  if (!(await isManager())) return { denied: 'FORBIDDEN' as const };
  const organizationId = await getOrgId();
  const actor = await auditActor();
  const limit = await enforceRateLimit(
    getDb(),
    'inventory',
    `${organizationId}:${actor.userId}`,
  );
  if (!limit.allowed) return { denied: 'RATE_LIMITED' as const };
  return { organizationId, actor };
}

export async function createAreaAction(
  input: unknown,
): Promise<ActionResult<StorageArea>> {
  const guard = await managerGuard();
  if ('denied' in guard) return { ok: false, code: guard.denied };

  const parsed = createAreaSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const { organizationId, actor } = guard;
  try {
    const outcome = await withOrg(organizationId, async (tx) => {
      const result = await createArea(tx, organizationId, parsed.data.name);
      if (result.status !== 'ok') return result.status;
      await writeAuditEvent(tx, organizationId, actor, {
        action: 'inventory.areaCreate',
        entityType: 'storageArea',
        entityId: result.area.id,
      });
      return result.area;
    });
    if (outcome === 'duplicate') return { ok: false, code: 'DUPLICATE_NAME' };
    revalidateInventory();
    return { ok: true, data: outcome };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, code: 'DUPLICATE_NAME' };
    return unexpected('createAreaAction', err, organizationId);
  }
}

export async function renameAreaAction(
  id: string,
  input: unknown,
): Promise<ActionResult<StorageArea>> {
  const guard = await managerGuard();
  if ('denied' in guard) return { ok: false, code: guard.denied };

  const parsed = renameAreaSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const { organizationId, actor } = guard;
  const expectedUpdatedAt = new Date(parsed.data.expectedUpdatedAt);
  try {
    const outcome = await withOrg(organizationId, async (tx) => {
      const result = await renameArea(
        tx,
        organizationId,
        id,
        expectedUpdatedAt,
        parsed.data.name,
      );
      if (result.status !== 'ok') return result.status;
      await writeAuditEvent(tx, organizationId, actor, {
        action: 'inventory.areaRename',
        entityType: 'storageArea',
        entityId: id,
      });
      return result.area;
    });
    if (outcome === 'not_found') return { ok: false, code: 'NOT_FOUND' };
    if (outcome === 'stale') return { ok: false, code: 'INVENTORY_AREA_STALE' };
    if (outcome === 'duplicate') return { ok: false, code: 'DUPLICATE_NAME' };
    revalidateInventory();
    return { ok: true, data: outcome };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, code: 'DUPLICATE_NAME' };
    return unexpected('renameAreaAction', err, organizationId);
  }
}

export async function deleteAreaAction(
  id: string,
  input: unknown,
): Promise<ActionResult> {
  const guard = await managerGuard();
  if ('denied' in guard) return { ok: false, code: guard.denied };

  const parsed = deleteAreaSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const { organizationId, actor } = guard;
  const expectedUpdatedAt = new Date(parsed.data.expectedUpdatedAt);
  try {
    const outcome = await withOrg(organizationId, async (tx) => {
      const result = await softDeleteArea(tx, organizationId, id, expectedUpdatedAt);
      if (result.status !== 'ok') return result.status;
      await writeAuditEvent(tx, organizationId, actor, {
        action: 'inventory.areaDelete',
        entityType: 'storageArea',
        entityId: id,
      });
      return 'ok' as const;
    });
    switch (outcome) {
      case 'not_found':
        return { ok: false, code: 'NOT_FOUND' };
      case 'stale':
        return { ok: false, code: 'INVENTORY_AREA_STALE' };
      case 'default_locked':
        return { ok: false, code: 'DEFAULT_AREA_LOCKED' };
      case 'not_empty':
        return { ok: false, code: 'AREA_NOT_EMPTY' };
      case 'has_draft_count':
        return { ok: false, code: 'AREA_HAS_DRAFT_COUNT' };
    }
    revalidateInventory();
    return { ok: true, data: undefined };
  } catch (err) {
    return unexpected('deleteAreaAction', err, organizationId);
  }
}
