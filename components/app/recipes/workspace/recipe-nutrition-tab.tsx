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
import type { NutritionSourceType } from '@/lib/external-food/types';
import {
  lookupExternalFoodByBarcodeAction,
  refreshIngredientNutritionAction,
  saveIngredientNutritionAction,
  searchUsdaFoodsAction,
  type ExternalFoodPreview,
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
  /**
   * USDA FDC id suggested by the seed ingredient catalogue (D3) — a HINT for a
   * one-click import while no profile exists; the save re-fetches server-side.
   */
  suggestedFdcId: number | null;
  profile: {
    source: NutritionSourceType;
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

/** Core nutrients an Open Food Facts label maps — shown in the packaged preview. */
const OFF_PREVIEW_KEYS: NutrientKey[] = [
  'caloriesKcal',
  'totalFatG',
  'saturatedFatG',
  'totalCarbohydrateG',
  'totalSugarsG',
  'dietaryFiberG',
  'proteinG',
  'sodiumMg',
];

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
                          {line.profile.source === 'custom'
                            ? t('table.custom')
                            : (line.profile.sourceDescription ??
                              (line.profile.source === 'open_food_facts'
                                ? 'Open Food Facts'
                                : 'USDA'))}
                        </span>
                      ) : (
                        <span className="text-xs text-amber-700 dark:text-amber-300">
                          {t('table.missing')}
                        </span>
                      )}
                    </td>
                    {data.canEdit ? (
                      <td className="py-1.5 text-right">
                        <span className="inline-flex items-center gap-1">
                          {!line.profile && line.suggestedFdcId !== null ? (
                            <UseSuggestedProfileButton line={line} />
                          ) : null}
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => setEditing(line)}
                          >
                            {line.profile ? t('table.edit') : t('table.add')}
                          </Button>
                        </span>
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

/**
 * One-click import of the catalogue-suggested USDA profile (D3). Manager-only
 * by placement (rendered under canEdit) AND server-side (the action is
 * FORBIDDEN otherwise). The server re-fetches the food by fdcId — no nutrient
 * values travel from the client.
 */
function UseSuggestedProfileButton({ line }: { line: NutritionLineRowView }) {
  const t = useTranslations('recipes.workspace.nutrition.table');
  const actionError = useActionError();
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const onUse = async () => {
    if (line.suggestedFdcId === null) return;
    setBusy(true);
    setError(null);
    const result = await saveIngredientNutritionAction({
      source: 'usda',
      ingredientId: line.ingredientId,
      fdcId: line.suggestedFdcId,
    });
    setBusy(false);
    if (result.ok) router.refresh();
    else setError(actionError(result.code));
  };

  return (
    <span className="inline-flex items-center gap-1">
      {error ? (
        <span role="alert" className="text-xs text-red-700 dark:text-red-300">
          {error}
        </span>
      ) : null}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={busy}
        title={t('useSuggestedTitle')}
        onClick={onUse}
      >
        {busy ? t('useSuggestedBusy') : t('useSuggested')}
      </Button>
    </span>
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

  const [mode, setMode] = React.useState<'generic' | 'packaged' | 'manual'>(
    'generic',
  );
  const [scope, setScope] = React.useState<'common' | 'branded'>('common');
  const [query, setQuery] = React.useState(line.ingredientName);
  const [results, setResults] = React.useState<UsdaResultView[] | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [usdaDisabled, setUsdaDisabled] = React.useState(false);
  // Packaged-product (Open Food Facts) mode.
  const [barcode, setBarcode] = React.useState('');
  const [preview, setPreview] = React.useState<ExternalFoodPreview | null>(null);
  const [offDisabled, setOffDisabled] = React.useState(false);

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
      setMode('manual');
    } else {
      setError(actionError(result.code));
    }
  };

  const lookupBarcode = async () => {
    setBusy(true);
    setError(null);
    setPreview(null);
    const result = await lookupExternalFoodByBarcodeAction({
      ingredientId: line.ingredientId,
      barcode,
    });
    setBusy(false);
    if (result.ok) {
      setPreview(result.data.preview);
    } else if (result.code === 'OPEN_FOOD_FACTS_DISABLED') {
      setOffDisabled(true);
    } else {
      setError(actionError(result.code));
    }
  };

  const saveOff = async (confirmPartial: boolean) => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    const result = await saveIngredientNutritionAction({
      source: 'open_food_facts',
      ingredientId: line.ingredientId,
      barcode: preview.barcode ?? barcode,
      confirmPartial,
    });
    setBusy(false);
    if (result.ok) {
      onClose();
      router.refresh();
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

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant={mode === 'generic' ? 'default' : 'outline'}
            onClick={() => setMode('generic')}
          >
            {t('modeGeneric')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={mode === 'packaged' ? 'default' : 'outline'}
            onClick={() => setMode('packaged')}
          >
            {t('modePackaged')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={mode === 'manual' ? 'default' : 'outline'}
            onClick={() => setMode('manual')}
          >
            {t('modeManual')}
          </Button>
          {line.profile && line.profile.source !== 'custom' ? (
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

        {usdaDisabled && mode === 'generic' ? (
          <p className="text-xs text-muted-foreground">{t('usdaNotConfigured')}</p>
        ) : null}

        {mode === 'packaged' ? (
          <PackagedProductPane
            barcode={barcode}
            setBarcode={setBarcode}
            preview={preview}
            offDisabled={offDisabled}
            busy={busy}
            onLookup={lookupBarcode}
            onSave={saveOff}
          />
        ) : null}

        {mode === 'generic' && !usdaDisabled ? (
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

        {mode === 'manual' || (mode === 'generic' && usdaDisabled) ? (
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

// ─────────────────────── packaged product (Open Food Facts) ──────────────────

const OFF_LICENSE_URL = 'https://opendatacommons.org/licenses/odbl/1-0/';

function offProductUrl(barcode: string | null): string {
  return `https://world.openfoodfacts.org/product/${barcode ?? ''}`;
}

/**
 * Packaged-product tab (§15): explicit barcode input + Look up button (NEVER
 * search-as-you-type), a review card with the normalized product, missing
 * values, quality notes and the required Open Food Facts attribution, plus the
 * 100 ml equivalency / partial-confirmation gate before saving.
 */
function PackagedProductPane({
  barcode,
  setBarcode,
  preview,
  offDisabled,
  busy,
  onLookup,
  onSave,
}: {
  barcode: string;
  setBarcode: (v: string) => void;
  preview: ExternalFoodPreview | null;
  offDisabled: boolean;
  busy: boolean;
  onLookup: () => void;
  onSave: (confirmPartial: boolean) => void;
}) {
  const t = useTranslations('recipes.workspace.nutrition.editor');
  const tNutrient = useTranslations('recipes.workspace.nutrition.nutrients');

  if (offDisabled) {
    return <p className="text-xs text-muted-foreground">{t('offDisabled')}</p>;
  }

  const missing = preview
    ? OFF_PREVIEW_KEYS.filter((k) => preview.nutrients[k] === null)
    : [];

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">{t('packagedHint')}</p>
      <div className="flex gap-2">
        <Input
          value={barcode}
          inputMode="numeric"
          onChange={(e) => setBarcode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void onLookup();
            }
          }}
          placeholder={t('barcodePlaceholder')}
          aria-label={t('barcodeLabel')}
        />
        <Button type="button" size="sm" onClick={onLookup} disabled={busy || !barcode}>
          {busy ? t('barcodeSearching') : t('barcodeSearch')}
        </Button>
      </div>

      {preview ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
          <div>
            <p className="text-sm font-semibold">{preview.description}</p>
            {preview.brandOwner ? (
              <p className="text-xs text-muted-foreground">{preview.brandOwner}</p>
            ) : null}
          </div>

          {preview.stale ? (
            <p className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] dark:border-amber-800 dark:bg-amber-950/40">
              {t('preview.stale')}
            </p>
          ) : null}

          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            {preview.packageQuantity ? (
              <>
                <dt className="text-muted-foreground">{t('preview.packageQuantity')}</dt>
                <dd className="tabular-nums">{preview.packageQuantity}</dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">{t('preview.barcode')}</dt>
            <dd className="tabular-nums">{preview.barcode}</dd>
            {preview.sourceLanguage ? (
              <>
                <dt className="text-muted-foreground">{t('preview.language')}</dt>
                <dd className="uppercase">{preview.sourceLanguage}</dd>
              </>
            ) : null}
            {preview.sourceCountry ? (
              <>
                <dt className="text-muted-foreground">{t('preview.countries')}</dt>
                <dd className="capitalize">{preview.sourceCountry}</dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">{t('preview.basis')}</dt>
            <dd>
              {preview.basisUnit === 'ml' ? t('preview.basisMl') : t('preview.basisG')}
            </dd>
          </dl>

          <table className="w-full text-xs">
            <tbody>
              {OFF_PREVIEW_KEYS.map((key) =>
                preview.nutrients[key] !== null ? (
                  <tr key={key} className="border-b border-border/60 last:border-b-0">
                    <td className="py-0.5">{tNutrient(key)}</td>
                    <td className="py-0.5 text-right tabular-nums">
                      {Math.round((preview.nutrients[key] as number) * 100) / 100}{' '}
                      {NUTRIENT_UNIT[key]}
                    </td>
                  </tr>
                ) : null,
              )}
            </tbody>
          </table>

          {missing.length > 0 ? (
            <p className="text-[11px] text-muted-foreground">
              {t('preview.missing')}:{' '}
              {missing.map((k) => tNutrient(k)).join(', ')}
            </p>
          ) : null}

          {preview.qualityWarnings.length > 0 ? (
            <ul className="list-disc pl-4 text-[11px] text-amber-700 dark:text-amber-300">
              {preview.qualityWarnings.map((code) => (
                <li key={code}>{t(`warning.${code}`)}</li>
              ))}
            </ul>
          ) : null}

          {preview.sourceUpdatedAt ? (
            <p className="text-[11px] text-muted-foreground">
              {t('preview.updated', {
                date: new Date(preview.sourceUpdatedAt).toLocaleDateString(),
              })}
            </p>
          ) : null}

          {/* Save gate: equivalency required (100 ml) → block; partial → confirm. */}
          {preview.requiresEquivalency ? (
            <p className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] dark:border-amber-800 dark:bg-amber-950/40">
              {t('preview.equivalencyRequired')}
            </p>
          ) : (
            <div className="flex justify-end">
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() => onSave(preview.qualityStatus === 'partial')}
              >
                {preview.qualityStatus === 'partial'
                  ? t('preview.confirmPartial')
                  : t('preview.confirm')}
              </Button>
            </div>
          )}

          {/* Required Open Food Facts attribution (§16). */}
          <p className="text-[11px] text-muted-foreground">
            {t('attributionOff')} ·{' '}
            <a
              href={offProductUrl(preview.barcode)}
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              {t('viewOnOff')}
            </a>{' '}
            ·{' '}
            <a
              href={OFF_LICENSE_URL}
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              {t('attributionOffLicense')}
            </a>
          </p>
        </div>
      ) : null}
    </div>
  );
}
