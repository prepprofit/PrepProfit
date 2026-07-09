import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import type { TenantDb } from '@/lib/db/tenant';
import { createRecipe, softDeleteRecipe } from '@/lib/data/recipes';
import { purgeRecipeWithGuards } from '@/lib/data/recipe-purge';
import {
  addRecipeComponent,
  assertNoRecipeComponentCycle,
  countActiveParentsUsingComponent,
  countAnyParentsUsingComponent,
  listComponentPickerRecipes,
  listRecipeComponents,
  removeRecipeComponent,
  reorderRecipeComponents,
  updateRecipeComponent,
} from '@/lib/data/recipe-components';

const ORG = 'org_rc';

let client: PGlite;
let db: TenantDb;

const makeRecipe = (name: string, yieldWeightGrams: number | null = 1000) =>
  createRecipe(db, ORG, { name, yieldWeightGrams });

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  db = test.db as unknown as TenantDb;
});

afterAll(async () => {
  await client.close();
});

describe('addRecipeComponent — guards', () => {
  it('adds an active, yield-bearing component to an active parent', async () => {
    const parent = await makeRecipe('Cake');
    const child = await makeRecipe('Cream');
    const result = await addRecipeComponent(db, ORG, parent.id, {
      componentRecipeId: child.id,
      quantityGrams: 250,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.row.quantityGrams).toBe(250);
      expect(result.row.sortOrder).toBe(0);
    }
  });

  it('refuses a trashed parent', async () => {
    const parent = await makeRecipe('Trashed parent');
    const child = await makeRecipe('Child A');
    await softDeleteRecipe(db, ORG, parent.id);
    const result = await addRecipeComponent(db, ORG, parent.id, {
      componentRecipeId: child.id,
      quantityGrams: 100,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('recipe_not_active');
  });

  it('refuses a trashed component', async () => {
    const parent = await makeRecipe('Parent B');
    const child = await makeRecipe('Trashed child');
    await softDeleteRecipe(db, ORG, child.id);
    const result = await addRecipeComponent(db, ORG, parent.id, {
      componentRecipeId: child.id,
      quantityGrams: 100,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('component_invalid');
  });

  it('refuses a component without a positive yield weight', async () => {
    const parent = await makeRecipe('Parent C');
    const child = await makeRecipe('No-yield child', null);
    const result = await addRecipeComponent(db, ORG, parent.id, {
      componentRecipeId: child.id,
      quantityGrams: 100,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('component_invalid');
  });

  it('refuses self-reference', async () => {
    const parent = await makeRecipe('Self');
    const result = await addRecipeComponent(db, ORG, parent.id, {
      componentRecipeId: parent.id,
      quantityGrams: 100,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('component_invalid');
  });

  it('refuses a duplicate (parent, component) line', async () => {
    const parent = await makeRecipe('Dup parent');
    const child = await makeRecipe('Dup child');
    const first = await addRecipeComponent(db, ORG, parent.id, {
      componentRecipeId: child.id,
      quantityGrams: 100,
    });
    expect(first.ok).toBe(true);
    const second = await addRecipeComponent(db, ORG, parent.id, {
      componentRecipeId: child.id,
      quantityGrams: 200,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('duplicate');
  });

  it('refuses a missing/cross-org component', async () => {
    const parent = await makeRecipe('X-org parent');
    const foreign = await createRecipe(db, 'org_other', {
      name: 'Foreign',
      yieldWeightGrams: 500,
    });
    const result = await addRecipeComponent(db, ORG, parent.id, {
      componentRecipeId: foreign.id,
      quantityGrams: 100,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('component_invalid');
  });
});

describe('cycle and depth checks', () => {
  it('rejects a direct 2-cycle (A→B then B→A)', async () => {
    const a = await makeRecipe('Cyc A');
    const b = await makeRecipe('Cyc B');
    const first = await addRecipeComponent(db, ORG, a.id, {
      componentRecipeId: b.id,
      quantityGrams: 100,
    });
    expect(first.ok).toBe(true);
    const back = await addRecipeComponent(db, ORG, b.id, {
      componentRecipeId: a.id,
      quantityGrams: 100,
    });
    expect(back.ok).toBe(false);
    if (!back.ok) expect(back.reason).toBe('cycle');
  });

  it('rejects a 3-cycle (A→B→C then C→A)', async () => {
    const a = await makeRecipe('Tri A');
    const b = await makeRecipe('Tri B');
    const c = await makeRecipe('Tri C');
    expect(
      (await addRecipeComponent(db, ORG, a.id, { componentRecipeId: b.id, quantityGrams: 1 })).ok,
    ).toBe(true);
    expect(
      (await addRecipeComponent(db, ORG, b.id, { componentRecipeId: c.id, quantityGrams: 1 })).ok,
    ).toBe(true);
    const back = await addRecipeComponent(db, ORG, c.id, {
      componentRecipeId: a.id,
      quantityGrams: 1,
    });
    expect(back.ok).toBe(false);
    if (!back.ok) expect(back.reason).toBe('cycle');
  });

  it('rejects a chain that would exceed depth 5, joining two existing chains', async () => {
    // Build d0→d1→d2 and d3→d4→d5, then link d2→d3: up(2) + 1 + down(2) = 5 OK.
    // Then adding above d0 (top→d0) would make 6 → rejected.
    const r: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      r.push((await makeRecipe(`Depth ${i}`)).id);
    }
    for (const [parent, child] of [
      [r[0]!, r[1]!],
      [r[1]!, r[2]!],
      [r[3]!, r[4]!],
      [r[4]!, r[5]!],
    ] as const) {
      expect(
        (await addRecipeComponent(db, ORG, parent, { componentRecipeId: child, quantityGrams: 1 })).ok,
      ).toBe(true);
    }
    const join = await addRecipeComponent(db, ORG, r[2]!, {
      componentRecipeId: r[3]!,
      quantityGrams: 1,
    });
    expect(join.ok).toBe(true); // exactly 5 edges

    const top = await makeRecipe('Depth top');
    const tooDeep = await addRecipeComponent(db, ORG, top.id, {
      componentRecipeId: r[0]!,
      quantityGrams: 1,
    });
    expect(tooDeep.ok).toBe(false);
    if (!tooDeep.ok) expect(tooDeep.reason).toBe('depth_exceeded');
  });

  it('assertNoRecipeComponentCycle allows a diamond (shared component)', async () => {
    const top = await makeRecipe('Dia top');
    const left = await makeRecipe('Dia left');
    const right = await makeRecipe('Dia right');
    const base = await makeRecipe('Dia base');
    for (const [p, c] of [
      [top.id, left.id],
      [top.id, right.id],
      [left.id, base.id],
    ] as const) {
      expect(
        (await addRecipeComponent(db, ORG, p, { componentRecipeId: c, quantityGrams: 1 })).ok,
      ).toBe(true);
    }
    const check = await assertNoRecipeComponentCycle(db, ORG, right.id, base.id);
    expect(check).toEqual({ ok: true });
  });
});

describe('update / remove / reorder — active-parent contract', () => {
  it('updates quantity on an active parent and refuses after trash', async () => {
    const parent = await makeRecipe('Upd parent');
    const child = await makeRecipe('Upd child');
    const added = await addRecipeComponent(db, ORG, parent.id, {
      componentRecipeId: child.id,
      quantityGrams: 100,
    });
    if (!added.ok) throw new Error('seed add failed');

    const updated = await updateRecipeComponent(db, ORG, parent.id, added.row.id, {
      quantityGrams: 175.5,
    });
    expect(updated?.quantityGrams).toBe(175.5);

    await softDeleteRecipe(db, ORG, parent.id);
    const afterTrash = await updateRecipeComponent(db, ORG, parent.id, added.row.id, {
      quantityGrams: 1,
    });
    expect(afterTrash).toBeNull();
  });

  it('removes only with a matching (org, parent, id) triple', async () => {
    const parent = await makeRecipe('Rem parent');
    const other = await makeRecipe('Rem other');
    const child = await makeRecipe('Rem child');
    const added = await addRecipeComponent(db, ORG, parent.id, {
      componentRecipeId: child.id,
      quantityGrams: 100,
    });
    if (!added.ok) throw new Error('seed add failed');

    // Wrong parent id → no-op.
    expect(await removeRecipeComponent(db, ORG, other.id, added.row.id)).toBe(false);
    expect(await removeRecipeComponent(db, ORG, parent.id, added.row.id)).toBe(true);
    expect(await removeRecipeComponent(db, ORG, parent.id, added.row.id)).toBe(false);
  });

  it('reorders with an exact id set; stale on mismatch', async () => {
    const parent = await makeRecipe('Ord parent');
    const c1 = await makeRecipe('Ord c1');
    const c2 = await makeRecipe('Ord c2');
    const a1 = await addRecipeComponent(db, ORG, parent.id, {
      componentRecipeId: c1.id,
      quantityGrams: 10,
      sortOrder: 0,
    });
    const a2 = await addRecipeComponent(db, ORG, parent.id, {
      componentRecipeId: c2.id,
      quantityGrams: 20,
      sortOrder: 1,
    });
    if (!a1.ok || !a2.ok) throw new Error('seed add failed');

    const reordered = await reorderRecipeComponents(db, ORG, parent.id, [
      a2.row.id,
      a1.row.id,
    ]);
    expect(reordered).toEqual({ status: 'ok', count: 2 });
    const lines = await listRecipeComponents(db, ORG, [parent.id]);
    expect(lines.map((l) => l.id)).toEqual([a2.row.id, a1.row.id]);

    expect(
      (await reorderRecipeComponents(db, ORG, parent.id, [a1.row.id])).status,
    ).toBe('stale');
    expect(
      (
        await reorderRecipeComponents(db, ORG, parent.id, [
          a1.row.id,
          a1.row.id,
        ])
      ).status,
    ).toBe('stale');
    expect(
      (await reorderRecipeComponents(db, ORG, 'missing', [a1.row.id])).status,
    ).toBe('not_found');
  });
});

describe('listRecipeComponents / picker / usage counts', () => {
  it('lists lines with component metadata in sort order', async () => {
    const parent = await makeRecipe('List parent');
    const child = await makeRecipe('List child', 750);
    const added = await addRecipeComponent(db, ORG, parent.id, {
      componentRecipeId: child.id,
      quantityGrams: 300,
    });
    expect(added.ok).toBe(true);
    const lines = await listRecipeComponents(db, ORG, [parent.id]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      componentName: 'List child',
      componentYieldWeightGrams: 750,
      componentDeletedAt: null,
      quantityGrams: 300,
    });
    expect(await listRecipeComponents(db, ORG, [])).toEqual([]);
  });

  it('picker excludes self, flags no-yield and cycle candidates', async () => {
    const parent = await makeRecipe('Pick parent');
    const grand = await makeRecipe('Pick grand');
    const noYield = await makeRecipe('Pick no-yield', null);
    const ok = await addRecipeComponent(db, ORG, grand.id, {
      componentRecipeId: parent.id,
      quantityGrams: 1,
    });
    expect(ok.ok).toBe(true); // grand is now an ANCESTOR of parent → cycle candidate

    const picker = await listComponentPickerRecipes(db, ORG, parent.id);
    const byId = new Map(picker.map((p) => [p.id, p]));
    expect(byId.has(parent.id)).toBe(false);
    expect(byId.get(grand.id)).toMatchObject({
      selectable: false,
      disabledReason: 'cycle',
    });
    expect(byId.get(noYield.id)).toMatchObject({
      selectable: false,
      disabledReason: 'no_yield',
    });
  });

  it('counts active vs any parents using a component', async () => {
    const p1 = await makeRecipe('Cnt p1');
    const p2 = await makeRecipe('Cnt p2');
    const child = await makeRecipe('Cnt child');
    for (const p of [p1, p2]) {
      const r = await addRecipeComponent(db, ORG, p.id, {
        componentRecipeId: child.id,
        quantityGrams: 1,
      });
      expect(r.ok).toBe(true);
    }
    expect(await countActiveParentsUsingComponent(db, ORG, child.id)).toBe(2);
    expect(await countAnyParentsUsingComponent(db, ORG, child.id)).toBe(2);

    await softDeleteRecipe(db, ORG, p1.id);
    expect(await countActiveParentsUsingComponent(db, ORG, child.id)).toBe(1);
    expect(await countAnyParentsUsingComponent(db, ORG, child.id)).toBe(2);
  });
});

describe('purge guards (sub-recipes)', () => {
  it('blocks purging a component with surviving references, even under a trashed parent', async () => {
    const parent = await makeRecipe('Purge parent');
    const child = await makeRecipe('Purge child');
    const added = await addRecipeComponent(db, ORG, parent.id, {
      componentRecipeId: child.id,
      quantityGrams: 100,
    });
    expect(added.ok).toBe(true);

    // Trash BOTH (bypassing action guards to simulate the surviving-row state).
    await softDeleteRecipe(db, ORG, parent.id);
    await softDeleteRecipe(db, ORG, child.id);

    // The child is still referenced by the trashed parent's component row.
    expect(await purgeRecipeWithGuards(db, ORG, child.id)).toBe('in_component');

    // Purging the PARENT cascades its component rows; then the child purges fine.
    expect(await purgeRecipeWithGuards(db, ORG, parent.id)).toBe('ok');
    expect(await purgeRecipeWithGuards(db, ORG, child.id)).toBe('ok');
  });
});
