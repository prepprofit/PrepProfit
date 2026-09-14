'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Pencil, Presentation } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatMoney } from '@/lib/format/money';
import { useActionError } from '@/lib/i18n/use-action-error';
import type { MeasurementSystem } from '@/lib/units';
import { impliedYieldPercentage, recipeInputWeightGrams } from '@/lib/calculations/recipeCost';
import { clearLegacyRecipeCostsAction, saveWorkspaceAction } from '@/app/(app)/recipes/[id]/workspace-actions';
import { RecipePresets, type EditorPreset } from '@/components/app/recipes/recipe-presets';
import { BackToRecipesLink } from '@/components/app/recipes/back-to-recipes-link';
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

function formatWeight(grams: number): string {
  return grams >= 1000 ? `${Math.round(grams / 10) / 100} kg` : `${Math.round(grams * 10) / 10} g`;
}

/**
 * Recipe page. The RECIPE leads at full width: name, "Scale recipe", the ingredient
 * and sub-recipe quantities (each with its line cost for managers) and a cost summary
 * — cost per batch and cost per kg only — with a pencil Edit button. Preparation
 * method, nutrition, allergens and kitchen presets follow below.
 *
 * Scaling is a temporary kitchen calculation (never saved). Editing is a separate
 * local draft — name, yield calculator, cover, ingredient order/quantities and method
 * — saved atomically through `saveWorkspaceAction` (optimistic concurrency) or
 * cancelled. Subtitles, line notes, sections and portion options already stored are
 * preserved untouched.
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
  const actionError = useActionError();
  const router = useRouter();

  const [factor, setFactor] = React.useState(1);
  const [presets, setPresets] = React.useState<EditorPreset[]>(data.presets);
  React.useEffect(() => setPresets(data.presets), [data.presets]);

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
            {editing ? (
              <div className="flex w-full max-w-3xl flex-col gap-1.5">
                <Label htmlFor="recipe-name">{t('namePlaceholder')}</Label>
                <Input
                  id="recipe-name"
                  value={draft.name}
                  aria-invalid={nameMissing}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  className="h-12 text-lg font-semibold"
                />
                {nameMissing && <p className="text-xs text-red-700 dark:text-red-300">{t('nameRequired')}</p>}
              </div>
            ) : (
              <div className="flex min-w-0 flex-1 items-start gap-4">
                {view.coverUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- short signed URL from the private store; next/image cannot optimize it
                  <img src={view.coverUrl} alt="" className="hidden h-20 w-28 shrink-0 rounded-xl border border-border object-cover sm:block" />
                ) : null}
                <div className="min-w-0">
                  <h1 className="font-display text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">{view.name}</h1>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {view.inputWeightGrams !== null && (
                      <span>
                        {tYield('inputShort', { weight: formatWeight(view.inputWeightGrams * factor) })} ·{' '}
                      </span>
                    )}
                    <span>{tYield('yieldShort', { percent: view.yieldPercentage })}</span>
                    {view.finishedWeightGrams !== null && (
                      <span>
                        {' '}
                        · {tYield('finishedShort', { weight: formatWeight(view.finishedWeightGrams * factor) })}{' '}
                        <span className="text-xs">({tYield(`source.${view.yieldWeightSource === 'measured' ? 'measured' : 'calculated'}`)})</span>
                      </span>
                    )}
                  </p>
                  {view.yieldReviewNeeded && (
                    <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">{tYield('reviewNeeded')}</p>
                  )}
                </div>
              </div>
            )}

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

          {editing ? (
            <YieldCalculator
              inputGrams={draftInputGrams}
              mode={draft.yieldMode}
              percentText={draft.yieldPercentText}
              measuredText={draft.measuredText}
              finishedGrams={draftFinished}
              impliedPercent={impliedPercent}
              problem={yieldProblem}
              yieldQuantity={draft.yieldQuantity}
              yieldUnit={draft.yieldUnit}
              onChange={(patch) => setDraft({ ...draft, ...patch })}
            />
          ) : (
            <div className="rounded-xl bg-surface-2 p-3">
              <BatchScaleControl factor={factor} onFactorChange={setFactor} />
            </div>
          )}

          <section aria-labelledby="recipe-ingredients" className="flex flex-col gap-2">
            <h2 id="recipe-ingredients" className="text-base font-semibold text-foreground">
              {t('ingredients')}
            </h2>
            {editing ? (
              <RecipeInputListEdit
                lines={draft.lines}
                ingredientOptions={data.ingredientOptions}
                componentOptions={data.componentOptions}
                lineUom={lineUom}
                onLinesChange={(lines) => setDraft({ ...draft, lines })}
              />
            ) : (
              <RecipeInputListView
                sections={data.sections}
                lines={data.lines}
                factor={factor}
                onAnchorScale={(base, target) => setFactor(target / base)}
                lineCosts={lineCosts}
                currency={data.currency}
                noPriceLabel={tCost('noPrice')}
              />
            )}
          </section>

          {/* Cost summary, below the ingredient list — managers only. */}
          {!editing && cost ? (
            <section aria-labelledby="recipe-cost" className="flex flex-col gap-3 border-t border-border pt-4">
              <h2 id="recipe-cost" className="sr-only">
                {tCost('title')}
              </h2>
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
                <p className="text-sm text-amber-700 dark:text-amber-300">{tCost('incomplete')}</p>
              ) : cost.costPerKgCents === null ? (
                <p className="text-sm text-muted-foreground">{tCost('needsWeight')}</p>
              ) : null}
              {(cost.legacy.labourCents > 0 || cost.legacy.energyCents > 0) && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-500/15 dark:text-amber-200">
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
            </section>
          ) : null}

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

      {/* ── Supporting sections, below the recipe ───────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>{t('tabs.method')}</CardTitle>
        </CardHeader>
        <CardContent>
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

      <RecipePresets
        recipeId={view.id}
        presets={presets}
        onPresetsChange={setPresets}
        measurementSystem={data.measurementSystem}
        canSeeCosts={false}
        currency={data.currency}
        batchTotalCents={null}
        yieldWeightGrams={view.finishedWeightGrams}
      />

      <Card>
        <CardHeader>
          <CardTitle>{t('tabs.nutrition')}</CardTitle>
        </CardHeader>
        <CardContent>
          <RecipeNutritionTab recipeId={view.id} data={data.nutrition} />
        </CardContent>
      </Card>

      {allergenPanel}

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

function YieldCalculator({
  inputGrams,
  mode,
  percentText,
  measuredText,
  finishedGrams,
  impliedPercent,
  problem,
  yieldQuantity,
  yieldUnit,
  onChange,
}: {
  inputGrams: number | null;
  mode: 'percent' | 'measured';
  percentText: string;
  measuredText: string;
  finishedGrams: number | null;
  impliedPercent: number | null;
  problem: string | null;
  yieldQuantity: string;
  yieldUnit: string;
  onChange: (patch: Partial<Pick<Draft, 'yieldMode' | 'yieldPercentText' | 'measuredText' | 'yieldQuantity' | 'yieldUnit'>>) => void;
}) {
  const t = useTranslations('recipes.workspace.yieldCalc');
  const tw = useTranslations('recipes.workspace');
  return (
    <fieldset className="flex flex-col gap-3 rounded-xl border border-border p-4">
      <legend className="px-1 text-sm font-semibold text-foreground">{t('title')}</legend>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">{t('input')}</span>
          <span className="flex h-10 items-center rounded-lg bg-surface-2 px-3 font-medium tabular-nums">
            {inputGrams !== null ? formatWeight(inputGrams) : '—'}
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="yield-percent" className={cn(mode !== 'percent' && 'text-muted-foreground')}>
            {t('percent')}
          </Label>
          <div className="relative">
            <Input
              id="yield-percent"
              inputMode="numeric"
              value={mode === 'measured' ? (impliedPercent !== null ? String(impliedPercent) : '') : percentText}
              disabled={mode === 'measured'}
              aria-invalid={mode === 'percent' && problem !== null}
              onChange={(e) => onChange({ yieldPercentText: e.target.value })}
              className="pr-8 text-right tabular-nums"
            />
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">%</span>
          </div>
        </div>
        <div className="flex flex-col gap-1">
          {mode === 'measured' ? (
            <>
              <Label htmlFor="yield-measured">{t('measured')}</Label>
              <div className="relative">
                <Input
                  id="yield-measured"
                  inputMode="decimal"
                  value={measuredText}
                  aria-invalid={problem !== null}
                  onChange={(e) => onChange({ measuredText: e.target.value })}
                  className="pr-8 text-right tabular-nums"
                />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">g</span>
              </div>
            </>
          ) : (
            <>
              <span className="text-xs text-muted-foreground">{t('finished')}</span>
              <span className="flex h-10 items-center rounded-lg bg-surface-2 px-3 font-semibold tabular-nums">
                {finishedGrams !== null ? formatWeight(finishedGrams) : '—'}
              </span>
            </>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <label className="inline-flex cursor-pointer items-center gap-2">
          <input type="radio" name="yield-mode" checked={mode === 'percent'} onChange={() => onChange({ yieldMode: 'percent' })} />
          {t('modePercent')}
        </label>
        <label className="inline-flex cursor-pointer items-center gap-2">
          <input type="radio" name="yield-mode" checked={mode === 'measured'} onChange={() => onChange({ yieldMode: 'measured' })} />
          {t('modeMeasured')}
        </label>
      </div>
      {problem ? (
        <p className="text-xs text-red-700 dark:text-red-300">{problem}</p>
      ) : mode === 'percent' && inputGrams === null ? (
        <p className="text-xs text-amber-700 dark:text-amber-300">{t('needsMeasured')}</p>
      ) : (
        <p className="text-xs text-muted-foreground">{mode === 'percent' ? t('hintPercent') : t('hintMeasured')}</p>
      )}

      <div className="flex flex-wrap items-end gap-2 border-t border-border pt-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="yield-qty">{t('makes')}</Label>
          <Input
            id="yield-qty"
            inputMode="decimal"
            value={yieldQuantity}
            placeholder={tw('yieldQuantityPlaceholder')}
            onChange={(e) => onChange({ yieldQuantity: e.target.value })}
            className="w-24 text-right tabular-nums"
          />
        </div>
        <Input
          value={yieldUnit}
          placeholder={tw('yieldUnitPlaceholder')}
          aria-label={tw('yieldUnitPlaceholder')}
          onChange={(e) => onChange({ yieldUnit: e.target.value })}
          className="w-48"
        />
      </div>
    </fieldset>
  );
}
