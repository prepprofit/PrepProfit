import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import {
  ingredients,
  recipes,
  recipeIngredients,
  recipeIngredientSections,
  recipeComponents,
  recipeMethodSections,
  recipeSteps,
  recipeBooks,
  recipeBookEntries,
  recipePortionOptions,
} from '@/lib/db/schema';
import {
  getRecipeWorkspace,
  saveRecipeWorkspace,
  getRecipeVersion,
} from '@/lib/data/recipe-workspace';
import type { AuditActor } from '@/lib/data/audit';

const ORG = 'org_ws';
const OTHER_ORG = 'org_ws_other';

const actor: AuditActor = {
  userId: 'user_1',
  role: 'manager',
  requestId: 'req-ws-test',
};

let client: PGlite;
let db: TenantDb;
let recipeId: string;
let subRecipeId: string;

/** Collects every own key of a JSON-serialized value, recursively. */
function allKeysDeep(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const v of value) allKeysDeep(v, keys);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      keys.add(k);
      allKeysDeep(v, keys);
    }
  }
  return keys;
}

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  db = test.db as unknown as TenantDb;

  const [flour] = await db
    .insert(ingredients)
    .values({
      organizationId: ORG,
      name: 'Flour',
      dimension: 'weight',
      priceCents: 120,
    })
    .returning();

  const inserted = await db
    .insert(recipes)
    .values([
      {
        organizationId: ORG,
        name: 'Bread',
        yieldPortions: 10,
        yieldWeightGrams: 900,
        laborCostCents: 500,
        energyCostCents: 100,
        packagingCostCents: 50,
        sellingPriceCents: 1000,
      },
      {
        organizationId: ORG,
        name: 'Starter',
        yieldPortions: 1,
        yieldWeightGrams: 200,
      },
    ])
    .returning();
  recipeId = inserted[0]!.id;
  subRecipeId = inserted[1]!.id;

  const [section] = await db
    .insert(recipeIngredientSections)
    .values({ organizationId: ORG, recipeId, title: 'Dough', sortOrder: 0 })
    .returning();

  await db.insert(recipeIngredients).values([
    {
      organizationId: ORG,
      recipeId,
      ingredientId: flour!.id,
      quantity: '500',
      sectionId: section!.id,
      displaySortOrder: 1,
      note: 'sifted',
    },
    // Same ingredient twice — allowed since the (recipe, ingredient) unique
    // was dropped (plan §6.2).
    {
      organizationId: ORG,
      recipeId,
      ingredientId: flour!.id,
      quantity: '25',
      displaySortOrder: 3,
      note: 'for dusting',
    },
  ]);

  await db.insert(recipeComponents).values({
    organizationId: ORG,
    recipeId,
    componentRecipeId: subRecipeId,
    quantityGrams: 150,
    displaySortOrder: 2,
  });

  const [methodSection] = await db
    .insert(recipeMethodSections)
    .values({ organizationId: ORG, recipeId, title: 'Bake', sortOrder: 0 })
    .returning();
  await db.insert(recipeSteps).values({
    organizationId: ORG,
    recipeId,
    sectionId: methodSection!.id,
    instruction: 'Bake at 230C for 30 minutes.',
    sortOrder: 0,
  });

  const [book] = await db
    .insert(recipeBooks)
    .values({ organizationId: ORG, name: 'Bakery' })
    .returning();
  await db.insert(recipeBookEntries).values({
    organizationId: ORG,
    recipeBookId: book!.id,
    recipeId,
  });

  await db.insert(recipePortionOptions).values({
    organizationId: ORG,
    recipeId,
    name: 'Default serving',
    quantity: 1,
    unit: 'serving',
    sellingPriceCents: 1000,
    targetFoodCostBps: 3000,
    isDefault: true,
  });
});

afterAll(async () => {
  await client.close();
});

describe('getRecipeWorkspace', () => {
  it('returns the full DTO for manager', async () => {
    const dto = await runInOrg(db, ORG, (tx) =>
      getRecipeWorkspace(tx, ORG, recipeId, 'manager'),
    );
    expect(dto).not.toBeNull();
    if (dto?.role !== 'manager') throw new Error('expected manager DTO');

    expect(dto.recipe.name).toBe('Bread');
    expect(dto.recipe.version).toBe(1);
    expect(dto.recipe.sellingPriceCents).toBe(1000);
    expect(dto.ingredientSections).toHaveLength(1);
    expect(dto.ingredientLines).toHaveLength(2);
    // Merged visual order: section line (1), component (2), dusting flour (3).
    expect(dto.ingredientLines[0]!.note).toBe('sifted');
    expect(dto.ingredientLines[0]!.ingredient.priceCents).toBe(120);
    expect(dto.ingredientLines[1]!.note).toBe('for dusting');
    expect(dto.componentLines).toHaveLength(1);
    expect(dto.componentLines[0]!.componentRecipeName).toBe('Starter');
    expect(dto.methodSections).toHaveLength(1);
    expect(dto.steps).toHaveLength(1);
    expect(dto.steps[0]!.media).toEqual([]);
    expect(dto.books).toEqual([
      expect.objectContaining({ bookName: 'Bakery' }),
    ]);
    expect(dto.portionOptions[0]!.sellingPriceCents).toBe(1000);
  });

  it('kitchen payload carries NO financial keys anywhere', async () => {
    const dto = await runInOrg(db, ORG, (tx) =>
      getRecipeWorkspace(tx, ORG, recipeId, 'kitchen'),
    );
    expect(dto?.role).toBe('kitchen');

    const keys = allKeysDeep(JSON.parse(JSON.stringify(dto)));
    for (const forbidden of [
      'priceCents',
      'pendingPriceCents',
      'needsPricing',
      'laborCostCents',
      'energyCostCents',
      'packagingCostCents',
      'sellingPriceCents',
      'targetFoodCostBps',
      'supplier',
    ]) {
      expect(keys.has(forbidden), `kitchen DTO leaked "${forbidden}"`).toBe(
        false,
      );
    }

    // Operational data still present for kitchen.
    if (dto?.role !== 'kitchen') throw new Error('expected kitchen DTO');
    expect(dto.ingredientLines).toHaveLength(2);
    expect(dto.steps).toHaveLength(1);
    expect(dto.portionOptions).toHaveLength(1);
    expect(dto.recipe.yieldWeightGrams).toBe(900);
  });

  it('returns null for a missing or cross-org recipe', async () => {
    expect(
      await runInOrg(db, ORG, (tx) =>
        getRecipeWorkspace(tx, ORG, 'nope', 'manager'),
      ),
    ).toBeNull();
    expect(
      await runInOrg(db, OTHER_ORG, (tx) =>
        getRecipeWorkspace(tx, OTHER_ORG, recipeId, 'manager'),
      ),
    ).toBeNull();
  });
});

describe('saveRecipeWorkspace (optimistic concurrency)', () => {
  it('saves with the correct expectedVersion and increments', async () => {
    const result = await runInOrg(db, ORG, (tx) =>
      saveRecipeWorkspace(
        tx,
        ORG,
        recipeId,
        1,
        { header: { subtitle: 'Sourdough', yieldQuantity: 3, yieldUnit: 'qt' } },
        actor,
      ),
    );
    expect(result).toEqual({ ok: true, version: 2 });
    expect(await getRecipeVersion(db, ORG, recipeId)).toBe(2);

    const dto = await runInOrg(db, ORG, (tx) =>
      getRecipeWorkspace(tx, ORG, recipeId, 'manager'),
    );
    expect(dto?.recipe.subtitle).toBe('Sourdough');
    expect(dto?.recipe.yieldQuantity).toBe(3);
    expect(dto?.recipe.yieldUnit).toBe('qt');
  });

  it('rejects a stale expectedVersion without applying anything', async () => {
    const result = await runInOrg(db, ORG, (tx) =>
      saveRecipeWorkspace(tx, ORG, recipeId, 1, { header: { subtitle: 'stale' } }, actor),
    );
    expect(result).toEqual({
      ok: false,
      reason: 'version_conflict',
      currentVersion: 2,
    });
    const dto = await runInOrg(db, ORG, (tx) =>
      getRecipeWorkspace(tx, ORG, recipeId, 'manager'),
    );
    expect(dto?.recipe.subtitle).toBe('Sourdough'); // untouched
    expect(dto?.recipe.version).toBe(2);
  });

  it('returns not_found for a missing recipe', async () => {
    const result = await runInOrg(db, ORG, (tx) =>
      saveRecipeWorkspace(tx, ORG, 'nope', 1, { header: { subtitle: 'x' } }, actor),
    );
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('two sequential saves from the same loaded version: second one conflicts', async () => {
    // Both "users" loaded version 2. First save wins…
    const first = await runInOrg(db, ORG, (tx) =>
      saveRecipeWorkspace(tx, ORG, recipeId, 2, { header: { subtitle: 'User A' } }, actor),
    );
    expect(first).toEqual({ ok: true, version: 3 });
    // …second must conflict instead of silently overwriting User A's work.
    const second = await runInOrg(db, ORG, (tx) =>
      saveRecipeWorkspace(tx, ORG, recipeId, 2, { header: { subtitle: 'User B' } }, actor),
    );
    expect(second).toEqual({
      ok: false,
      reason: 'version_conflict',
      currentVersion: 3,
    });
    const dto = await runInOrg(db, ORG, (tx) =>
      getRecipeWorkspace(tx, ORG, recipeId, 'manager'),
    );
    expect(dto?.recipe.subtitle).toBe('User A');
  });
});

describe('saveRecipeWorkspace (structural full-replace)', () => {
  it('applies sections + merged lines atomically and preserves order', async () => {
    const before = await runInOrg(db, ORG, (tx) =>
      getRecipeWorkspace(tx, ORG, recipeId, 'manager'),
    );
    if (before?.role !== 'manager') throw new Error('expected manager DTO');
    const doughSection = before.ingredientSections[0]!;
    const sifted = before.ingredientLines.find((l) => l.note === 'sifted')!;
    const dusting = before.ingredientLines.find((l) => l.note === 'for dusting')!;
    const component = before.componentLines[0]!;

    const result = await runInOrg(db, ORG, (tx) =>
      saveRecipeWorkspace(
        tx,
        ORG,
        recipeId,
        before.recipe.version,
        {
          sections: [
            { id: doughSection.id, title: 'Dough (renamed)' },
            { tempId: 'tmp-finish', title: 'Finishing' },
          ],
          lines: [
            // New merged order: component first, then dough flour, then the
            // dusting flour moved into the NEW section with a new quantity.
            {
              kind: 'component',
              id: component.id,
              componentRecipeId: component.componentRecipeId,
              quantityGrams: 175,
            },
            {
              kind: 'ingredient',
              id: sifted.id,
              ingredientId: sifted.ingredientId,
              quantity: 480,
              note: 'sifted twice',
              sectionRef: doughSection.id,
            },
            {
              kind: 'ingredient',
              id: dusting.id,
              ingredientId: dusting.ingredientId,
              quantity: 30,
              note: 'for dusting',
              sectionRef: 'tmp-finish',
            },
            // Brand-new duplicate flour line in the default group.
            {
              kind: 'ingredient',
              ingredientId: dusting.ingredientId,
              quantity: 10,
              note: 'work surface',
            },
          ],
        },
        actor,
      ),
    );
    if (!result.ok) throw new Error(`save failed: ${JSON.stringify(result)}`);

    const after = await runInOrg(db, ORG, (tx) =>
      getRecipeWorkspace(tx, ORG, recipeId, 'manager'),
    );
    if (after?.role !== 'manager') throw new Error('expected manager DTO');
    expect(after.recipe.version).toBe(result.version);
    expect(after.ingredientSections.map((s) => s.title)).toEqual([
      'Dough (renamed)',
      'Finishing',
    ]);
    expect(after.ingredientLines).toHaveLength(3);
    // Merged display order across kinds: component 0, then lines 1, 2, 3.
    expect(after.componentLines[0]!.displaySortOrder).toBe(0);
    expect(after.componentLines[0]!.quantityGrams).toBe(175);
    expect(after.ingredientLines.map((l) => l.displaySortOrder)).toEqual([
      1, 2, 3,
    ]);
    expect(after.ingredientLines[0]!.quantity).toBe(480);
    const finishing = after.ingredientSections.find(
      (s) => s.title === 'Finishing',
    )!;
    expect(after.ingredientLines[1]!.sectionId).toBe(finishing.id);
    expect(after.ingredientLines[2]!.note).toBe('work surface');
    expect(after.ingredientLines[2]!.sectionId).toBeNull();
  });

  it('deletes lines and sections absent from the draft', async () => {
    const before = await runInOrg(db, ORG, (tx) =>
      getRecipeWorkspace(tx, ORG, recipeId, 'manager'),
    );
    if (before?.role !== 'manager') throw new Error('expected manager DTO');
    const keep = before.ingredientLines[0]!;

    const result = await runInOrg(db, ORG, (tx) =>
      saveRecipeWorkspace(
        tx,
        ORG,
        recipeId,
        before.recipe.version,
        {
          sections: [],
          lines: [
            {
              kind: 'ingredient',
              id: keep.id,
              ingredientId: keep.ingredientId,
              quantity: keep.quantity,
              note: keep.note,
            },
          ],
        },
        actor,
      ),
    );
    expect(result.ok).toBe(true);

    const after = await runInOrg(db, ORG, (tx) =>
      getRecipeWorkspace(tx, ORG, recipeId, 'manager'),
    );
    if (after?.role !== 'manager') throw new Error('expected manager DTO');
    expect(after.ingredientSections).toHaveLength(0);
    expect(after.ingredientLines).toHaveLength(1);
    expect(after.componentLines).toHaveLength(0);
    expect(after.ingredientLines[0]!.sectionId).toBeNull();
  });

  it('rejects a component that would create a cycle', async () => {
    // Try to make Bread a component of itself via the draft.
    const version = (await getRecipeVersion(db, ORG, recipeId))!;
    const result = await runInOrg(db, ORG, (tx) =>
      saveRecipeWorkspace(
        tx,
        ORG,
        recipeId,
        version,
        {
          sections: [],
          lines: [
            {
              kind: 'component',
              componentRecipeId: recipeId,
              quantityGrams: 100,
            },
          ],
        },
        actor,
      ),
    );
    expect(result).toEqual({
      ok: false,
      reason: 'invalid_draft',
      detail: 'component_cycle',
    });
    expect(await getRecipeVersion(db, ORG, recipeId)).toBe(version);
  });

  it('rejects unknown section refs and trashed ingredients', async () => {
    const version = (await getRecipeVersion(db, ORG, recipeId))!;
    const badRef = await runInOrg(db, ORG, (tx) =>
      saveRecipeWorkspace(
        tx,
        ORG,
        recipeId,
        version,
        {
          sections: [],
          lines: [
            {
              kind: 'ingredient',
              ingredientId: 'whatever',
              quantity: 1,
              sectionRef: 'missing-section',
            },
          ],
        },
        actor,
      ),
    );
    expect(badRef).toEqual({
      ok: false,
      reason: 'invalid_draft',
      detail: 'unknown_section_ref',
    });

    const ghostIngredient = await runInOrg(db, ORG, (tx) =>
      saveRecipeWorkspace(
        tx,
        ORG,
        recipeId,
        version,
        {
          sections: [],
          lines: [{ kind: 'ingredient', ingredientId: 'ghost', quantity: 1 }],
        },
        actor,
      ),
    );
    expect(ghostIngredient).toEqual({
      ok: false,
      reason: 'invalid_draft',
      detail: 'ingredient_unavailable',
    });
  });
});
