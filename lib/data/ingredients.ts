import { and, eq } from 'drizzle-orm';
import { ingredients } from '@/lib/db/schema';
import type { Ingredient, NewIngredient } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';

/**
 * Acesso a `ingredients` SEMPRE escopado por `organizationId` (camada de app,
 * defesa primária). O `organizationId` é injetado pelo servidor — nunca confiar
 * no client. RLS (lib/db/rls.ts) é a segunda camada.
 */

export type IngredientInput = Omit<
  NewIngredient,
  'id' | 'organizationId' | 'createdAt' | 'updatedAt'
>;

export async function listIngredients(
  db: TenantClient,
  organizationId: string,
): Promise<Ingredient[]> {
  return db
    .select()
    .from(ingredients)
    .where(eq(ingredients.organizationId, organizationId))
    .orderBy(ingredients.name);
}

export async function getIngredientById(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<Ingredient | null> {
  const rows = await db
    .select()
    .from(ingredients)
    .where(
      and(
        eq(ingredients.organizationId, organizationId),
        eq(ingredients.id, id),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function createIngredient(
  db: TenantClient,
  organizationId: string,
  input: IngredientInput,
): Promise<Ingredient> {
  const [row] = await db
    .insert(ingredients)
    .values({ ...input, organizationId })
    .returning();
  if (!row) throw new Error('Failed to create ingredient.');
  return row;
}
