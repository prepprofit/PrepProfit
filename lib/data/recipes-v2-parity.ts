import { and, eq, isNull, notExists, sql } from 'drizzle-orm';
import {
  recipes,
  recipeFolders,
  recipeBooks,
  recipePortionOptions,
} from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';

/**
 * Recipes 2.0 parity check (Fase 7 Slice 6) — the READ-ONLY per-org gate for
 * removing the dual-read price fallback and trusting books. Reports, per org:
 *
 * 1. `recipesWithoutDefaultOption` — active recipes with NO default portion
 *    option (the fallback removal would make them price-less);
 * 2. `optionPriceBehindLegacy` — recipes whose default option has a NULL price
 *    while the legacy column still carries one (removal would LOSE that price);
 * 3. `foldersWithoutBook` — folders with no homonymous book (a `?folder=` view
 *    the book rail can't mirror).
 *
 * ZERO across every org = safe to retire the fallback. Divergences carry ids
 * so they can be fixed by re-running the idempotent backfill (1 and 3) or by
 * hand (2 — the backfill never overwrites an existing option).
 */
export type RecipesV2ParityReport = {
  recipesWithoutDefaultOption: string[];
  optionPriceBehindLegacy: string[];
  foldersWithoutBook: string[];
};

export function parityReportIsClean(report: RecipesV2ParityReport): boolean {
  return (
    report.recipesWithoutDefaultOption.length === 0 &&
    report.optionPriceBehindLegacy.length === 0 &&
    report.foldersWithoutBook.length === 0
  );
}

export async function checkRecipesV2Parity(
  db: TenantClient,
  organizationId: string,
): Promise<RecipesV2ParityReport> {
  const withoutOption = await db
    .select({ id: recipes.id })
    .from(recipes)
    .where(
      and(
        eq(recipes.organizationId, organizationId),
        isNull(recipes.deletedAt),
        notExists(
          db
            .select({ one: sql`1` })
            .from(recipePortionOptions)
            .where(
              and(
                eq(recipePortionOptions.organizationId, recipes.organizationId),
                eq(recipePortionOptions.recipeId, recipes.id),
                eq(recipePortionOptions.isDefault, true),
              ),
            ),
        ),
      ),
    );

  const behindLegacy = await db
    .select({ id: recipes.id })
    .from(recipes)
    .innerJoin(
      recipePortionOptions,
      and(
        eq(recipePortionOptions.organizationId, recipes.organizationId),
        eq(recipePortionOptions.recipeId, recipes.id),
        eq(recipePortionOptions.isDefault, true),
      ),
    )
    .where(
      and(
        eq(recipes.organizationId, organizationId),
        isNull(recipes.deletedAt),
        sql`${recipes.sellingPriceCents} IS NOT NULL`,
        sql`${recipePortionOptions.sellingPriceCents} IS NULL`,
      ),
    );

  const foldersUnmirrored = await db
    .select({ id: recipeFolders.id })
    .from(recipeFolders)
    .where(
      and(
        eq(recipeFolders.organizationId, organizationId),
        notExists(
          db
            .select({ one: sql`1` })
            .from(recipeBooks)
            .where(
              and(
                eq(recipeBooks.organizationId, recipeFolders.organizationId),
                eq(recipeBooks.name, recipeFolders.name),
              ),
            ),
        ),
      ),
    );

  return {
    recipesWithoutDefaultOption: withoutOption.map((r) => r.id),
    optionPriceBehindLegacy: behindLegacy.map((r) => r.id),
    foldersWithoutBook: foldersUnmirrored.map((f) => f.id),
  };
}
