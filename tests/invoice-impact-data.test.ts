import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import type { TenantDb } from '@/lib/db/tenant';
import { createIngredient } from '@/lib/data/ingredients';
import { createRecipe } from '@/lib/data/recipes';
import { addRecipeIngredient } from '@/lib/data/recipe-ingredients';
import { supplierInvoiceImports, supplierInvoiceImportLines } from '@/lib/db/schema';
import type { SupplierInvoiceLineStatus } from '@/lib/ai/operation-types';
import { loadInvoiceImpact } from '@/lib/data/invoice-impact';

const ORG_A = 'org_a';
const ORG_B = 'org_b';

/** A `count` recipe with one line of quantity 1 → cost/portion == ingredient price. */
async function makeRecipe(
  db: TenantDb,
  org: string,
  opts: { name: string; sellingPriceCents: number | null; priceCents: number; pendingPriceCents?: number | null },
): Promise<{ recipeId: string; ingredientId: string }> {
  const ing = await createIngredient(db, org, {
    name: `${opts.name} ingredient`,
    dimension: 'count',
    priceCents: opts.priceCents,
    needsPricing: false,
    pendingPriceCents: opts.pendingPriceCents ?? null,
  });
  const recipe = await createRecipe(db, org, {
    name: opts.name,
    sellingPriceCents: opts.sellingPriceCents,
  });
  const added = await addRecipeIngredient(db, org, {
    recipeId: recipe.id,
    ingredientId: ing.id,
    quantity: 1,
  });
  if (!added.ok) throw new Error('failed to add line');
  return { recipeId: recipe.id, ingredientId: ing.id };
}

/** Insert an `applied` import with one line matched to `ingredientId`. */
async function makeAppliedImport(
  db: TenantDb,
  org: string,
  ingredientId: string,
  lineStatus: SupplierInvoiceLineStatus = 'applied',
): Promise<string> {
  const [header] = await db
    .insert(supplierInvoiceImports)
    .values({
      organizationId: org,
      actorUserId: 'user_1',
      supplierNameRaw: 'ACME Foods',
      currencyCode: 'EUR',
      status: 'applied',
    })
    .returning();
  if (!header) throw new Error('failed to insert import');

  await db.insert(supplierInvoiceImportLines).values({
    organizationId: org,
    importId: header.id,
    sortOrder: 0,
    itemNameRaw: 'Butter',
    matchedIngredientId: ingredientId,
    status: lineStatus,
  });
  return header.id;
}

describe('loadInvoiceImpact loader', () => {
  let client: PGlite;
  let db: TenantDb;

  beforeEach(async () => {
    const test = await createTestDb();
    client = test.client;
    db = test.db;
  });

  afterEach(async () => {
    await client.close();
  });

  it('projects the impact of an applied line on an affected recipe', async () => {
    // approved 200, pending 260 (+30%); recipe price 700 → 71.4% now, 62.9% projected.
    const { recipeId, ingredientId } = await makeRecipe(db, ORG_A, {
      name: 'Croissant',
      sellingPriceCents: 700,
      priceCents: 200,
      pendingPriceCents: 260,
    });
    const importId = await makeAppliedImport(db, ORG_A, ingredientId);

    const impact = await loadInvoiceImpact(db, ORG_A, importId);
    expect(impact).not.toBeNull();
    expect(impact!.changes).toHaveLength(1);
    expect(impact!.changes[0]!.ingredientId).toBe(ingredientId);
    expect(impact!.changes[0]!.currentCostCents).toBe(200);
    expect(impact!.changes[0]!.projectedCostCents).toBe(260);

    expect(impact!.affectedRecipes).toHaveLength(1);
    const r = impact!.affectedRecipes[0]!;
    expect(r.recipeId).toBe(recipeId);
    expect(r.currentMarginPercent).toBeCloseTo(71.4, 1);
    expect(r.projectedMarginPercent).toBeCloseTo(62.9, 1);
    expect(r.crossesBelowTarget).toBe(true);
  });

  it('ignores lines that are not applied (only applied lines drive the focus set)', async () => {
    const { ingredientId } = await makeRecipe(db, ORG_A, {
      name: 'Not applied',
      sellingPriceCents: 700,
      priceCents: 200,
      pendingPriceCents: 260,
    });
    // Line is still needs_review → not part of the focus set.
    const importId = await makeAppliedImport(db, ORG_A, ingredientId, 'needs_review');

    const impact = await loadInvoiceImpact(db, ORG_A, importId);
    expect(impact!.changes).toHaveLength(0);
    expect(impact!.affectedRecipes).toHaveLength(0);
  });

  it('returns an empty impact once the pending cost has been accepted (pending cleared)', async () => {
    // No pending price on the ingredient → the applied line reveals no change.
    const { ingredientId } = await makeRecipe(db, ORG_A, {
      name: 'Accepted',
      sellingPriceCents: 700,
      priceCents: 260,
      pendingPriceCents: null,
    });
    const importId = await makeAppliedImport(db, ORG_A, ingredientId);

    const impact = await loadInvoiceImpact(db, ORG_A, importId);
    expect(impact!.changes).toHaveLength(0);
    expect(impact!.affectedRecipes).toHaveLength(0);
  });

  it('is org-scoped — org A cannot load org B import impact', async () => {
    const { ingredientId } = await makeRecipe(db, ORG_B, {
      name: 'B recipe',
      sellingPriceCents: 700,
      priceCents: 200,
      pendingPriceCents: 260,
    });
    const bImport = await makeAppliedImport(db, ORG_B, ingredientId);

    // Org A asking for org B's import id sees nothing.
    expect(await loadInvoiceImpact(db, ORG_A, bImport)).toBeNull();
    // Org B sees its own impact.
    const bImpact = await loadInvoiceImpact(db, ORG_B, bImport);
    expect(bImpact!.changes).toHaveLength(1);
  });

  it('returns null for an unknown import id', async () => {
    expect(await loadInvoiceImpact(db, ORG_A, 'does-not-exist')).toBeNull();
  });
});
