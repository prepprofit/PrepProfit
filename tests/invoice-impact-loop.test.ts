import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import type { TenantDb } from '@/lib/db/tenant';
import { createIngredient, listIngredients } from '@/lib/data/ingredients';
import { createRecipe } from '@/lib/data/recipes';
import { addRecipeIngredient } from '@/lib/data/recipe-ingredients';
import { createInvoiceImport, applyInvoiceImport } from '@/lib/data/supplier-invoice-imports';
import { acceptPendingCost } from '@/lib/data/ingredient-pricing';
import { loadInvoiceImpact } from '@/lib/data/invoice-impact';
import type { InvoiceDraft } from '@/lib/ai/invoice-draft';

const ORG = 'org_a';

/**
 * The §16.5 launch-gate scenario end to end at the data layer:
 *   extraction draft → review → apply → pending observation set →
 *   impact appears → manager accepts → approved cost changes → impact resolves.
 */
describe('invoice-to-profit impact loop', () => {
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

  it('applies an invoice, surfaces the margin impact, then resolves it on accept', async () => {
    // Butter approved at €8.20/kg; a 1 kg-per-portion recipe priced at €25.00.
    const butter = await createIngredient(db, ORG, {
      name: 'Butter',
      dimension: 'weight',
      priceCents: 820,
      needsPricing: false,
    });
    const recipe = await createRecipe(db, ORG, {
      name: 'Cheesecake Slice',
      sellingPriceCents: 2500,
    });
    const added = await addRecipeIngredient(db, ORG, {
      recipeId: recipe.id,
      ingredientId: butter.id,
      quantity: 1000, // grams
    });
    if (!added.ok) throw new Error('failed to add recipe line');

    // A draft with one ready line: a 5 kg pack at €48.50 → derived €9.70/kg.
    const draft: InvoiceDraft = {
      supplierNameRaw: 'ACME Foods',
      invoiceNumber: 'INV-1',
      invoiceDate: '2026-07-01',
      currencyCode: 'EUR',
      qualityFlags: [],
      lines: [
        {
          sortOrder: 0,
          rawText: 'Butter 5kg 48.50',
          itemNameRaw: 'Butter', // exact-matches the ingredient
          quantityValue: 1,
          quantityUnit: 'kg',
          packSizeValue: 5,
          packSizeUnit: 'kg',
          unitPriceCents: 4850,
          lineTotalCents: 4850,
          confidence: 0.95,
          matchedIngredientId: null,
          status: 'needs_review',
          issues: [],
        },
      ],
    };

    const created = await createInvoiceImport(db, ORG, {
      actorUserId: 'user_1',
      aiAttemptId: null,
      draft,
    });
    // The line exact-matched Butter and has qty/pack/price → ready.
    expect(created.ready).toBe(1);

    const applied = await applyInvoiceImport(db, ORG, 'user_1', created.importId, 'EUR');
    expect(applied.status).toBe('ok');

    // Pending cost is set on the ingredient; approved cost is UNCHANGED.
    const afterApply = (await listIngredients(db, ORG)).find((i) => i.id === butter.id);
    expect(afterApply?.priceCents).toBe(820); // approved untouched
    expect(afterApply?.pendingPriceCents).toBe(970); // 4850 / 5 kg

    // Impact appears: butter +18.3%, the recipe crosses below the 65% target.
    const impact = await loadInvoiceImpact(db, ORG, created.importId);
    expect(impact!.changes).toHaveLength(1);
    expect(impact!.changes[0]!.currentCostCents).toBe(820);
    expect(impact!.changes[0]!.projectedCostCents).toBe(970);
    const affected = impact!.affectedRecipes[0]!;
    expect(affected.recipeId).toBe(recipe.id);
    expect(affected.currentMarginPercent).toBeCloseTo(67.2, 1); // (2500-820)/2500
    expect(affected.projectedMarginPercent).toBeCloseTo(61.2, 1); // (2500-970)/2500
    expect(affected.crossesBelowTarget).toBe(true);

    // Manager accepts the pending cost → approved cost becomes €9.70/kg, pending cleared.
    const accepted = await acceptPendingCost(db, ORG, butter.id);
    expect(accepted.ok).toBe(true);
    const afterAccept = (await listIngredients(db, ORG)).find((i) => i.id === butter.id);
    expect(afterAccept?.priceCents).toBe(970); // approved cost now reflects the invoice
    expect(afterAccept?.pendingPriceCents).toBeNull();

    // The impact resolves — no pending delta remains for this invoice.
    const resolved = await loadInvoiceImpact(db, ORG, created.importId);
    expect(resolved!.changes).toHaveLength(0);
    expect(resolved!.affectedRecipes).toHaveLength(0);
  });
});
