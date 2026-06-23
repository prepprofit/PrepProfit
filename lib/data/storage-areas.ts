import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';
import { inventoryMovements, stockCounts, storageAreas } from '@/lib/db/schema';
import type { StorageArea } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';

/**
 * Storage-areas data layer (Sprint 12c). Every function is org-scoped (RULE #1) and
 * runs inside the caller's `withOrg` transaction so RLS is active. Areas are
 * OPERATIONAL config — money-free; area CRUD is manager-only at the action layer.
 *
 * The default area ("Main", `is_default=true`) is seeded once per org and IMMUTABLE in
 * v1 (renamed, never replaced): it owns every legacy `storage_area_id IS NULL` movement,
 * so swapping the default would reassign the NULL bucket without a ledger movement
 * (review #7). Soft-delete is guarded here: not the default, zero per-area balance, and
 * no referencing draft count.
 */

/** The seed name for a freshly-created org's default area (UI labels it via i18n). */
const DEFAULT_AREA_NAME = 'Main';

// ── Reads ───────────────────────────────────────────────────────────────────

/** Active areas in display order: default first, then sort_order, then name. */
export async function listAreas(
  db: TenantClient,
  organizationId: string,
): Promise<StorageArea[]> {
  return db
    .select()
    .from(storageAreas)
    .where(
      and(eq(storageAreas.organizationId, organizationId), isNull(storageAreas.deletedAt)),
    )
    .orderBy(
      sql`${storageAreas.isDefault} desc`,
      asc(storageAreas.sortOrder),
      asc(storageAreas.name),
      asc(storageAreas.id),
    );
}

/** The org's active default area, or null if not seeded yet. */
export async function getDefaultArea(
  db: TenantClient,
  organizationId: string,
): Promise<StorageArea | null> {
  const [row] = await db
    .select()
    .from(storageAreas)
    .where(
      and(
        eq(storageAreas.organizationId, organizationId),
        eq(storageAreas.isDefault, true),
        isNull(storageAreas.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** One active area by id, or null. */
export async function getAreaById(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<StorageArea | null> {
  const [row] = await db
    .select()
    .from(storageAreas)
    .where(
      and(
        eq(storageAreas.organizationId, organizationId),
        eq(storageAreas.id, id),
        isNull(storageAreas.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Idempotently ensure the org has its immutable default "Main" area, returning it.
 * Called from the org-created webhook, seed, and lazily from /inventory, so a new (or
 * pre-12c) org always has a concrete default to show + transfer into. Safe under a
 * race via the one-default-per-org partial unique index (`onConflictDoNothing`).
 */
export async function ensureDefaultArea(
  db: TenantClient,
  organizationId: string,
): Promise<StorageArea> {
  const existing = await getDefaultArea(db, organizationId);
  if (existing) return existing;

  await db
    .insert(storageAreas)
    .values({
      organizationId,
      name: DEFAULT_AREA_NAME,
      isDefault: true,
      sortOrder: 0,
    })
    .onConflictDoNothing();

  const created = await getDefaultArea(db, organizationId);
  if (!created) throw new Error('Failed to ensure the default storage area.');
  return created;
}

// ── Name helpers ──────────────────────────────────────────────────────────────

/** True when an ACTIVE area with this name (case-insensitive) exists, excluding `exceptId`. */
async function activeNameExists(
  db: TenantClient,
  organizationId: string,
  name: string,
  exceptId: string | null,
): Promise<boolean> {
  const rows = await db
    .select({ id: storageAreas.id })
    .from(storageAreas)
    .where(
      and(
        eq(storageAreas.organizationId, organizationId),
        isNull(storageAreas.deletedAt),
        sql`lower(${storageAreas.name}) = lower(${name})`,
        exceptId ? ne(storageAreas.id, exceptId) : undefined,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

// ── Mutations ─────────────────────────────────────────────────────────────────

export type CreateAreaOutcome =
  | { status: 'ok'; area: StorageArea }
  | { status: 'duplicate' };

/** Create an active (non-default) area, appended to the end of the list. */
export async function createArea(
  db: TenantClient,
  organizationId: string,
  name: string,
): Promise<CreateAreaOutcome> {
  if (await activeNameExists(db, organizationId, name, null)) {
    return { status: 'duplicate' };
  }
  const orderRows = await db
    .select({ max: sql<number>`coalesce(max(${storageAreas.sortOrder}), -1)` })
    .from(storageAreas)
    .where(eq(storageAreas.organizationId, organizationId));
  const sortOrder = Number(orderRows[0]?.max ?? -1) + 1;

  const [area] = await db
    .insert(storageAreas)
    .values({ organizationId, name, isDefault: false, sortOrder })
    .returning();
  if (!area) throw new Error('Failed to create storage area.');
  return { status: 'ok', area };
}

type AreaLock =
  | { status: 'ok'; row: StorageArea }
  | { status: 'not_found' }
  | { status: 'stale' };

/** Lock an ACTIVE area FOR UPDATE + enforce optimistic concurrency. */
async function lockAreaForUpdate(
  db: TenantClient,
  organizationId: string,
  id: string,
  expectedUpdatedAt: Date,
): Promise<AreaLock> {
  const [row] = await db
    .select()
    .from(storageAreas)
    .where(
      and(
        eq(storageAreas.organizationId, organizationId),
        eq(storageAreas.id, id),
        isNull(storageAreas.deletedAt),
      ),
    )
    .for('update');
  if (!row) return { status: 'not_found' };
  if (row.updatedAt.getTime() !== expectedUpdatedAt.getTime()) return { status: 'stale' };
  return { status: 'ok', row };
}

export type RenameAreaOutcome =
  | { status: 'ok'; area: StorageArea }
  | { status: 'not_found' }
  | { status: 'stale' }
  | { status: 'duplicate' };

/** Rename an active area (the default MAY be renamed, just not replaced). */
export async function renameArea(
  db: TenantClient,
  organizationId: string,
  id: string,
  expectedUpdatedAt: Date,
  name: string,
): Promise<RenameAreaOutcome> {
  const lock = await lockAreaForUpdate(db, organizationId, id, expectedUpdatedAt);
  if (lock.status !== 'ok') return { status: lock.status };

  if (await activeNameExists(db, organizationId, name, id)) {
    return { status: 'duplicate' };
  }

  const [area] = await db
    .update(storageAreas)
    .set({ name })
    .where(and(eq(storageAreas.organizationId, organizationId), eq(storageAreas.id, id)))
    .returning();
  if (!area) return { status: 'not_found' };
  return { status: 'ok', area };
}

export type DeleteAreaOutcome =
  | { status: 'ok'; area: StorageArea }
  | { status: 'not_found' }
  | { status: 'stale' }
  | { status: 'default_locked' }
  | { status: 'not_empty' }
  | { status: 'has_draft_count' };

/**
 * Soft-delete an active area (D8). Guards, in order: the immutable default refuses
 * (`default_locked`); an area with any non-zero per-ingredient balance refuses
 * (`not_empty` — transfer/count it to zero first); an area referenced by a DRAFT count
 * refuses (`has_draft_count`). Committed counts may keep referencing a soft-deleted
 * area for history (no guard). The composite FK is the DB backstop.
 */
export async function softDeleteArea(
  db: TenantClient,
  organizationId: string,
  id: string,
  expectedUpdatedAt: Date,
): Promise<DeleteAreaOutcome> {
  const lock = await lockAreaForUpdate(db, organizationId, id, expectedUpdatedAt);
  if (lock.status !== 'ok') return { status: lock.status };
  if (lock.row.isDefault) return { status: 'default_locked' };

  // Any ingredient with a non-zero balance in this area pins it (a zero net total could
  // still hide offsetting per-ingredient balances, so check per ingredient).
  const nonZero = await db
    .select({ ingredientId: inventoryMovements.ingredientId })
    .from(inventoryMovements)
    .where(
      and(
        eq(inventoryMovements.organizationId, organizationId),
        eq(inventoryMovements.storageAreaId, id),
      ),
    )
    .groupBy(inventoryMovements.ingredientId)
    .having(sql`coalesce(sum(${inventoryMovements.deltaCanonical}), 0) <> 0`)
    .limit(1);
  if (nonZero.length > 0) return { status: 'not_empty' };

  const drafts = await db
    .select({ id: stockCounts.id })
    .from(stockCounts)
    .where(
      and(
        eq(stockCounts.organizationId, organizationId),
        eq(stockCounts.storageAreaId, id),
        eq(stockCounts.status, 'draft'),
      ),
    )
    .limit(1);
  if (drafts.length > 0) return { status: 'has_draft_count' };

  const [area] = await db
    .update(storageAreas)
    .set({ deletedAt: new Date() })
    .where(and(eq(storageAreas.organizationId, organizationId), eq(storageAreas.id, id)))
    .returning();
  if (!area) return { status: 'not_found' };
  return { status: 'ok', area };
}
