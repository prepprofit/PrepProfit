import { and, asc, eq, sql } from 'drizzle-orm';
import { ingredients, vatCategories, type VatCategory } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';
import type { VatCategoryInput } from '@/lib/validation/vat-categories';

/**
 * Per-org PURCHASE VAT bands. Every query is explicitly scoped by
 * `organizationId` (Rule 1); RLS is the second layer. Must run inside `withOrg`.
 *
 * The rate resolved here is used at exactly one moment — converting an incl.-VAT
 * supplier quote into the excl.-VAT cost we store. It never reaches recipe or
 * margin maths.
 */

/**
 * The bands a fresh org starts with. Finland (the product's home market): food 14%,
 * alcohol and non-food 25.5%. They are a STARTING POINT, not a rule — the whole
 * point of the table is that a Portuguese (or any other) user edits it, including
 * adding regional bands, without a code change.
 */
export const DEFAULT_VAT_CATEGORIES: ReadonlyArray<{
  name: string;
  rateBps: number;
  isDefault: boolean;
}> = [
  { name: 'Food', rateBps: 1400, isDefault: true },
  { name: 'Alcohol', rateBps: 2550, isDefault: false },
  { name: 'Non-food', rateBps: 2550, isDefault: false },
];

export async function listVatCategories(
  db: TenantClient,
  organizationId: string,
): Promise<VatCategory[]> {
  return db
    .select()
    .from(vatCategories)
    .where(eq(vatCategories.organizationId, organizationId))
    .orderBy(asc(vatCategories.sortOrder), asc(vatCategories.name));
}

/**
 * Seed the default bands for an org that has none. Idempotent and NON-destructive:
 * it does nothing at all once the org has a single category, so it can never
 * resurrect a band the user deleted or overwrite an edited rate. Called from the
 * `organization.created` webhook; migration 0046 covers orgs that already existed.
 */
export async function ensureVatCategories(
  db: TenantClient,
  organizationId: string,
): Promise<void> {
  const existing = await listVatCategories(db, organizationId);
  if (existing.length > 0) return;
  await db
    .insert(vatCategories)
    .values(
      DEFAULT_VAT_CATEGORIES.map((c, i) => ({
        organizationId,
        name: c.name,
        rateBps: c.rateBps,
        isDefault: c.isDefault,
        sortOrder: i,
      })),
    )
    .onConflictDoNothing();
}

/**
 * The VAT rate that applies to one ingredient's purchases: its own band, else the
 * org's default band. NULL when neither exists — the same "no rate configured"
 * state the supplier dialog already refuses to guess a net price from.
 */
export async function resolveVatRateBps(
  db: TenantClient,
  organizationId: string,
  vatCategoryId: string | null,
): Promise<number | null> {
  if (vatCategoryId != null) {
    const [row] = await db
      .select({ rateBps: vatCategories.rateBps })
      .from(vatCategories)
      .where(
        and(
          eq(vatCategories.organizationId, organizationId),
          eq(vatCategories.id, vatCategoryId),
        ),
      )
      .limit(1);
    // A category id that doesn't resolve (deleted mid-edit) falls back to the
    // org default rather than pricing the quote at 0%.
    if (row) return row.rateBps;
  }
  const [fallback] = await db
    .select({ rateBps: vatCategories.rateBps })
    .from(vatCategories)
    .where(
      and(
        eq(vatCategories.organizationId, organizationId),
        eq(vatCategories.isDefault, true),
      ),
    )
    .limit(1);
  return fallback?.rateBps ?? null;
}

export type CreateVatCategoryResult =
  | { status: 'ok'; category: VatCategory }
  | { status: 'duplicate_name' };

/** Case-insensitive name lookup — the app-level mirror of the unique index. */
async function findByName(
  db: TenantClient,
  organizationId: string,
  name: string,
): Promise<VatCategory | null> {
  const [row] = await db
    .select()
    .from(vatCategories)
    .where(
      and(
        eq(vatCategories.organizationId, organizationId),
        sql`lower(${vatCategories.name}) = lower(${name})`,
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function createVatCategory(
  db: TenantClient,
  organizationId: string,
  input: VatCategoryInput,
): Promise<CreateVatCategoryResult> {
  if (await findByName(db, organizationId, input.name)) {
    return { status: 'duplicate_name' };
  }
  // The first band an org ever creates becomes its default, so an org that
  // deleted everything can never end up with no fallback rate.
  const existing = await listVatCategories(db, organizationId);
  const [row] = await db
    .insert(vatCategories)
    .values({
      organizationId,
      name: input.name,
      rateBps: input.rateBps,
      isDefault: existing.length === 0,
      sortOrder: existing.length,
    })
    .returning();
  if (!row) return { status: 'duplicate_name' };
  return { status: 'ok', category: row };
}

export type UpdateVatCategoryResult =
  | { status: 'ok'; category: VatCategory }
  | { status: 'not_found' }
  | { status: 'duplicate_name' };

export async function updateVatCategory(
  db: TenantClient,
  organizationId: string,
  id: string,
  input: VatCategoryInput,
): Promise<UpdateVatCategoryResult> {
  const clash = await findByName(db, organizationId, input.name);
  if (clash && clash.id !== id) return { status: 'duplicate_name' };
  const [row] = await db
    .update(vatCategories)
    .set({ name: input.name, rateBps: input.rateBps, updatedAt: new Date() })
    .where(
      and(eq(vatCategories.organizationId, organizationId), eq(vatCategories.id, id)),
    )
    .returning();
  if (!row) return { status: 'not_found' };
  return { status: 'ok', category: row };
}

export type DeleteVatCategoryResult =
  | { status: 'ok' }
  | { status: 'not_found' }
  | { status: 'in_use' }
  | { status: 'is_default' };

/**
 * Remove a band. Refused while any ingredient still points at it (the FK would
 * reject the delete anyway; checking first turns it into a stable error code), and
 * refused for the default band — an org must always keep a fallback rate.
 */
export async function deleteVatCategory(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<DeleteVatCategoryResult> {
  const [target] = await db
    .select()
    .from(vatCategories)
    .where(
      and(eq(vatCategories.organizationId, organizationId), eq(vatCategories.id, id)),
    )
    .limit(1);
  if (!target) return { status: 'not_found' };
  if (target.isDefault) return { status: 'is_default' };

  const [used] = await db
    .select({ id: ingredients.id })
    .from(ingredients)
    .where(
      and(
        eq(ingredients.organizationId, organizationId),
        eq(ingredients.vatCategoryId, id),
      ),
    )
    .limit(1);
  if (used) return { status: 'in_use' };

  await db
    .delete(vatCategories)
    .where(
      and(eq(vatCategories.organizationId, organizationId), eq(vatCategories.id, id)),
    );
  return { status: 'ok' };
}
