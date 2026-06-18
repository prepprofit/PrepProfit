import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import * as schema from '@/lib/db/schema';
import { ingredients, recipeIngredients } from '@/lib/db/schema';
import { runInOrg, type TenantDb } from '@/lib/db/tenant';
import { createIngredient } from '@/lib/data/ingredients';
import { createRecipe } from '@/lib/data/recipes';
import { trashIngredient } from '@/lib/data/ingredients';
import { addRecipeIngredient } from '@/lib/data/recipe-ingredients';

/**
 * REAL-Postgres concurrency proof for the recipe-line invariant (Sprint 3.1).
 *
 * Why this is opt-in and lives outside the normal suite: PGlite (the default test
 * DB) is a SINGLE in-process connection, so it cannot run two transactions
 * concurrently and therefore cannot exercise `SELECT … FOR UPDATE` contention —
 * the exact mechanism that protects the invariant. We need a real Postgres with
 * real concurrent sessions.
 *
 * Setup: point `TEST_DATABASE_URL` at a DISPOSABLE Neon branch that already has
 * the migrations + RLS applied (`DATABASE_URL=<branch> npm run db:migrate`). The
 * `@neondatabase/serverless` Pool talks to Neon over WebSocket and gives each
 * transaction its own connection, so `Promise.all` of two `runInOrg` calls races
 * for real. Without the env var the whole describe is skipped (CI stays green
 * with no database). See SETUP.md.
 *
 * The invariant under test: an ACTIVE recipe line never references a TRASHED
 * ingredient. `addRecipeIngredient` and `trashIngredient` both take the
 * ingredient row `FOR UPDATE`, so one must lose the race deterministically.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (typeof globalThis.WebSocket === 'undefined') {
  neonConfig.webSocketConstructor = ws;
}

describe.skipIf(!TEST_DATABASE_URL)(
  'recipe-line invariant under real Postgres concurrency',
  () => {
    const ORG = `org_conc_${Date.now()}`;
    let pool: Pool;
    let db: TenantDb;

    beforeAll(() => {
      pool = new Pool({ connectionString: TEST_DATABASE_URL });
      db = drizzle(pool, { schema }) as unknown as TenantDb;
    });

    afterAll(async () => {
      await pool.end();
    });

    // Run the race several times: ordering depends on who grabs the lock first, so
    // repeating raises the chance of exercising both interleavings.
    it.each([0, 1, 2, 3, 4])(
      'never leaves an active line pointing at a trashed ingredient (run %i)',
      async (n) => {
        // Fresh recipe + ingredient per run (active, not yet linked).
        const { recipeId, ingredientId } = await runInOrg(db, ORG, async (tx) => {
          const recipe = await createRecipe(tx, ORG, { name: `R${n}-${Date.now()}` });
          const ingredient = await createIngredient(tx, ORG, {
            name: `I${n}-${Date.now()}`,
            dimension: 'weight',
            priceCents: 100,
          });
          return { recipeId: recipe.id, ingredientId: ingredient.id };
        });

        // Race: add the ingredient to the recipe vs. trash the ingredient.
        const [addResult, trashResult] = await Promise.allSettled([
          runInOrg(db, ORG, (tx) =>
            addRecipeIngredient(tx, ORG, {
              recipeId,
              ingredientId,
              quantity: 100,
            }),
          ),
          runInOrg(db, ORG, (tx) => trashIngredient(tx, ORG, ingredientId)),
        ]);

        // Neither side should throw (a lost race is a clean refusal, not an error).
        expect(addResult.status).toBe('fulfilled');
        expect(trashResult.status).toBe('fulfilled');

        // Observe the final state.
        const state = await runInOrg(db, ORG, async (tx) => {
          const [ing] = await tx
            .select({ deletedAt: ingredients.deletedAt })
            .from(ingredients)
            .where(and(eq(ingredients.organizationId, ORG), eq(ingredients.id, ingredientId)))
            .limit(1);
          const lines = await tx
            .select({ id: recipeIngredients.id })
            .from(recipeIngredients)
            .where(
              and(
                eq(recipeIngredients.organizationId, ORG),
                eq(recipeIngredients.ingredientId, ingredientId),
              ),
            );
          return { trashed: ing?.deletedAt != null, hasLine: lines.length > 0 };
        });

        // THE INVARIANT: never both trashed and referenced by a (active) line.
        expect(state.trashed && state.hasLine).toBe(false);
        // And exactly one side won — the operation made progress, no deadlock.
        expect(state.trashed || state.hasLine).toBe(true);
      },
    );
  },
);
