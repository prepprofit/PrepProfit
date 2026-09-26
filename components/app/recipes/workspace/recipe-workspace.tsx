'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Pencil, Presentation } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatMoney } from '@/lib/format/money';
import { useActionError } from '@/lib/i18n/use-action-error';
import type { MeasurementSystem } from '@/lib/units';
import { impliedYieldPercentage, recipeInputWeightGrams } from '@/lib/calculations/recipeCost';
import { formatWeightForUnit, parseWeightInput, type WeightDisplayUnit } from '@/lib/format/weight';
import type { FolderTreeNode } from '@/lib/folders/tree';
import {
  clearLegacyRecipeCostsAction,
  saveWorkspaceAction,
  updateDisplayUnitAction,
} from '@/app/(app)/recipes/[id]/workspace-actions';
import { RecipePresets, type EditorPreset } from '@/components/app/recipes/recipe-presets';
import { BackToRecipesLink } from '@/components/app/recipes/back-to-recipes-link';
import { RecipeFolderPicker } from '@/components/app/recipes/workspace/recipe-folder-picker';
import { InfoPopover } from '@/components/app/recipes/workspace/info-popover';
import { cn } from '@/lib/utils';
import { BatchScaleControl } from './batch-scale-control';
import {
  RecipeInputListEdit,
  RecipeInputListView,
  type DraftLine,
  type DraftSection,
  type LineUom,
  type PickerOption,
} from './recipe-input-list';
import { RecipeMediaUpload } from './recipe-media-upload';
import { RecipeMethodEdit, type DraftMethodSection, type DraftStep } from './recipe-method-edit';
import { MethodPanel, type MethodSectionView, type UomTabItem, type WorkspaceCostView } from './recipe-workspace-tabs';
import { RecipeNutritionTab, type NutritionTabData } from './recipe-nutrition-tab';

/**
 * Serializable payload the Server Component ships to this client root. For kitchen
 * the money is ABSENT server-side (`cost: null`); this component never decides
 * visibility itself (Sprint F4).
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
    /** Recipe-wide display/input unit for weight quantities and the finished-weight summary. */
    displayUnit: WeightDisplayUnit;
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
  /** Unit-conversion anchors per ingredient — for the line editor, not rendered. */
  uom: UomTabItem[];
  nutrition: NutritionTabData;
  /** Full org folder list, for the compact folder picker beneath the name. */
  folders: FolderTreeNode[];
};

type Draft = {
  name: string;
  yieldQuantity: string;
  yieldUnit: string;
  yieldMode: 'percent' | 'measured';
  yieldPercentText: string;
  measuredText: string;
  lines: DraftLine[];
  methodSections: DraftMethodSection[];
  steps: DraftStep[];
  coverMediaId: string | null;
  coverUrl: string | null;
};

function parseDecimal(text: string): number | null {
  const trimmed = text.trim().replace(',', '.');
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/**
 * Recipe page. The RECIPE leads at full width: name, a compact folder control,
 * the ingredient list (g/kg selector beside its heading), a compact finished-weight
 * summary and the preparation method — all in one reading order. Kitchen presets,
 * cost and nutrition/allergens follow below as expandable sections. Editing is a
 * local draft — name, yield, cover, ingredient order/quantities and method — saved
 * atomically through `saveWorkspaceAction` (optimistic concurrency) or cancelled.
 * Subtitles, line notes, sections and portion options already stored are preserved
 * untouched. Scaling (view mode) is a temporary kitchen calculation, never saved.
 */
export function RecipeWorkspace({
  data,
  allergenPanel,
  taskMenu,
}: {
  data: WorkspaceClientData;
  allergenPanel?: React.ReactNode;
  taskMenu?: React.ReactNode;
}) {
  const t = useTranslations('recipes.workspace');
  const tYield = useTranslations('recipes.workspace.yieldCalc');
  const tCost = useTranslations('recipes.workspace.costSummary');
  const tNutrition = useTranslations('recipes.workspace.nutrition');
  const tPresets = useTranslations('recipes.presets');
  const actionError = useActionError();
  const router = useRouter();

  const [factor, setFactor] = React.useState(1);
  const [presets, setPresets] = React.useState<EditorPreset[]>(data.presets);
  React.useEffect(() => setPresets(data.presets), [data.presets]);

  // Display-only g/kg preference — a per-recipe presentation setting, saved
  // immediately (not part of the versioned edit draft) so it "remembers" across
  // visits whether the recipe is being viewed or edited.
  const [displayUnit, setDisplayUnit] = React.useState<WeightDisplayUnit>(data.recipe.displayUnit);
  React.useEffect(() => setDisplayUnit(data.recipe.displayUnit), [data.recipe.displayUnit]);
  const changeDisplayUnit = (unit: WeightDisplayUnit) => {
    if (unit === displayUnit) return;
    setDisplayUnit(unit);
    void updateDisplayUnitAction(data.recipe.id, unit).then((result) => {
      if (!result.ok) router.refresh();
    });
  };

  const lineUom = React.useMemo(() => {
    const map: Record<string, LineUom> = {};
    for (const item of data.uom) {
      map[item.ingredientId] = {
        anchors: item.equivalency,
        prepActions: item.prepActions.map((p) => ({
          id: p.id,
          name: p.name,
          anchors: { weightGrams: p.weightGrams, volumeMl: p.volumeMl, eachCount: p.eachCount },
        })),
      };
    }
    return map;
  }, [data.uom]);

  // ── Edit draft ────────────────────────────────────────────────────────────
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [conflict, setConflict] = React.useState(false);
  const [confirmLeave, setConfirmLeave] = React.useState<{ href: string | null } | null>(null);
  const [savedNotice, setSavedNotice] = React.useState(false);
  const [yieldExpanded, setYieldExpanded] = React.useState(false);
  const initialKey = React.useRef<string | null>(null);
  const editing = draft !== null;
  const dirty = draft !== null && JSON.stringify(draft) !== initialKey.current;

  React.useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  React.useEffect(() => {
    if (!savedNotice) return;
    const timer = window.setTimeout(() => setSavedNotice(false), 3000);
    return () => window.clearTimeout(timer);
  }, [savedNotice]);

  const startEdit = () => {
    const next: Draft = {
      name: data.recipe.name,
      yieldQuantity: data.recipe.yieldQuantity === null ? '' : String(data.recipe.yieldQuantity),
      yieldUnit: data.recipe.yieldUnit ?? '',
      yieldMode: data.recipe.yieldWeightSource === 'measured' ? 'measured' : 'percent',
      yieldPercentText: String(data.recipe.yieldPercentage),
      measuredText:
        data.recipe.yieldWeightSource === 'measured' && data.recipe.yieldWeightGrams != null
          ? String(data.recipe.yieldWeightGrams)
          : '',
      lines: data.lines,
      methodSections: data.methodDraftSections,
      steps: data.methodDraftSteps,
      coverMediaId: data.recipe.coverMediaId,
      coverUrl: data.recipe.coverUrl,
    };
    initialKey.current = JSON.stringify(next);
    setDraft(next);
    setError(null);
    setConflict(false);
  };

  const closeEditor = () => {
    setDraft(null);
    setError(null);
    setConfirmLeave(null);
    setYieldExpanded(false);
  };

  const adjustFinishedWeight = () => {
    if (!editing) startEdit();
    setYieldExpanded(true);
  };

  // Live yield calculation from the draft (loss applied once, to the output).
  const draftInputGrams = draft
    ? recipeInputWeightGrams(
        draft.lines.map((l) =>
          l.kind === 'ingredient' ? { dimension: l.dimension, quantity: l.quantity } : { dimension: 'weight' as const, quantity: l.quantityGrams },
        ),
        [],
      )
    : null;
  const draftPercent = draft ? parseDecimal(draft.yieldPercentText) : null;
  const percentValid = draftPercent !== null && Number.isInteger(draftPercent) && draftPercent >= 1 && draftPercent <= 100;
  const draftMeasured = draft ? parseDecimal(draft.measuredText) : null;
  const measuredValid = draftMeasured !== null && draftMeasured > 0;
  const draftFinished =
    draft?.yieldMode === 'measured'
      ? measuredValid
        ? draftMeasured
        : null
      : percentValid && draftInputGrams !== null
        ? Math.round(((draftInputGrams * (draftPercent as number)) / 100) * 100) / 100
        : null;
  const impliedPercent = draft?.yieldMode === 'measured' ? impliedYieldPercentage(draftInputGrams, draftMeasured) : null;
  const nameMissing = draft !== null && draft.name.trim() === '';
  const yieldProblem =
    draft === null
      ? null
      : draft.yieldMode === 'percent'
        ? !percentValid
          ? tYield('percentInvalid')
          : null
        : !measuredValid
          ? tYield('measuredInvalid')
          : null;

  const save = async () => {
    if (!draft || nameMissing || yieldProblem) return;
    setSaving(true);
    setError(null);
    const yieldQuantity = draft.yieldQuantity.trim() === '' ? null : parseDecimal(draft.yieldQuantity);
    try {
      const result = await saveWorkspaceAction({
        recipeId: data.recipe.id,
        expectedVersion: data.recipe.version,
        header: {
          name: draft.name.trim(),
          yieldQuantity: yieldQuantity !== null && yieldQuantity > 0 ? yieldQuantity : null,
          yieldUnit: draft.yieldUnit.trim() === '' ? null : draft.yieldUnit.trim(),
          coverMediaId: draft.coverMediaId,
          yield: {
            percentage:
              draft.yieldMode === 'percent'
                ? (draftPercent as number)
                : impliedPercent !== null
                  ? Math.min(100, Math.max(1, Math.round(impliedPercent)))
                  : data.recipe.yieldPercentage,
            measuredGrams: draft.yieldMode === 'measured' ? draftMeasured : null,
          },
        },
        // Sections stay exactly as stored (they are not edited on this screen).
        sections: data.sections.map((s) => ({ id: s.id, tempId: s.id ? undefined : s.ref, title: s.title.trim() || '…' })),
        lines: draft.lines.map((l) =>
          l.kind === 'ingredient'
            ? {
                kind: 'ingredient' as const,
                id: l.id,
                ingredientId: l.ingredientId,
                quantity: l.quantity,
                prepActionId: l.prepActionId,
                enteredQuantity: l.enteredQuantity,
                enteredUnit: l.enteredUnit,
                note: l.note.trim() === '' ? null : l.note.trim(),
                sectionRef: l.sectionRef,
              }
            : {
                kind: 'component' as const,
                id: l.id,
                componentRecipeId: l.componentRecipeId,
                quantityGrams: l.quantityGrams,
                note: l.note.trim() === '' ? null : l.note.trim(),
                sectionRef: l.sectionRef,
              },
        ),
        methodSections: draft.methodSections.map((s) => ({ id: s.id, tempId: s.id ? undefined : s.ref, title: s.title.trim() || '…' })),
        steps: draft.steps
          .filter((s) => s.instruction.trim() !== '')
          .map((s) => ({ id: s.id, instruction: s.instruction.trim(), sectionRef: s.sectionRef, mediaIds: s.media.map((m) => m.mediaId) })),
      });
      if (result.ok) {
        closeEditor();
        setSavedNotice(true);
        router.refresh();
      } else if (result.code === 'WORKSPACE_VERSION_CONFLICT') {
        setConflict(true);
      } else {
        setError(actionError(result.code));
      }
    } finally {
      setSaving(false);
    }
  };

  const [legacyPending, startLegacy] = React.useTransition();
  const clearLegacy = () => {
    if (!data.cost) return;
    const { labourCents, energyCents } = data.cost.legacy;
    startLegacy(async () => {
      const result = await clearLegacyRecipeCostsAction(data.recipe.id, { labour: labourCents > 0, energy: energyCents > 0 });
      if (!result.ok) setError(actionError(result.code));
      else router.refresh();
    });
  };

  const editActions = (
    <div className="flex items-center gap-2">
      <Button type="button" variant="outline" onClick={() => (dirty ? setConfirmLeave({ href: null }) : closeEditor())} disabled={saving}>
        {t('cancel')}
      </Button>
      <Button type="button" onClick={save} disabled={saving || nameMissing || yieldProblem !== null}>
        {saving ? t('saving') : t('saveRecipe')}
      </Button>
    </div>
  );

  const view = data.recipe;
  const cost = data.cost;
  const lineCosts = cost?.lineCosts;

  // The finished-weight summary strip's numbers — draft-derived while editing,
  // the persisted values otherwise (scaled by the view-only batch factor).
  const finishedGrams = editing ? draftFinished : view.finishedWeightGrams !== null ? view.finishedWeightGrams * factor : null;
  const finishedSource: 'measured' | 'calculated' | null = editing
    ? draft.yieldMode === 'measured'
      ? 'measured'
      : 'calculated'
    : view.yieldWeightSource;

  const nutritionIncomplete = data.nutrition.status !== 'complete';
  const allergenCount = data.nutrition.allergens.contains.length + data.nutrition.allergens.mayContain.length;

  return (
    <div className="flex w-full flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <BackToRecipesLink
          folderId={view.folderId}
          onNavigate={(href, e) => {
            if (!dirty) return;
            e.preventDefault();
            setConfirmLeave({ href });
          }}
        />
        {savedNotice && (
          <span role="status" className="text-sm font-medium text-brand-700 dark:text-brand-300">
            {t('savedNotice')}
          </span>
        )}
      </div>

      {conflict ? (
        <div role="alert" className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm dark:border-red-800 dark:bg-red-950/40">
          <p className="font-medium">{t('conflictTitle')}</p>
          <p className="text-muted-foreground">{t('conflictBody')}</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-2"
            onClick={() => {
              setConflict(false);
              closeEditor();
              router.refresh();
            }}
          >
            {t('reload')}
          </Button>
        </div>
      ) : null}

      {/* ── The recipe ───────────────────────────────────────────────────── */}
      <Card>
        <CardContent className="flex flex-col gap-5 pt-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              {editing ? (
                <>
                  <Label htmlFor="recipe-name" className="sr-only">
                    {t('namePlaceholder')}
                  </Label>
                  <Input
                    id="recipe-name"
                    value={draft.name}
                    aria-invalid={nameMissing}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    className="h-auto max-w-3xl border-none bg-transparent px-0 text-[28px] font-semibold tracking-tight shadow-none focus-visible:ring-0 sm:text-[30px]"
                  />
                  {nameMissing && <p className="text-xs text-red-700 dark:text-red-300">{t('nameRequired')}</p>}
                </>
              ) : (
                <h1 className="font-display text-[28px] font-semibold tracking-tight text-foreground sm:text-[30px]">{view.name}</h1>
              )}
              <RecipeFolderPicker recipeId={view.id} recipeName={view.name} folderId={view.folderId} folders={data.folders} />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {editing ? (
                editActions
              ) : (
                <>
                  {taskMenu}
                  <Button asChild variant="ghost" size="sm">
                    <Link href={`/recipes/${view.id}/slideshow`}>
                      <Presentation className="size-4" aria-hidden />
                      {t('slideshow.open')}
                    </Link>
                  </Button>
                  <Button type="button" onClick={startEdit} aria-label={t('editRecipe', { name: view.name })}>
                    <Pencil className="size-4" aria-hidden />
                    {t('edit')}
                  </Button>
                </>
              )}
            </div>
          </div>

          {error ? (
            <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/15 dark:text-red-300">
              {error}
            </p>
          ) : null}

          {!editing ? (
            <div className="rounded-xl bg-surface-2 p-3">
              <BatchScaleControl factor={factor} onFactorChange={setFactor} />
            </div>
          ) : null}

          {/* ── Ingredients ─────────────────────────────────────────────── */}
          <section aria-labelledby="recipe-ingredients" className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="recipe-ingredients" className="text-base font-semibold text-foreground">
                {t('ingredients')}
              </h2>
              <UnitToggle value={displayUnit} onChange={changeDisplayUnit} label={t('unitToggleLabel')} />
            </div>
            {editing ? (
              <RecipeInputListEdit
                lines={draft.lines}
                ingredientOptions={data.ingredientOptions}
                componentOptions={data.componentOptions}
                lineUom={lineUom}
                displayUnit={displayUnit}
                onLinesChange={(lines) => setDraft({ ...draft, lines })}
              />
            ) : (
              <RecipeInputListView
                sections={data.sections}
                lines={data.lines}
                factor={factor}
                displayUnit={displayUnit}
                onAnchorScale={(base, target) => setFactor(target / base)}
                lineCosts={lineCosts}
                currency={data.currency}
                noPriceLabel={tCost('noPrice')}
              />
            )}
          </section>

          {/* ── Finished-weight summary ─────────────────────────────────── */}
          <FinishedWeightSummary
            editing={editing}
            expanded={yieldExpanded}
            onToggleExpand={() => (editing ? setYieldExpanded((v) => !v) : adjustFinishedWeight())}
            displayUnit={displayUnit}
            finishedGrams={finishedGrams}
            source={finishedSource}
            reviewNeeded={view.yieldReviewNeeded}
            inputGrams={draftInputGrams}
            mode={draft?.yieldMode ?? 'percent'}
            percentText={draft?.yieldPercentText ?? ''}
            measuredText={draft?.measuredText ?? ''}
            problem={yieldProblem}
            onModeChange={(patch) => draft && setDraft({ ...draft, ...patch })}
          />

          {editing ? (
            <div className="flex flex-col gap-3 border-t border-border pt-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-foreground">{t('media.cover')}</span>
                {draft.coverMediaId ? (
                  <>
                    {draft.coverUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- short signed URL from the private store; next/image cannot optimize it
                      <img src={draft.coverUrl} alt="" className="h-10 w-16 rounded-md border border-border object-cover" />
                    ) : null}
                    <Button type="button" size="sm" variant="ghost" onClick={() => setDraft({ ...draft, coverMediaId: null, coverUrl: null })}>
                      {t('media.removeCover')}
                    </Button>
                  </>
                ) : (
                  <RecipeMediaUpload
                    recipeId={view.id}
                    label={t('media.setCover')}
                    onUploaded={(m) => setDraft({ ...draft, coverMediaId: m.mediaId, coverUrl: m.url })}
                  />
                )}
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* ── Preparation method ───────────────────────────────────────────── */}
      <Card>
        <CardContent className="flex flex-col gap-3 pt-6">
          <h2 className="text-base font-semibold text-foreground">{t('tabs.method')}</h2>
          {editing ? (
            <RecipeMethodEdit
              recipeId={view.id}
              sections={draft.methodSections}
              steps={draft.steps}
              onSectionsChange={(methodSections) => setDraft({ ...draft, methodSections })}
              onStepsChange={(steps) => setDraft({ ...draft, steps })}
            />
          ) : (
            <MethodPanel sections={data.methodSections} legacyNotes={view.notes} />
          )}
        </CardContent>
      </Card>

      {editing ? <div className="flex justify-end">{editActions}</div> : null}

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
                  <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div className="rounded-xl border border-border px-4 py-3">
                      <dt className="text-xs text-muted-foreground">
                        {factor === 1 ? tCost('batch') : tCost('batchScaled', { factor: Math.round(factor * 100) / 100 })}
                      </dt>
                      <dd className="font-display text-2xl font-semibold tabular-nums">
                        {cost.complete ? formatMoney(Math.round(cost.batchCostCents * factor), data.currency) : '—'}
                      </dd>
                    </div>
                    <div className="rounded-xl border border-border px-4 py-3">
                      <dt className="text-xs text-muted-foreground">{tCost('perKg')}</dt>
                      <dd className="font-display text-2xl font-semibold tabular-nums">
                        {cost.complete && cost.costPerKgCents !== null ? formatMoney(cost.costPerKgCents, data.currency) : '—'}
                      </dd>
                    </div>
                  </dl>
                  {!cost.complete ? (
                    <p className="mt-3 text-sm text-amber-700 dark:text-amber-300">{tCost('incomplete')}</p>
                  ) : cost.costPerKgCents === null ? (
                    <p className="mt-3 text-sm text-muted-foreground">{tCost('needsWeight')}</p>
                  ) : null}
                  {(cost.legacy.labourCents > 0 || cost.legacy.energyCents > 0) && (
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-500/15 dark:text-amber-200">
                      <span>
                        {tCost('legacy', {
                          labour: formatMoney(cost.legacy.labourCents, data.currency),
                          energy: formatMoney(cost.legacy.energyCents, data.currency),
                        })}
                      </span>
                      <Button type="button" size="sm" variant="outline" disabled={legacyPending} onClick={clearLegacy}>
                        {tCost('legacyRemove')}
                      </Button>
                    </div>
                  )}
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

      <ConfirmDialog
        open={confirmLeave !== null}
        title={t('discard.title')}
        description={t('discard.body')}
        confirmLabel={t('discard.confirm')}
        cancelLabel={t('discard.keep')}
        destructive
        onConfirm={() => {
          const href = confirmLeave?.href ?? null;
          initialKey.current = null;
          closeEditor();
          if (href) router.push(href);
        }}
        onCancel={() => setConfirmLeave(null)}
      />
    </div>
  );
}

/** The compact g/kg toggle beside the "Ingredients" heading. */
function UnitToggle({
  value,
  onChange,
  label,
}: {
  value: WeightDisplayUnit;
  onChange: (unit: WeightDisplayUnit) => void;
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-lg border border-border p-0.5 text-xs font-medium">
      {(['g', 'kg'] as const).map((unit) => (
        <button
          key={unit}
          type="button"
          aria-pressed={value === unit}
          onClick={() => onChange(unit)}
          className={cn(
            'rounded-md px-2.5 py-1 transition-colors',
            value === unit ? 'bg-accent-600 text-white' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {unit}
        </button>
      ))}
    </div>
  );
}

/**
 * "This recipe makes X g/kg" — the compact strip that replaces the old
 * always-visible yield form. Collapsed, it's a single line plus an "Adjust
 * finished weight" action; expanded (edit mode only), both the finished weight
 * and the yield % are plain editable fields — editing either recalculates the
 * other, so there's no separate mode switch to pick first.
 */
function FinishedWeightSummary({
  editing,
  expanded,
  onToggleExpand,
  displayUnit,
  finishedGrams,
  source,
  reviewNeeded,
  inputGrams,
  mode,
  percentText,
  measuredText,
  problem,
  onModeChange,
}: {
  editing: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  displayUnit: WeightDisplayUnit;
  finishedGrams: number | null;
  source: 'measured' | 'calculated' | null;
  reviewNeeded: boolean;
  inputGrams: number | null;
  mode: 'percent' | 'measured';
  percentText: string;
  measuredText: string;
  problem: string | null;
  onModeChange: (patch: Partial<Pick<Draft, 'yieldMode' | 'yieldPercentText' | 'measuredText'>>) => void;
}) {
  const t = useTranslations('recipes.workspace.yieldCalc');
  const tw = useTranslations('recipes.workspace');

  // What the finished-weight field DISPLAYS: the measured grams (converted to the
  // selected unit) in measured mode, the computed finished weight in percent mode.
  // Tracked as raw typed text while focused so a partial decimal ("0,") isn't
  // reformatted mid-keystroke — same pattern as the ingredient row's DecimalInput.
  const computedFinishedText =
    mode === 'measured'
      ? (() => {
          const grams = parseDecimal(measuredText);
          return grams !== null ? formatWeightForUnit(grams, displayUnit) : measuredText;
        })()
      : finishedGrams !== null
        ? formatWeightForUnit(finishedGrams, displayUnit)
        : '';
  const [finishedText, setFinishedText] = React.useState(computedFinishedText);
  const [finishedFocused, setFinishedFocused] = React.useState(false);
  React.useEffect(() => {
    if (!finishedFocused) setFinishedText(computedFinishedText);
  }, [computedFinishedText, finishedFocused]);

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-sm">
          <span className="font-medium text-foreground">
            {finishedGrams !== null
              ? tw('makesLine', { weight: formatWeightForUnit(finishedGrams, displayUnit) + ` ${displayUnit}` })
              : t('needsMeasured')}
          </span>
          {finishedGrams !== null && source ? (
            <span className="text-xs text-muted-foreground">({t(`source.${source}`)})</span>
          ) : null}
          <InfoPopover label={t('infoLabel')}>{t('infoBody')}</InfoPopover>
        </div>
        <Button type="button" size="sm" variant="ghost" onClick={onToggleExpand} className="h-7 px-2 text-xs">
          {expanded && editing ? tw('doneAdjusting') : tw('adjustFinishedWeight')}
        </Button>
      </div>
      {reviewNeeded ? <p className="text-xs text-amber-700 dark:text-amber-300">{t('reviewNeeded')}</p> : null}

      {editing && expanded ? (
        <div className="mt-1 grid grid-cols-1 gap-3 border-t border-border pt-3 sm:grid-cols-3">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">{tw('ingredientTotal')}</span>
            <span className="flex h-10 items-center rounded-lg bg-surface-2 px-3 font-medium tabular-nums">
              {inputGrams !== null ? formatWeightForUnit(inputGrams, displayUnit) + ` ${displayUnit}` : '—'}
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="yield-percent">{t('percent')}</Label>
            <div className="relative">
              <Input
                id="yield-percent"
                inputMode="numeric"
                value={percentText}
                aria-invalid={mode === 'percent' && problem !== null}
                onChange={(e) => onModeChange({ yieldPercentText: e.target.value, yieldMode: 'percent' })}
                className="pr-8 text-right tabular-nums"
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">%</span>
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="yield-finished">{t('finished')}</Label>
            <div className="relative">
              <Input
                id="yield-finished"
                inputMode="decimal"
                value={finishedText}
                aria-invalid={mode === 'measured' && problem !== null}
                onFocus={() => setFinishedFocused(true)}
                onBlur={() => {
                  setFinishedFocused(false);
                  setFinishedText(computedFinishedText);
                }}
                onChange={(e) => {
                  setFinishedText(e.target.value);
                  const grams = e.target.value.trim() === '' ? null : parseWeightInput(e.target.value, displayUnit);
                  if (e.target.value.trim() === '') {
                    onModeChange({ measuredText: '', yieldMode: 'measured' });
                  } else if (grams !== null) {
                    onModeChange({ measuredText: String(grams), yieldMode: 'measured' });
                  }
                }}
                className="pr-8 text-right tabular-nums"
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                {displayUnit}
              </span>
            </div>
          </div>
          {problem ? <p className="text-xs text-red-700 dark:text-red-300 sm:col-span-3">{problem}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
