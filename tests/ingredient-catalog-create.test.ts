import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import type { TenantDb } from '@/lib/db/tenant';
import type { TenantClient } from '@/lib/db';
import { ingredientAllergens, ingredients } from '@/lib/db/schema';
import { createIngredientFromCatalog } from '@/lib/data/ingredient-catalog';
import { createIngredient } from '@/lib/data/ingredients';
import type { CatalogEntry } from '@/lib/ingredient-catalog/schema';

/**
 * Seed-catalogue create path (docs/ingredient-seed-catalog-plan.md §3):
 * price honesty, unreviewed allergen seeding, duplicate blocking (D4).
 */
const ORG = 'org_catalog_a';
const OTHER_ORG = 'org_catalog_b';

let client: PGlite;
let db: TenantDb;

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  db = test.db as unknown as TenantDb;
});

afterAll(async () => {
  await client.close();
});

const tx = () => db as unknown as TenantClient;

const ENTRY: CatalogEntry = {
  id: 'butter',
  nameEn: 'Butter',
  aliases: [],
  dimension: 'weight',
  category: 'Dairy and Egg Products',
  allergens: [{ allergen: 'milk', presence: 'contains' }],
  suggestedFdcId: 173410,
};

describe('createIngredientFromCatalog', () => {
  it('creates with priceCents 0 + needsPricing true and the suggested fdcId', async () => {
    const result = await createIngredientFromCatalog(tx(), ORG, ENTRY, {
      name: ENTRY.nameEn,
      dimension: ENTRY.dimension,
    });
    if (result.status !== 'created') throw new Error('expected created');
    expect(result.ingredient.priceCents).toBe(0);
    expect(result.ingredient.needsPricing).toBe(true);
    expect(result.ingredient.suggestedFdcId).toBe(173410);
    expect(result.ingredient.organizationId).toBe(ORG);
  });

  it('seeds typical allergens WITHOUT stamping review provenance', async () => {
    const [row] = await db
      .select()
      .from(ingredients)
      .where(eq(ingredients.name, 'Butter'));
    if (!row) throw new Error('missing ingredient');
    expect(row.allergensReviewedAt).toBeNull();
    expect(row.allergensReviewedBy).toBeNull();

    const tags = await db
      .select()
      .from(ingredientAllergens)
      .where(eq(ingredientAllergens.ingredientId, row.id));
    expect(tags).toHaveLength(1);
    expect(tags[0]?.allergen).toBe('milk');
    expect(tags[0]?.presence).toBe('contains');
  });

  it('blocks a duplicate ACTIVE name case-insensitively (D4)', async () => {
    const dup = await createIngredientFromCatalog(tx(), ORG, ENTRY, {
      name: 'bUtTeR',
      dimension: 'weight',
    });
    expect(dup.status).toBe('duplicate');
  });

  it('does NOT treat another org\'s ingredient as a duplicate', async () => {
    const other = await createIngredientFromCatalog(tx(), OTHER_ORG, ENTRY, {
      name: 'Butter',
      dimension: 'weight',
    });
    expect(other.status).toBe('created');
  });

  it('duplicate check also catches manually created ingredients', async () => {
    await createIngredient(db, ORG, {
      name: 'Olive oil',
      dimension: 'volume',
      priceCents: 900,
    });
    const dup = await createIngredientFromCatalog(
      tx(),
      ORG,
      { ...ENTRY, id: 'oil-olive', nameEn: 'Olive oil', allergens: [] },
      { name: 'olive OIL', dimension: 'volume' },
    );
    expect(dup.status).toBe('duplicate');
  });

  it('applies user overrides for name and dimension', async () => {
    const result = await createIngredientFromCatalog(
      tx(),
      ORG,
      { ...ENTRY, id: 'milk-whole', nameEn: 'Milk, whole', allergens: [] },
      { name: 'Whole milk (3.5%)', dimension: 'volume' },
    );
    if (result.status !== 'created') throw new Error('expected created');
    expect(result.ingredient.name).toBe('Whole milk (3.5%)');
    expect(result.ingredient.dimension).toBe('volume');
  });
});
