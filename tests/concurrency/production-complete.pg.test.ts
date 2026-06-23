import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import * as schema from '@/lib/db/schema';
import { ingredients, inventoryMovements } from '@/lib/db/schema';
import { runInOrg, type TenantDb } from '@/lib/db/tenant';
import { createIngredient } from '@/lib/data/ingredients';
import { createRecipe } from '@/lib/data/recipes';
import { addRecipeIngredient } from '@/lib/data/recipe-ingredients';
import {
  completeProduction,
  createProduction,
  planProduction,
} from '@/lib/data/productions';

/**
 * REAL-Postgres concurrency proof for production completion (Sprint 11b).
 *
 * Opt-in for the same reason as the recipe-line proof: PGlite is a single
 * in-process connection and cannot exercise `SELECT … FOR UPDATE` contention.
 * Point `TEST_DATABASE_URL` at a DISPOSABLE Neon branch with migrations + RLS
 * applied; without it the describe is skipped (CI stays green). See SETUP.md.
 *
 * The invariant under test: two completions of the SAME planned run race → exactly
 * one posts OUT movements (the winner), the other observes the now-completed row
 * and returns an idempotent no-op. Stock is consumed EXACTLY once — never doubled.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (typeof globalThis.WebSocket === 'undefined') {
  neonConfig.webSocketConstructor = ws;
}

describe.skipIf(!TEST_DATABASE_URL)(
  'production completion under real Postgres concurrency',
  () => {
    const ORG = `org_pconc_${Date.now()}`;
    let pool: Pool;
    let db: TenantDb;

    beforeAll(() => {
      pool = new Pool({ connectionString: TEST_DATABASE_URL });
      db = drizzle(pool, { schema }) as unknown as TenantDb;
    });

    afterAll(async () => {
      await pool.end();
    });

    it.each([0, 1, 2, 3, 4])(
      'a double-complete consumes stock exactly once (run %i)',
      async (n) => {
        // Fresh recipe (100g/portion) + ingredient with 1000g stock, planned ×3.
        const { productionId, ingredientId, updatedAt } = await runInOrg(
          db,
          ORG,
          async (tx) => {
            const ing = await createIngredient(tx, ORG, {
              name: `I${n}-${Date.now()}`,
              dimension: 'weight',
              priceCents: 1000,
            });
            await tx
              .update(ingredients)
              .set({ stockQuantity: '1000' })
              .where(eq(ingredients.id, ing.id));
            const recipe = await createRecipe(tx, ORG, { name: `R${n}-${Date.now()}` });
            const added = await addRecipeIngredient(tx, ORG, {
              recipeId: recipe.id,
              ingredientId: ing.id,
              quantity: 100,
            });
            if (!added.ok) throw new Error('line add failed');
            const created = await createProduction(
              tx,
              ORG,
              { reference: `P${n}`, notes: null, plannedFor: '2026-07-01' },
              [{ recipeId: recipe.id, plannedQty: 3 }],
            );
            if (created.status !== 'ok') throw new Error('create failed');
            const planned = await planProduction(
              tx,
              ORG,
              created.production.id,
              created.production.updatedAt,
            );
            if (planned.status !== 'ok') throw new Error('plan failed');
            return {
              productionId: planned.production.id,
              ingredientId: ing.id,
              updatedAt: planned.production.updatedAt,
            };
          },
        );

        // Race two completions with the SAME planned timestamp.
        const [a, b] = await Promise.allSettled([
          runInOrg(db, ORG, (tx) =>
            completeProduction(tx, ORG, productionId, updatedAt),
          ),
          runInOrg(db, ORG, (tx) =>
            completeProduction(tx, ORG, productionId, updatedAt),
          ),
        ]);

        // Neither side throws — a lost race is a clean no-op, not an error.
        expect(a.status).toBe('fulfilled');
        expect(b.status).toBe('fulfilled');
        if (a.status !== 'fulfilled' || b.status !== 'fulfilled') return;
        const outcomes = [a.value, b.value];
        expect(outcomes.every((o) => o.status === 'ok')).toBe(true);

        // Exactly one actually posted (alreadyCompleted === false).
        const posters = outcomes.filter(
          (o) => o.status === 'ok' && !o.alreadyCompleted,
        );
        expect(posters).toHaveLength(1);

        // Stock consumed exactly once (1000 − 300) and exactly one OUT movement.
        const state = await runInOrg(db, ORG, async (tx) => {
          const [ing] = await tx
            .select({ q: ingredients.stockQuantity })
            .from(ingredients)
            .where(and(eq(ingredients.organizationId, ORG), eq(ingredients.id, ingredientId)))
            .limit(1);
          const movements = await tx
            .select({ id: inventoryMovements.id })
            .from(inventoryMovements)
            .where(
              and(
                eq(inventoryMovements.organizationId, ORG),
                eq(inventoryMovements.sourceType, 'production'),
                eq(inventoryMovements.sourceId, productionId),
              ),
            );
          return { stock: Number(ing?.q), movementCount: movements.length };
        });
        expect(state.stock).toBe(700);
        expect(state.movementCount).toBe(1);
      },
    );
  },
);
