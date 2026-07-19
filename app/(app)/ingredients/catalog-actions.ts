'use server';

import { revalidatePath } from 'next/cache';

import { getOrgId, getUserId } from '@/lib/auth';
import { getDb, withOrg } from '@/lib/db';
import { unexpected } from '@/lib/observability';
import { enforceRateLimit } from '@/lib/rate-limit';
import { createIngredientFromCatalog } from '@/lib/data/ingredient-catalog';
import {
  getCatalogEntry,
  searchIngredientCatalog,
} from '@/lib/ingredient-catalog';
import type { CatalogEntry } from '@/lib/ingredient-catalog/schema';
import {
  catalogSearchSchema,
  createFromCatalogSchema,
} from '@/lib/validation/ingredient-catalog';
import type { ActionResult } from '@/lib/action-result';
import type { Ingredient } from '@/lib/db/schema';

/**
 * Server Actions for the seed ingredient catalogue
 * (docs/ingredient-seed-catalog-plan.md). OPERATIONAL, so both roles may use
 * them (same as manual ingredient creation) — the created ingredient is ALWAYS
 * priceCents 0 + needsPricing true, so no financial surface exists here. The
 * dataset itself never leaves the server wholesale: search returns at most 20
 * entries. Rate-limited per org+user BEFORE any org work. No audit (D5 —
 * parity with manual creation, which is not audited either).
 */

export async function searchIngredientCatalogAction(
  input: unknown,
): Promise<ActionResult<{ entries: CatalogEntry[] }>> {
  const parsed = catalogSearchSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };
  try {
    const organizationId = await getOrgId();
    const userId = await getUserId();
    const limit = await enforceRateLimit(
      getDb(),
      'catalogSearch',
      `${organizationId}:${userId}`,
    );
    if (!limit.allowed) return { ok: false, code: 'RATE_LIMITED' };

    return {
      ok: true,
      data: { entries: searchIngredientCatalog(parsed.data.term, 20) },
    };
  } catch (error) {
    return unexpected('searchIngredientCatalogAction', error);
  }
}

export async function createIngredientFromCatalogAction(
  input: unknown,
): Promise<ActionResult<{ ingredientId: string }>> {
  const parsed = createFromCatalogSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };
  try {
    const entry = getCatalogEntry(parsed.data.catalogId);
    if (!entry) return { ok: false, code: 'NOT_FOUND' };

    const organizationId = await getOrgId();
    const outcome = await withOrg(organizationId, (tx) =>
      createIngredientFromCatalog(tx, organizationId, entry, {
        name: parsed.data.name ?? entry.nameEn,
        dimension: (parsed.data.dimension ??
          entry.dimension) as Ingredient['dimension'],
      }),
    );

    if (outcome.status === 'duplicate') {
      return { ok: false, code: 'DUPLICATE_NAME' };
    }
    revalidatePath('/ingredients');
    revalidatePath('/recipes');
    return { ok: true, data: { ingredientId: outcome.ingredient.id } };
  } catch (error) {
    return unexpected('createIngredientFromCatalogAction', error);
  }
}
