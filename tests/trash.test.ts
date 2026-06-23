import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import {
  ingredients as ingredientsTable,
  recipeIngredients as recipeIngredientsTable,
  recipes as recipesTable,
} from '@/lib/db/schema';
import {
  countActiveRecipesUsingIngredient,
  createIngredient,
  listIngredients,
  listTrashedIngredients,
  purgeIngredient,
  restoreIngredient,
  softDeleteIngredient,
} from '@/lib/data/ingredients';
import {
  countTrashedIngredientsInRecipe,
  createRecipe,
  listRecipes,
  listTrashedRecipes,
  purgeRecipe,
  restoreRecipe,
  softDeleteRecipe,
} from '@/lib/data/recipes';
import { addRecipeIngredient } from '@/lib/data/recipe-ingredients';
import {
  createCustomer,
  listTrashedCustomers,
  purgeCustomer,
  restoreCustomer,
  softDeleteCustomer,
} from '@/lib/data/customers';
import {
  createDraftInvoice,
  getInvoiceWithItems,
  issueInvoice,
  listTrashedInvoices,
  restoreInvoice,
  softDeleteDraftInvoice,
} from '@/lib/data/invoices';
import {
  customers as customersTable,
  invoices as invoicesTable,
} from '@/lib/db/schema';
import { purgeExpired } from '@/lib/data/trash';
import { TRASH_RETENTION_DAYS, daysLeft, purgeCutoff } from '@/lib/trash';

const ORG_A = 'org_a';
const ORG_B = 'org_b';
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number): Date => new Date(Date.now() - n * DAY_MS);

describe('trash policy helpers (pure)', () => {
  it('daysLeft counts down from the retention window and clamps at zero', () => {
    expect(daysLeft(new Date())).toBe(TRASH_RETENTION_DAYS);
    expect(daysLeft(daysAgo(10))).toBe(TRASH_RETENTION_DAYS - 10);
    expect(daysLeft(daysAgo(TRASH_RETENTION_DAYS + 5))).toBe(0);
  });

  it('purgeCutoff is the retention window before "now"', () => {
    const now = new Date('2026-06-15T00:00:00Z');
    expect(purgeCutoff(now).toISOString()).toBe('2026-05-16T00:00:00.000Z');
  });
});

describe('trash data layer', () => {
  let client: PGlite;
  let db: TenantDb;
  let flourId: string; // used by the Bread recipe
  let sugarId: string; // unused by any recipe
  let breadId: string;

  beforeEach(async () => {
    const test = await createTestDb();
    client = test.client;
    db = test.db as unknown as TenantDb;

    const flour = await createIngredient(db, ORG_A, {
      name: 'Flour',
      dimension: 'weight',
      priceCents: 120,
    });
    flourId = flour.id;
    const sugar = await createIngredient(db, ORG_A, {
      name: 'Sugar',
      dimension: 'weight',
      priceCents: 90,
    });
    sugarId = sugar.id;
    const bread = await createRecipe(db, ORG_A, { name: 'Bread' });
    breadId = bread.id;
    await addRecipeIngredient(db, ORG_A, {
      recipeId: breadId,
      ingredientId: flourId,
      quantity: 500,
    });
  });

  afterEach(async () => {
    await client.close();
  });

  it('soft-deletes a recipe: gone from the active list, kept in the DB and trash', async () => {
    await softDeleteRecipe(db, ORG_A, breadId);

    expect(await listRecipes(db, ORG_A)).toHaveLength(0);
    const trashed = await listTrashedRecipes(db, ORG_A);
    expect(trashed.map((r) => r.id)).toEqual([breadId]);
    expect(trashed[0]?.deletedAt).toBeInstanceOf(Date);

    const raw = await db
      .select()
      .from(recipesTable)
      .where(eq(recipesTable.id, breadId));
    expect(raw).toHaveLength(1); // still physically there
  });

  it('restores a trashed recipe back to the active list', async () => {
    await softDeleteRecipe(db, ORG_A, breadId);
    const restored = await restoreRecipe(db, ORG_A, breadId);

    expect(restored?.deletedAt).toBeNull();
    expect((await listRecipes(db, ORG_A)).map((r) => r.id)).toEqual([breadId]);
    expect(await listTrashedRecipes(db, ORG_A)).toHaveLength(0);
  });

  it('permanently deletes a trashed recipe and cascades its lines', async () => {
    await softDeleteRecipe(db, ORG_A, breadId);
    await purgeRecipe(db, ORG_A, breadId);

    const raw = await db
      .select()
      .from(recipesTable)
      .where(eq(recipesTable.id, breadId));
    expect(raw).toHaveLength(0);
    const lines = await db
      .select()
      .from(recipeIngredientsTable)
      .where(eq(recipeIngredientsTable.recipeId, breadId));
    expect(lines).toHaveLength(0); // cascaded via composite FK
  });

  it('purge only ever targets trashed rows, never an active one', async () => {
    await purgeRecipe(db, ORG_A, breadId); // recipe is still active
    expect((await listRecipes(db, ORG_A)).map((r) => r.id)).toEqual([breadId]);
  });

  it('counts only ACTIVE recipes using an ingredient (the in-use block)', async () => {
    expect(await countActiveRecipesUsingIngredient(db, ORG_A, flourId)).toBe(1);
    expect(await countActiveRecipesUsingIngredient(db, ORG_A, sugarId)).toBe(0);

    // Once the recipe is trashed it no longer pins the ingredient.
    await softDeleteRecipe(db, ORG_A, breadId);
    expect(await countActiveRecipesUsingIngredient(db, ORG_A, flourId)).toBe(0);
  });

  it('flags trashed ingredients in a recipe (the restore guard)', async () => {
    // Trash the recipe, then the now-unreferenced ingredient.
    await softDeleteRecipe(db, ORG_A, breadId);
    await softDeleteIngredient(db, ORG_A, flourId);

    // Restoring the recipe would re-link a trashed ingredient — guard catches it.
    expect(await countTrashedIngredientsInRecipe(db, ORG_A, breadId)).toBe(1);
  });

  it('soft-deletes and restores a standalone ingredient', async () => {
    await softDeleteIngredient(db, ORG_A, sugarId);
    expect((await listIngredients(db, ORG_A)).map((i) => i.id)).not.toContain(
      sugarId,
    );
    expect((await listTrashedIngredients(db, ORG_A)).map((i) => i.id)).toEqual([
      sugarId,
    ]);

    await restoreIngredient(db, ORG_A, sugarId);
    expect((await listIngredients(db, ORG_A)).map((i) => i.id)).toContain(
      sugarId,
    );
  });

  it('purgeExpired removes only rows past the cutoff', async () => {
    await softDeleteIngredient(db, ORG_A, sugarId);
    // Backdate it beyond the window.
    await db
      .update(ingredientsTable)
      .set({ deletedAt: daysAgo(TRASH_RETENTION_DAYS + 1) })
      .where(eq(ingredientsTable.id, sugarId));

    // A second, recently-trashed ingredient must survive.
    const fresh = await createIngredient(db, ORG_A, {
      name: 'Salt',
      dimension: 'weight',
      priceCents: 30,
    });
    await softDeleteIngredient(db, ORG_A, fresh.id);

    const result = await purgeExpired(db, ORG_A, purgeCutoff());
    expect(result.ingredients).toBe(1);

    const survivors = await listTrashedIngredients(db, ORG_A);
    expect(survivors.map((i) => i.id)).toEqual([fresh.id]);
  });

  it('purgeExpired purges recipes first, freeing pinned ingredients', async () => {
    // Both the recipe and its ingredient are trashed and expired.
    await softDeleteRecipe(db, ORG_A, breadId);
    await softDeleteIngredient(db, ORG_A, flourId);
    await db
      .update(recipesTable)
      .set({ deletedAt: daysAgo(TRASH_RETENTION_DAYS + 1) })
      .where(eq(recipesTable.id, breadId));
    await db
      .update(ingredientsTable)
      .set({ deletedAt: daysAgo(TRASH_RETENTION_DAYS + 1) })
      .where(eq(ingredientsTable.id, flourId));

    const result = await purgeExpired(db, ORG_A, purgeCutoff());
    expect(result).toEqual({
      menus: 0,
      productions: 0,
      recipes: 1,
      ingredients: 1,
      transactions: 0,
      customers: 0,
      invoices: 0,
    });
    expect(await listTrashedRecipes(db, ORG_A)).toHaveLength(0);
    expect(
      (await listTrashedIngredients(db, ORG_A)).map((i) => i.id),
    ).not.toContain(flourId);
  });

  it('purgeExpired skips an ingredient still pinned by a not-yet-expired recipe', async () => {
    // Ingredient expired, but the recipe that references it is only just trashed.
    await softDeleteRecipe(db, ORG_A, breadId); // deletedAt = now (not expired)
    await softDeleteIngredient(db, ORG_A, flourId);
    await db
      .update(ingredientsTable)
      .set({ deletedAt: daysAgo(TRASH_RETENTION_DAYS + 1) })
      .where(eq(ingredientsTable.id, flourId));

    const result = await purgeExpired(db, ORG_A, purgeCutoff());
    expect(result).toEqual({
      menus: 0,
      productions: 0,
      recipes: 0,
      ingredients: 0,
      transactions: 0,
      customers: 0,
      invoices: 0,
    });
    expect(
      (await listTrashedIngredients(db, ORG_A)).map((i) => i.id),
    ).toContain(flourId); // still pinned by the trashed Bread line
  });

  it('purgeExpired never touches another org', async () => {
    const cake = await createRecipe(db, ORG_B, { name: 'Cake' });
    await softDeleteRecipe(db, ORG_B, cake.id);
    await db
      .update(recipesTable)
      .set({ deletedAt: daysAgo(TRASH_RETENTION_DAYS + 1) })
      .where(eq(recipesTable.id, cake.id));

    const result = await purgeExpired(db, ORG_A, purgeCutoff());
    expect(result.recipes).toBe(0);
    // ORG_B's expired recipe is untouched by an ORG_A purge.
    expect(await listTrashedRecipes(db, ORG_B)).toHaveLength(1);
  });

  it('permanently deletes a trashed standalone ingredient', async () => {
    await softDeleteIngredient(db, ORG_A, sugarId);
    await purgeIngredient(db, ORG_A, sugarId);

    const raw = await db
      .select()
      .from(ingredientsTable)
      .where(eq(ingredientsTable.id, sugarId));
    expect(raw).toHaveLength(0);
  });

  it('refuses to purge an ingredient still pinned by a trashed recipe line', async () => {
    // Trash the recipe (its line survives) and the ingredient it references.
    await softDeleteRecipe(db, ORG_A, breadId);
    await softDeleteIngredient(db, ORG_A, flourId);

    // The composite FK is ON DELETE restrict — the manual purge raises a
    // foreign-key violation, which purgeIngredientAction surfaces to the user.
    await expect(purgeIngredient(db, ORG_A, flourId)).rejects.toThrow();
  });

  it('keeps trashed rows org-isolated under RLS', async () => {
    await softDeleteRecipe(db, ORG_A, breadId);
    const cake = await createRecipe(db, ORG_B, { name: 'Cake' });
    await softDeleteRecipe(db, ORG_B, cake.id);

    await db.execute(sql.raw('SET ROLE tenant_app;'));
    try {
      const visible = await runInOrg(db, ORG_A, async (tx) =>
        tx
          .select({ org: recipesTable.organizationId })
          .from(recipesTable), // unfiltered — RLS must scope it
      );
      expect(visible.length).toBeGreaterThan(0);
      expect(visible.every((r) => r.org === ORG_A)).toBe(true);
    } finally {
      await db.execute(sql.raw('RESET ROLE;'));
    }
  });
});

describe('trash — customers & invoices (Sprint 3)', () => {
  let client: PGlite;
  let db: TenantDb;

  beforeEach(async () => {
    const test = await createTestDb();
    client = test.client;
    db = test.db as unknown as TenantDb;
  });

  afterEach(async () => {
    await client.close();
  });

  const seedInvoiceFor = async (customerId: string, status: 'draft' | 'issued') => {
    const draft = await createDraftInvoice(db, ORG_A, {
      customerId,
      notes: null,
      items: [
        { description: 'Service', quantity: 1, unitPriceCents: 10000, taxRate: 23 },
      ],
    });
    if (status === 'issued') {
      const outcome = await issueInvoice(db, ORG_A, draft.id, null);
      if (outcome.status !== 'ok') throw new Error('seed: could not issue');
      return outcome.invoice;
    }
    return draft;
  };

  it('soft-deletes and restores a customer', async () => {
    const c = await createCustomer(db, ORG_A, {
      name: 'Acme',
      taxId: null,
      address: null,
      email: null,
    });
    await softDeleteCustomer(db, ORG_A, c.id);
    expect((await listTrashedCustomers(db, ORG_A)).map((x) => x.id)).toEqual([c.id]);

    await restoreCustomer(db, ORG_A, c.id);
    expect(await listTrashedCustomers(db, ORG_A)).toHaveLength(0);
  });

  it('only drafts are trashable; an issued invoice cannot be soft-deleted', async () => {
    const c = await createCustomer(db, ORG_A, {
      name: 'Bistro',
      taxId: null,
      address: null,
      email: null,
    });
    const draft = await seedInvoiceFor(c.id, 'draft');
    expect(await softDeleteDraftInvoice(db, ORG_A, draft.id)).not.toBeNull();
    expect((await listTrashedInvoices(db, ORG_A)).map((i) => i.id)).toEqual([
      draft.id,
    ]);
    await restoreInvoice(db, ORG_A, draft.id);

    const issued = await seedInvoiceFor(c.id, 'issued');
    // Issued invoices are immutable — soft-delete refuses (only drafts trash).
    expect(await softDeleteDraftInvoice(db, ORG_A, issued.id)).toBeNull();
  });

  it('purging a customer nulls referencing invoices but keeps their snapshot', async () => {
    const c = await createCustomer(db, ORG_A, {
      name: 'Almeida Catering',
      taxId: 'PT123',
      address: null,
      email: null,
    });
    const issued = await seedInvoiceFor(c.id, 'issued');
    await softDeleteCustomer(db, ORG_A, c.id);
    await purgeCustomer(db, ORG_A, c.id);

    const detail = await getInvoiceWithItems(db, ORG_A, issued.id);
    expect(detail?.invoice.customerId).toBeNull(); // link nulled
    expect(detail?.invoice.customerName).toBe('Almeida Catering'); // snapshot kept
  });

  it('purgeExpired removes expired draft invoices + customers, nulling links', async () => {
    const c = await createCustomer(db, ORG_A, {
      name: 'Old Co',
      taxId: null,
      address: null,
      email: null,
    });
    const issued = await seedInvoiceFor(c.id, 'issued');
    const draft = await seedInvoiceFor(c.id, 'draft');

    // Trash the draft invoice and the customer, then backdate both past the window.
    const expired = daysAgo(TRASH_RETENTION_DAYS + 1);
    await softDeleteDraftInvoice(db, ORG_A, draft.id);
    await softDeleteCustomer(db, ORG_A, c.id);
    await db
      .update(invoicesTable)
      .set({ deletedAt: expired })
      .where(eq(invoicesTable.id, draft.id));
    await db
      .update(customersTable)
      .set({ deletedAt: expired })
      .where(eq(customersTable.id, c.id));

    const result = await purgeExpired(db, ORG_A, purgeCutoff());
    expect(result.invoices).toBe(1);
    expect(result.customers).toBe(1);
    expect(await listTrashedInvoices(db, ORG_A)).toHaveLength(0);
    expect(await listTrashedCustomers(db, ORG_A)).toHaveLength(0);

    // The issued invoice survived but its customer link was nulled (snapshot kept).
    const detail = await getInvoiceWithItems(db, ORG_A, issued.id);
    expect(detail?.invoice.customerId).toBeNull();
    expect(detail?.invoice.customerName).toBe('Old Co');
  });
});
