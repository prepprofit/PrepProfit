'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useActionError } from '@/lib/i18n/use-action-error';
import { NUTRIENT_KEYS, type NutrientKey } from '@/lib/calculations/nutrition';
import type { NutritionIssueReason } from '@/lib/calculations/nutrition';
import {
  refreshIngredientNutritionAction,
  saveIngredientNutritionAction,
  searchUsdaFoodsAction,
} from '@/app/(app)/ingredients/nutrition-actions';

/**
 * Nutrition tab (Recipes 2.0 Fase 6, plan §9.6). OPERATIONAL: both roles see
 * the rollup, label preview and allergens (owner decision D5); profile editing
 * (USDA search / custom / refresh) is manager-only — `canEdit` comes from the
 * server payload and every action re-checks RBAC server-side anyway.
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
  profile: {
    source: 'usda' | 'custom';
    sourceDescription: string | null;
    brandOwner: string | null;
    fdcId: number | null;
    values: Record<NutrientKey, number | null>;
  } | null;
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

const NUTRIENT_UNIT: Record<NutrientKey, string> = {
  caloriesKcal: 'kcal',
  totalFatG: 'g',
  saturatedFatG: 'g',
  transFatG: 'g',
  cholesterolMg: 'mg',
  sodiumMg: 'mg',
  totalCarbohydrateG: 'g',
  dietaryFiberG: 'g',
  totalSugarsG: 'g',
  addedSugarsG: 'g',
  proteinG: 'g',
  vitaminDMcg: 'mcg',
  calciumMg: 'mg',
  ironMg: 'mg',
  potassiumMg: 'mg',
  caffeineMg: 'mg',
};

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
  const [editing, setEditing] = React.useState<NutritionLineRowView | null>(null);

  // Deduplicate lines per ingredient for the table (a recipe can use the same
  // ingredient on several lines; the profile is per ingredient).
  const uniqueLines = React.useMemo(() => {
    const seen = new Map<string, NutritionLineRowView>();
    for (const l of data.lines) if (!seen.has(l.ingredientId)) seen.set(l.ingredientId, l);
    return [...seen.values()];
  }, [data.lines]);

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
            {data.issues.map((issue, i) => (
              <li key={i}>
                {issue.refName
                  ? t(`issue.${issue.reason}`, { name: issue.refName })
                  : t(`issueGeneric.${issue.reason}`)}
              </li>
            ))}
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
                  {data.canEdit ? <th className="py-1" /> : null}
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
                      {line.profile ? (
                        <span className="text-xs">
                          {line.profile.source === 'usda'
                            ? (line.profile.sourceDescription ?? 'USDA')
                            : t('table.custom')}
                        </span>
                      ) : (
                        <span className="text-xs text-amber-700 dark:text-amber-300">
                          {t('table.missing')}
                        </span>
                      )}
                    </td>
                    {data.canEdit ? (
                      <td className="py-1.5 text-right">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => setEditing(line)}
                        >
                          {line.profile ? t('table.edit') : t('table.add')}
                        </Button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {editing ? (
        <NutritionEditDialog line={editing} onClose={() => setEditing(null)} />
      ) : null}
    </div>
  );
}

// ───────────────────────────── edit dialog ──────────────────────────────────

type UsdaResultView = {
  fdcId: number;
  description: string;
  dataType: string | null;
  brandOwner: string | null;
  nutrientsPer100g: Record<NutrientKey, number | null>;
};

function NutritionEditDialog({
  line,
  onClose,
}: {
  line: NutritionLineRowView;
  onClose: () => void;
}) {
  const t = useTranslations('recipes.workspace.nutrition.editor');
  const tNutrient = useTranslations('recipes.workspace.nutrition.nutrients');
  const actionError = useActionError();
  const router = useRouter();

  const [mode, setMode] = React.useState<'usda' | 'custom'>('usda');
  const [scope, setScope] = React.useState<'common' | 'branded'>('common');
  const [query, setQuery] = React.useState(line.ingredientName);
  const [results, setResults] = React.useState<UsdaResultView[] | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [usdaDisabled, setUsdaDisabled] = React.useState(false);

  const [customValues, setCustomValues] = React.useState<Record<NutrientKey, string>>(
    () => {
      const initial = {} as Record<NutrientKey, string>;
      for (const k of NUTRIENT_KEYS) {
        const v = line.profile?.values[k];
        initial[k] = v == null ? '' : String(v);
      }
      return initial;
    },
  );

  const search = async () => {
    setBusy(true);
    setError(null);
    const result = await searchUsdaFoodsAction({ query, scope });
    setBusy(false);
    if (result.ok) {
      setResults(result.data.foods);
    } else if (result.code === 'USDA_NOT_CONFIGURED') {
      setUsdaDisabled(true);
      setMode('custom');
    } else {
      setError(actionError(result.code));
    }
  };

  const saveUsda = async (fdcId: number) => {
    setBusy(true);
    setError(null);
    const result = await saveIngredientNutritionAction({
      source: 'usda',
      ingredientId: line.ingredientId,
      fdcId,
    });
    setBusy(false);
    if (result.ok) {
      onClose();
      router.refresh();
    } else {
      setError(actionError(result.code));
    }
  };

  const saveCustom = async () => {
    const values = {} as Record<NutrientKey, number | null>;
    for (const k of NUTRIENT_KEYS) {
      const raw = customValues[k].trim().replace(',', '.');
      if (raw === '') {
        values[k] = null;
        continue;
      }
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 0) {
        setError(t('invalidValue'));
        return;
      }
      values[k] = parsed;
    }
    setBusy(true);
    setError(null);
    const result = await saveIngredientNutritionAction({
      source: 'custom',
      ingredientId: line.ingredientId,
      values,
    });
    setBusy(false);
    if (result.ok) {
      onClose();
      router.refresh();
    } else {
      setError(actionError(result.code));
    }
  };

  const refresh = async () => {
    setBusy(true);
    setError(null);
    const result = await refreshIngredientNutritionAction({
      ingredientId: line.ingredientId,
    });
    setBusy(false);
    if (result.ok) {
      onClose();
      router.refresh();
    } else {
      setError(actionError(result.code));
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogTitle>{t('title', { name: line.ingredientName })}</DialogTitle>

        {error ? (
          <p role="alert" className="text-sm text-red-700 dark:text-red-300">
            {error}
          </p>
        ) : null}

        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant={mode === 'usda' ? 'default' : 'outline'}
            disabled={usdaDisabled}
            onClick={() => setMode('usda')}
          >
            {t('usdaTab')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={mode === 'custom' ? 'default' : 'outline'}
            onClick={() => setMode('custom')}
          >
            {t('customTab')}
          </Button>
          {line.profile?.source === 'usda' ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="ml-auto"
              disabled={busy}
              onClick={refresh}
            >
              {t('refresh')}
            </Button>
          ) : null}
        </div>

        {usdaDisabled ? (
          <p className="text-xs text-muted-foreground">{t('usdaNotConfigured')}</p>
        ) : null}

        {mode === 'usda' && !usdaDisabled ? (
          <div className="flex flex-col gap-2">
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant={scope === 'common' ? 'default' : 'ghost'}
                onClick={() => setScope('common')}
              >
                {t('common')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant={scope === 'branded' ? 'default' : 'ghost'}
                onClick={() => setScope('branded')}
              >
                {t('branded')}
              </Button>
            </div>
            <div className="flex gap-2">
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void search();
                  }
                }}
                placeholder={t('searchPlaceholder')}
                aria-label={t('searchPlaceholder')}
              />
              <Button type="button" size="sm" onClick={search} disabled={busy}>
                {busy ? t('searching') : t('search')}
              </Button>
            </div>
            {results !== null ? (
              results.length > 0 ? (
                <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto">
                  {results.map((food) => (
                    <li key={food.fdcId}>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => saveUsda(food.fdcId)}
                        className="w-full rounded-md border border-border px-3 py-2 text-left text-sm hover:bg-surface-2"
                      >
                        <span className="font-medium">{food.description}</span>
                        <span className="block text-xs text-muted-foreground">
                          {[food.brandOwner, food.dataType]
                            .filter(Boolean)
                            .join(' · ')}
                          {food.nutrientsPer100g.caloriesKcal !== null
                            ? ` · ${food.nutrientsPer100g.caloriesKcal} kcal/100 g`
                            : ''}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">{t('noResults')}</p>
              )
            ) : null}
            <p className="text-[11px] text-muted-foreground">{t('attribution')}</p>
          </div>
        ) : null}

        {mode === 'custom' || usdaDisabled ? (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-muted-foreground">{t('customHint')}</p>
            <div className="grid grid-cols-2 gap-2">
              {NUTRIENT_KEYS.map((key) => (
                <label key={key} className="flex flex-col gap-1 text-xs">
                  <span>
                    {tNutrient(key)} ({NUTRIENT_UNIT[key]})
                  </span>
                  <Input
                    value={customValues[key]}
                    inputMode="decimal"
                    onChange={(e) =>
                      setCustomValues({ ...customValues, [key]: e.target.value })
                    }
                    className="h-8"
                  />
                </label>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" size="sm" onClick={onClose}>
                {t('cancel')}
              </Button>
              <Button type="button" size="sm" onClick={saveCustom} disabled={busy}>
                {busy ? t('saving') : t('save')}
              </Button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
