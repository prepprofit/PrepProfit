'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Pencil, Presentation } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { formatMoney } from '@/lib/format/money';
import type { MeasurementSystem } from '@/lib/units';
import type { WeightDisplayUnit } from '@/lib/format/weight';
import type { FolderTreeNode } from '@/lib/folders/tree';
import { weightSummary } from '@/lib/recipes/editor-model';
import { updateDisplayUnitAction } from '@/app/(app)/recipes/[id]/workspace-actions';
import { RecipePresets, type EditorPreset } from '@/components/app/recipes/recipe-presets';
import { BackToRecipesLink } from '@/components/app/recipes/back-to-recipes-link';
import { RecipeFolderPicker } from '@/components/app/recipes/workspace/recipe-folder-picker';
import { UnitSwitch } from '@/components/app/recipes/editor/unit-switch';
import { WeightSummaryLine, useWeightLabel } from '@/components/app/recipes/editor/weight-summary';
import { cn } from '@/lib/utils';
import { BatchScaleControl } from './batch-scale-control';
import { RecipeInputListView, type DraftLine, type DraftSection, type PickerOption } from './recipe-input-list';
import { MethodPanel, type MethodSectionView, type UomTabItem, type WorkspaceCostView } from './recipe-workspace-tabs';
import { RecipeNutritionTab, type NutritionTabData } from './recipe-nutrition-tab';
import { RecipeCostSummary } from './recipe-cost-summary';
import type { DraftMethodSection, DraftStep } from '@/lib/recipes/editor-model';

/**
 * Serializable payload the Server Component ships to the recipe page AND the recipe
 * editor. For kitchen the money is ABSENT server-side (`cost: null`); this component
 * never decides visibility itself (Sprint F4).
 */
export type WorkspaceClientData = {
  recipe: {
    id: string;
    name: string;
    subtitle: string | null;
    version: number;
    yieldQuantity: number | null;
    yieldUnit: string | null;
    yieldPortions: number;
    yieldWeightGrams: number | null;
    /** Output yield after production loss (whole %). */
    yieldPercentage: number;
    yieldWeightSource: 'measured' | 'calculated' | null;
    yieldReviewNeeded: boolean;
    /** Ingredient input weight in grams (null when ml / piece lines are present). */
    inputWeightGrams: number | null;
    /** The shared finished weight used for cost per kg (measured or calculated). */
    finishedWeightGrams: number | null;
    folderId: string | null;
    /** Recipe-wide display unit for weight quantities and the weight summary. */
    displayUnit: WeightDisplayUnit;
    /** "Preparation method / notes" free text. */
    notes: string | null;
    coverMediaId: string | null;
    coverUrl: string | null;
  };
  sections: DraftSection[];
  lines: DraftLine[];
  methodSections: MethodSectionView[];
  methodDraftSections: DraftMethodSection[];
  methodDraftSteps: DraftStep[];
  books: { bookId: string; bookName: string }[];
  ingredientOptions: PickerOption[];
  componentOptions: PickerOption[];
  cost: WorkspaceCostView;
  currency: string;
  measurementSystem: MeasurementSystem;
  presets: EditorPreset[];
  /** Unit-conversion anchors per ingredient — for the editor's line rows, not rendered. */
  uom: UomTabItem[];
  nutrition: NutritionTabData;
  /** Full org folder list, for the compact folder picker beneath the name. */
  folders: FolderTreeNode[];
};

/**
 * The saved recipe. The RECIPE leads at full width: name, folder, the ingredient list
 * (g/kg switch beside its heading, scalable for the kitchen), the weight summary and
 * the preparation method / notes; kitchen presets, cost and nutrition/allergens follow
 * as expandable sections. Edit opens the recipe editor — the same form used to create
 * a recipe. Scaling is a temporary kitchen calculation, never saved.
 */
export function RecipeWorkspace({
  data,
  allergenPanel,
  taskMenu,
  savedNotice = false,
}: {
  data: WorkspaceClientData;
  allergenPanel?: React.ReactNode;
  taskMenu?: React.ReactNode;
  /** Just saved in the editor: confirm it briefly. */
  savedNotice?: boolean;
}) {
  const t = useTranslations('recipes.workspace');
  const tEditor = useTranslations('recipes.editor');
  const tCost = useTranslations('recipes.workspace.costSummary');
  const tNutrition = useTranslations('recipes.workspace.nutrition');
  const tPresets = useTranslations('recipes.presets');
  const router = useRouter();
  const weightLabel = useWeightLabel();

  const [factor, setFactor] = React.useState(1);
  const [presets, setPresets] = React.useState<EditorPreset[]>(data.presets);
  React.useEffect(() => setPresets(data.presets), [data.presets]);

  // Display-only g/kg preference — saved immediately, never changes a quantity.
  const [displayUnit, setDisplayUnit] = React.useState<WeightDisplayUnit>(data.recipe.displayUnit);
  React.useEffect(() => setDisplayUnit(data.recipe.displayUnit), [data.recipe.displayUnit]);
  const changeDisplayUnit = (unit: WeightDisplayUnit) => {
    if (unit === displayUnit) return;
    setDisplayUnit(unit);
    void updateDisplayUnitAction(data.recipe.id, unit).then((result) => {
      if (!result.ok) router.refresh();
    });
  };

  // "Recipe saved." after the editor redirects here; drop `?saved=1` from the URL so
  // a reload doesn't repeat it.
  const [showSaved, setShowSaved] = React.useState(savedNotice);
  React.useEffect(() => {
    if (!savedNotice) return;
    setShowSaved(true);
    window.history.replaceState(window.history.state, '', window.location.pathname);
    const timer = window.setTimeout(() => setShowSaved(false), 4000);
    return () => window.clearTimeout(timer);
  }, [savedNotice]);

  const view = data.recipe;
  const cost = data.cost;
  const summary = weightSummary(data.lines);
  const finishedGrams = view.finishedWeightGrams !== null ? view.finishedWeightGrams * factor : null;
  const scaledSummary =
    factor === 1 || summary.state === 'empty'
      ? summary
      : summary.state === 'complete'
        ? { ...summary, totalGrams: summary.totalGrams * factor }
        : { ...summary, weighedGrams: summary.weighedGrams * factor };
  const editHref = `/recipes/${view.id}/edit`;

  const nutritionIncomplete = data.nutrition.status !== 'complete';
  const allergenCount = data.nutrition.allergens.contains.length + data.nutrition.allergens.mayContain.length;

  return (
    <div className="flex w-full flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <BackToRecipesLink folderId={view.folderId} />
        {showSaved ? (
          <span role="status" className="text-sm font-medium text-brand-700 dark:text-brand-300">
            {t('savedNotice')}
          </span>
        ) : null}
      </div>

      {/* ── The recipe ───────────────────────────────────────────────────── */}
      <Card>
        <CardContent className="flex flex-col gap-5 pt-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <h1 className="font-display text-[28px] font-semibold tracking-tight text-foreground sm:text-[30px]">{view.name}</h1>
              <RecipeFolderPicker recipeId={view.id} recipeName={view.name} folderId={view.folderId} folders={data.folders} />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {taskMenu}
              <Button asChild variant="ghost" size="sm">
                <Link href={`/recipes/${view.id}/slideshow`}>
                  <Presentation className="size-4" aria-hidden />
                  {t('slideshow.open')}
                </Link>
              </Button>
              <Button asChild>
                <Link href={editHref} aria-label={t('editRecipe', { name: view.name })}>
                  <Pencil className="size-4" aria-hidden />
                  {t('edit')}
                </Link>
              </Button>
            </div>
          </div>

          <div className="rounded-xl bg-surface-2 p-3">
            <BatchScaleControl factor={factor} onFactorChange={setFactor} />
          </div>

          {/* ── Ingredients ─────────────────────────────────────────────── */}
          <section aria-labelledby="recipe-ingredients" className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="recipe-ingredients" className="text-base font-semibold text-foreground">
                {t('ingredients')}
              </h2>
              <UnitSwitch value={displayUnit} onChange={changeDisplayUnit} label={t('unitToggleLabel')} />
            </div>
            <RecipeInputListView
              sections={data.sections}
              lines={data.lines}
              factor={factor}
              displayUnit={displayUnit}
              onAnchorScale={(base, target) => setFactor(target / base)}
              lineCosts={cost?.lineCosts}
              currency={data.currency}
              noPriceLabel={tCost('noPrice')}
            />
          </section>

          {/* ── Weight summary ──────────────────────────────────────────── */}
          <div className="flex flex-col gap-1 rounded-xl bg-surface-2/70 px-4 py-3">
            <WeightSummaryLine summary={scaledSummary} displayUnit={displayUnit}>
              {summary.state !== 'empty' ? (
                <Link
                  href={`${editHref}?adjust=finished-weight`}
                  className="-my-1 inline-flex min-h-9 items-center rounded-full px-2 text-sm font-medium text-accent-700 hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-accent-300"
                >
                  {tEditor('weight.adjust')}
                </Link>
              ) : null}
            </WeightSummaryLine>
            {finishedGrams !== null ? (
              <p className="text-xs text-muted-foreground">
                {tEditor('weight.finishedLine', { weight: weightLabel(finishedGrams, displayUnit) })}
                {view.yieldWeightSource ? ` · ${tEditor(`weight.${view.yieldWeightSource}`)}` : ''}
              </p>
            ) : summary.state === 'partial' ? (
              <p className="text-xs text-muted-foreground">{tEditor('weight.weighBatch')}</p>
            ) : null}
            {view.yieldReviewNeeded ? (
              <p className="text-xs text-amber-800 dark:text-amber-300">{tEditor('weight.reviewNeeded')}</p>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {/* ── Preparation method / notes ───────────────────────────────────── */}
      <Card>
        <CardContent className="flex flex-col gap-3 pt-6">
          <h2 className="text-base font-semibold text-foreground">{tEditor('method.label')}</h2>
          <MethodPanel sections={data.methodSections} notes={view.notes} />
        </CardContent>
      </Card>

      {/* ── Supporting information ───────────────────────────────────────── */}
      <Card>
        <CardContent className="pt-2">
          <h2 className="sr-only">{t('supporting')}</h2>
          <Accordion type="multiple" defaultValue={[]}>
            <AccordionItem value="presets">
              <AccordionTrigger>
                <span className="flex flex-1 flex-wrap items-center justify-between gap-2 pr-2">
                  <span>{tPresets('title')}</span>
                  <span className="text-xs font-normal text-muted-foreground">
                    {tPresets('countLabel', { count: presets.length })}
                  </span>
                </span>
              </AccordionTrigger>
              <AccordionContent>
                <RecipePresets
                  recipeId={view.id}
                  presets={presets}
                  onPresetsChange={setPresets}
                  measurementSystem={data.measurementSystem}
                  canSeeCosts={false}
                  currency={data.currency}
                  batchTotalCents={null}
                  yieldWeightGrams={view.finishedWeightGrams}
                  hideHeader
                />
              </AccordionContent>
            </AccordionItem>

            {cost ? (
              <AccordionItem value="cost">
                <AccordionTrigger>
                  <span className="flex flex-1 flex-wrap items-center justify-between gap-2 pr-2">
                    <span>{tCost('title')}</span>
                    <span className="text-xs font-normal text-muted-foreground tabular-nums">
                      {cost.complete ? formatMoney(cost.batchCostCents, data.currency) : tCost('incomplete')}
                    </span>
                  </span>
                </AccordionTrigger>
                <AccordionContent>
                  <RecipeCostSummary recipeId={view.id} cost={cost} currency={data.currency} factor={factor} />
                </AccordionContent>
              </AccordionItem>
            ) : null}

            <AccordionItem value="nutrition">
              <AccordionTrigger>
                <span className="flex flex-1 flex-wrap items-center justify-between gap-2 pr-2">
                  <span>{t('tabs.nutrition')}</span>
                  <span
                    className={cn(
                      'text-xs font-normal',
                      nutritionIncomplete ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground',
                    )}
                  >
                    {nutritionIncomplete ? tNutrition('statusIncompleteShort') : tNutrition('statusCompleteShort')}
                    {allergenCount > 0 ? ` · ${allergenCount}` : ''}
                  </span>
                </span>
              </AccordionTrigger>
              <AccordionContent className="flex flex-col gap-4">
                <RecipeNutritionTab recipeId={view.id} data={data.nutrition} />
                {allergenPanel}
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </CardContent>
      </Card>
    </div>
  );
}
