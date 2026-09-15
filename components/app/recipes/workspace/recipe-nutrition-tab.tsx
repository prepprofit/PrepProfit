'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import type { NutrientKey, NutritionIssueReason } from '@/lib/calculations/nutrition';
import {
  nutritionViewStatus,
  type IngredientNutritionView,
} from '@/lib/nutrition/profile-view';
import {
  IngredientNutritionDialog,
  NUTRIENT_UNIT,
  NutritionStatusChip,
} from '@/components/app/ingredients/ingredient-nutrition-dialog';

/**
 * Nutrition tab (Recipes 2.0 Fase 6, plan §9.6). OPERATIONAL: both roles see
 * the rollup, label preview and allergens (owner decision D5). Nutrition is
 * OWNED BY THE INGREDIENT: this tab only displays the calculated result. When an
 * ingredient's profile is missing or incomplete, managers get "Add nutrition",
 * which opens the same ingredient nutrition editor as the Ingredients list —
 * over the recipe, so no context is lost — and the rollup recalculates on close.
 *
 * All math is server-side: this component only renders the pre-computed,
 * label-rounded rows. An unknown nutrient renders as "—", never 0. The label
 * is an ESTIMATE — the disclaimer is always visible and print stays gated by
 * completeness (draft print carries the watermark, slice 7).
 */

/** One pre-rounded label row (serialized `LabelNutrient`). */
export type NutritionRowView = {
  key: NutrientKey;
  rounded: number | null;
  lessThan: boolean;
  dvPercent: number | null;
};

export type NutritionLineRowView = {
  ingredientId: string;
  ingredientName: string;
  edibleWeightGrams: number | null;
  /**
   * USDA FDC id suggested by the seed ingredient catalogue (D3) — offered for
   * review inside the ingredient editor; never saved automatically.
   */
  suggestedFdcId: number | null;
  /** The ingredient's own nutrition profile (null = not added). */
  profile: IngredientNutritionView | null;
};

export type NutritionTabData = {
  status: 'complete' | 'incomplete';
  issues: {
    reason: NutritionIssueReason;
    refId: string | null;
    refName: string | null;
  }[];
  /** Label rows for ONE nutrition serving; null when no serving is defined. */
  rows: NutritionRowView[] | null;
  servingGrams: number | null;
  lines: NutritionLineRowView[];
  allergens: { contains: string[]; mayContain: string[] };
  canEdit: boolean;
};

/** Issues fixed on the ingredient itself — they get an "Add nutrition" action. */
const INGREDIENT_NUTRITION_ISSUES: ReadonlySet<NutritionIssueReason> = new Set([
  'NO_PROFILE',
  'PARTIAL_PROFILE',
]);

/** Rows indented under their parent on the facts panel, like the FDA layout. */
const INDENTED: Set<NutrientKey> = new Set([
  'saturatedFatG',
  'transFatG',
  'dietaryFiberG',
  'totalSugarsG',
  'addedSugarsG',
]);

export function RecipeNutritionTab({
  recipeId,
  data,
}: {
  recipeId: string;
  data: NutritionTabData;
}) {
  const t = useTranslations('recipes.workspace.nutrition');
  const tAllergen = useTranslations('allergens.labels');
  const router = useRouter();
  // Ingredient id whose nutrition editor is open (kept by id so a server
  // refresh of `data` never unmounts the editor mid-edit).
  const [editingId, setEditingId] = React.useState<string | null>(null);

  // Deduplicate lines per ingredient for the table (a recipe can use the same
  // ingredient on several lines; the profile is per ingredient).
  const uniqueLines = React.useMemo(() => {
    const seen = new Map<string, NutritionLineRowView>();
    for (const l of data.lines) if (!seen.has(l.ingredientId)) seen.set(l.ingredientId, l);
    return [...seen.values()];
  }, [data.lines]);
  const lineById = React.useMemo(
    () => new Map(uniqueLines.map((l) => [l.ingredientId, l])),
    [uniqueLines],
  );
  const editing = editingId ? (lineById.get(editingId) ?? null) : null;

  return (
    <div className="flex flex-col gap-4">
      {/* Completeness status (§9.6: status on top, actionable list). */}
      {data.status === 'complete' ? (
        <p className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm dark:border-emerald-800 dark:bg-emerald-950/40">
          {t('statusComplete')}
        </p>
      ) : (
        <div
          role="status"
          className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm dark:border-amber-800 dark:bg-amber-950/40"
        >
          <p className="font-medium">{t('statusIncomplete')}</p>
          <ul className="mt-1 list-disc pl-5 text-muted-foreground">
            {data.issues.map((issue, i) => {
              const fixable =
                data.canEdit &&
                issue.refId !== null &&
                INGREDIENT_NUTRITION_ISSUES.has(issue.reason) &&
                lineById.has(issue.refId);
              return (
                <li key={i}>
                  <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span>
                      {issue.refName
                        ? t(`issue.${issue.reason}`, { name: issue.refName })
                        : t(`issueGeneric.${issue.reason}`)}
                    </span>
                    {fixable ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-7 text-foreground"
                        onClick={() => setEditingId(issue.refId)}
                      >
                        {issue.reason === 'PARTIAL_PROFILE'
                          ? t('completeNutrition')
                          : t('addNutrition')}
                      </Button>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {/* Nutrition Facts preview. */}
        <div className="rounded-xl border-2 border-foreground/80 p-3 font-sans">
          <p className="text-xl font-extrabold leading-tight">{t('factsTitle')}</p>
          <p className="border-b-8 border-foreground/80 pb-1 text-xs text-muted-foreground">
            {data.servingGrams !== null
              ? t('servingSize', { grams: Math.round(data.servingGrams) })
              : t('servingUnknown')}
          </p>
          {data.rows ? (
            <table className="w-full text-sm">
              <tbody>
                {data.rows.map((row) => (
                  <tr key={row.key} className="border-b border-border last:border-b-0">
                    <td
                      className={`py-0.5 ${INDENTED.has(row.key) ? 'pl-4' : 'font-medium'}`}
                    >
                      {t(`nutrients.${row.key}`)}
                    </td>
                    <td className="py-0.5 text-right tabular-nums">
                      {row.rounded === null
                        ? '—'
                        : `${row.lessThan ? '< ' : ''}${row.rounded} ${NUTRIENT_UNIT[row.key]}`}
                    </td>
                    <td className="w-14 py-0.5 text-right tabular-nums text-muted-foreground">
                      {row.dvPercent === null ? '' : `${row.dvPercent}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="py-4 text-sm text-muted-foreground">{t('noServing')}</p>
          )}
          <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
            {t('disclaimer')}
          </p>
          <div className="mt-2">
            {data.status === 'complete' && data.rows ? (
              <Button asChild size="sm" variant="outline">
                <Link href={`/recipes/${recipeId}/nutrition-label/print`}>
                  {t('print')}
                </Link>
              </Button>
            ) : data.rows ? (
              <Button asChild size="sm" variant="ghost">
                <Link href={`/recipes/${recipeId}/nutrition-label/print`}>
                  {t('printDraft')}
                </Link>
              </Button>
            ) : (
              <Button size="sm" variant="outline" disabled>
                {t('print')}
              </Button>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-4">
          {/* Allergens: contains vs may contain, separated (§9.6). */}
          <div>
            <h3 className="mb-1 text-sm font-semibold">{t('allergens.contains')}</h3>
            {data.allergens.contains.length > 0 ? (
              <p className="flex flex-wrap gap-1">
                {data.allergens.contains.map((slug) => (
                  <span
                    key={slug}
                    className="rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-900 dark:bg-red-950/60 dark:text-red-200"
                  >
                    {tAllergen(slug)}
                  </span>
                ))}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">{t('allergens.none')}</p>
            )}
            <h3 className="mb-1 mt-3 text-sm font-semibold">
              {t('allergens.mayContain')}
            </h3>
            {data.allergens.mayContain.length > 0 ? (
              <p className="flex flex-wrap gap-1">
                {data.allergens.mayContain.map((slug) => (
                  <span
                    key={slug}
                    className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-900 dark:bg-amber-950/60 dark:text-amber-200"
                  >
                    {tAllergen(slug)}
                  </span>
                ))}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">{t('allergens.none')}</p>
            )}
          </div>

          {/* Ingredient source table (§9.6). */}
          <div>
            <h3 className="mb-1 text-sm font-semibold">{t('ingredientsTitle')}</h3>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-1 font-medium">{t('table.ingredient')}</th>
                  <th className="py-1 font-medium">{t('table.weight')}</th>
                  <th className="py-1 font-medium">{t('table.source')}</th>
                </tr>
              </thead>
              <tbody>
                {uniqueLines.map((line) => (
                  <tr key={line.ingredientId} className="border-b border-border/60">
                    <td className="py-1.5">{line.ingredientName}</td>
                    <td className="py-1.5 tabular-nums">
                      {line.edibleWeightGrams !== null
                        ? `${Math.round(line.edibleWeightGrams * 100) / 100} g`
                        : '—'}
                    </td>
                    <td className="py-1.5">
                      <span className="inline-flex flex-wrap items-center gap-1.5 text-xs">
                        {line.profile ? (
                          <span>
                            {line.profile.source === 'custom'
                              ? t('table.custom')
                              : (line.profile.sourceDescription ??
                                (line.profile.source === 'open_food_facts'
                                  ? 'Open Food Facts'
                                  : 'USDA'))}
                          </span>
                        ) : null}
                        {nutritionViewStatus(line.profile) !== 'added' ? (
                          <NutritionStatusChip status={nutritionViewStatus(line.profile)} />
                        ) : null}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {editing ? (
        <IngredientNutritionDialog
          key={editing.ingredientId}
          ingredientId={editing.ingredientId}
          ingredientName={editing.ingredientName}
          suggestedFdcId={editing.suggestedFdcId}
          profile={editing.profile}
          canEdit={data.canEdit}
          onClose={(changed) => {
            setEditingId(null);
            // Recalculate the recipe's nutrition from the updated ingredient.
            if (changed) router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}
