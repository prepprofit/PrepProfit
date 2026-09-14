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
import { useActionError } from '@/lib/i18n/use-action-error';
import { saveWorkspaceAction } from '@/app/(app)/recipes/[id]/workspace-actions';
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
import {
  RecipeMethodEdit,
  type DraftMethodSection,
  type DraftStep,
} from './recipe-method-edit';
import {
  CostPanel,
  MethodPanel,
  type MethodSectionView,
  type WorkspaceCostView,
} from './recipe-workspace-tabs';
import type { UomTabItem } from './recipe-uom-tab';
import {
  RecipeNutritionTab,
  type NutritionTabData,
} from './recipe-nutrition-tab';

/**
 * Serializable workspace payload the Server Component ships to this client
 * root. Built from `RecipeWorkspaceDTO` — for kitchen the money fields are
 * ABSENT server-side (`cost: null`, no prices anywhere), this component never
 * decides visibility itself (Sprint F4).
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
    notes: string | null;
    coverMediaId: string | null;
    /** Signed short-lived URL (null when unset or signing unavailable). */
    coverUrl: string | null;
  };
  sections: DraftSection[];
  lines: DraftLine[];
  methodSections: MethodSectionView[];
  /** Raw method draft the edit mode starts from (same rows, ungrouped). */
  methodDraftSections: DraftMethodSection[];
  methodDraftSteps: DraftStep[];
  books: { bookId: string; bookName: string }[];
  ingredientOptions: PickerOption[];
  componentOptions: PickerOption[];
  cost: WorkspaceCostView;
  currency: string;
  /**
   * Unit-conversion anchors per ingredient. Not rendered on this screen any more —
   * the line editor still needs them to convert entered units (cup, tbsp…).
   */
  uom: UomTabItem[];
  /** Nutrition data (Fase 6) — operational, both roles; edit = manager. */
  nutrition: NutritionTabData;
};

type Draft = {
  name: string;
  subtitle: string;
  yieldQuantity: string;
  yieldUnit: string;
  sections: DraftSection[];
  lines: DraftLine[];
  methodSections: DraftMethodSection[];
  steps: DraftStep[];
  coverMediaId: string | null;
  coverUrl: string | null;
};

/**
 * Recipe page. The RECIPE leads, at full width: name, "Scale recipe", and the
 * ingredient / sub-recipe quantities, with a pencil Edit button. Preparation
 * method, cost (managers), nutrition and allergens follow BELOW — never in a side
 * panel that squeezes the recipe.
 *
 * Scaling is a temporary kitchen calculation (never saved). Editing is a separate
 * local draft — name, yield, cover, lines and method — saved atomically through
 * `saveWorkspaceAction` with optimistic concurrency, or cancelled. Edit state is
 * plain component state (no URL round-trip), so the editor opens instantly.
 */
export function RecipeWorkspace({
  data,
  allergenPanel,
}: {
  data: WorkspaceClientData;
  /** Operational allergen panel (Sprint 9), rendered below the recipe. */
  allergenPanel?: React.ReactNode;
}) {
  const t = useTranslations('recipes.workspace');
  const actionError = useActionError();
  const router = useRouter();

  const [factor, setFactor] = React.useState(1);

  // Per-ingredient UoM context for the line editor (anchors + prep picker).
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

  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [conflict, setConflict] = React.useState(false);
  const [confirmCancel, setConfirmCancel] = React.useState(false);
  const initialDraftKey = React.useRef<string | null>(null);

  const editing = draft !== null;
  const dirty = draft !== null && JSON.stringify(draft) !== initialDraftKey.current;

  React.useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const startEdit = () => {
    const next: Draft = {
      name: data.recipe.name,
      subtitle: data.recipe.subtitle ?? '',
      yieldQuantity: data.recipe.yieldQuantity === null ? '' : String(data.recipe.yieldQuantity),
      yieldUnit: data.recipe.yieldUnit ?? '',
      sections: data.sections,
      lines: data.lines,
      methodSections: data.methodDraftSections,
      steps: data.methodDraftSteps,
      coverMediaId: data.recipe.coverMediaId,
      coverUrl: data.recipe.coverUrl,
    };
    initialDraftKey.current = JSON.stringify(next);
    setDraft(next);
    setError(null);
    setConflict(false);
  };

  const closeEditor = () => {
    setDraft(null);
    setError(null);
    setConfirmCancel(false);
  };

  const cancelEdit = () => {
    if (dirty) setConfirmCancel(true);
    else closeEditor();
  };

  const nameMissing = draft !== null && draft.name.trim() === '';

  const save = async () => {
    if (!draft || nameMissing) return;
    setSaving(true);
    setError(null);
    const yieldQuantity =
      draft.yieldQuantity.trim() === '' ? null : Number(draft.yieldQuantity.replace(',', '.'));
    try {
      const result = await saveWorkspaceAction({
        recipeId: data.recipe.id,
        expectedVersion: data.recipe.version,
        header: {
          name: draft.name.trim(),
          subtitle: draft.subtitle.trim() === '' ? null : draft.subtitle.trim(),
          yieldQuantity:
            yieldQuantity !== null && Number.isFinite(yieldQuantity) && yieldQuantity > 0 ? yieldQuantity : null,
          yieldUnit: draft.yieldUnit.trim() === '' ? null : draft.yieldUnit.trim(),
          coverMediaId: draft.coverMediaId,
        },
        sections: draft.sections.map((s) => ({
          id: s.id,
          tempId: s.id ? undefined : s.ref,
          title: s.title.trim() || '…',
        })),
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
        methodSections: draft.methodSections.map((s) => ({
          id: s.id,
          tempId: s.id ? undefined : s.ref,
          title: s.title.trim() || '…',
        })),
        steps: draft.steps
          .filter((s) => s.instruction.trim() !== '')
          .map((s) => ({
            id: s.id,
            instruction: s.instruction.trim(),
            sectionRef: s.sectionRef,
            mediaIds: s.media.map((m) => m.mediaId),
          })),
      });
      if (result.ok) {
        closeEditor();
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

  const editActions = (
    <div className="flex items-center gap-2">
      <Button type="button" variant="outline" onClick={cancelEdit} disabled={saving}>
        {t('cancel')}
      </Button>
      <Button type="button" onClick={save} disabled={saving || nameMissing}>
        {saving ? t('saving') : t('saveRecipe')}
      </Button>
    </div>
  );

  const yieldText =
    data.recipe.yieldQuantity !== null && data.recipe.yieldUnit
      ? `${Math.round(data.recipe.yieldQuantity * factor * 100) / 100} ${data.recipe.yieldUnit}`
      : t('portions', { count: Math.round(data.recipe.yieldPortions * factor * 100) / 100 });

  return (
    <div className="flex w-full flex-col gap-6">
      {conflict ? (
        <div
          role="alert"
          className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm dark:border-red-800 dark:bg-red-950/40"
        >
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

      {/* ── The recipe ──────────────────────────────────────────────────────── */}
      <Card>
        <CardContent className="flex flex-col gap-5 pt-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            {editing ? (
              <div className="grid w-full max-w-3xl grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5 sm:col-span-2">
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
                <div className="flex flex-col gap-1.5 sm:col-span-2">
                  <Label htmlFor="recipe-subtitle">{t('subtitlePlaceholder')}</Label>
                  <Input
                    id="recipe-subtitle"
                    value={draft.subtitle}
                    onChange={(e) => setDraft({ ...draft, subtitle: e.target.value })}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="recipe-yield-qty">{t('yield')}</Label>
                  <div className="flex gap-2">
                    <Input
                      id="recipe-yield-qty"
                      value={draft.yieldQuantity}
                      onChange={(e) => setDraft({ ...draft, yieldQuantity: e.target.value })}
                      placeholder={t('yieldQuantityPlaceholder')}
                      inputMode="decimal"
                      className="w-24 text-right tabular-nums"
                    />
                    <Input
                      value={draft.yieldUnit}
                      onChange={(e) => setDraft({ ...draft, yieldUnit: e.target.value })}
                      placeholder={t('yieldUnitPlaceholder')}
                      aria-label={t('yieldUnitPlaceholder')}
                      className="flex-1"
                    />
                  </div>
                </div>
                <div className="flex flex-col gap-1.5">
                  <span className="text-sm font-medium text-foreground">{t('media.cover')}</span>
                  <div className="flex items-center gap-2">
                    {draft.coverMediaId ? (
                      <>
                        {draft.coverUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element -- short signed URL from the private store; next/image cannot optimize it
                          <img src={draft.coverUrl} alt="" className="h-10 w-16 rounded-md border border-border object-cover" />
                        ) : null}
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => setDraft({ ...draft, coverMediaId: null, coverUrl: null })}
                        >
                          {t('media.removeCover')}
                        </Button>
                      </>
                    ) : (
                      <RecipeMediaUpload
                        recipeId={data.recipe.id}
                        label={t('media.setCover')}
                        onUploaded={(m) => setDraft({ ...draft, coverMediaId: m.mediaId, coverUrl: m.url })}
                      />
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex min-w-0 flex-1 items-start gap-4">
                {data.recipe.coverUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- short signed URL from the private store; next/image cannot optimize it
                  <img
                    src={data.recipe.coverUrl}
                    alt=""
                    className="hidden h-20 w-28 shrink-0 rounded-xl border border-border object-cover sm:block"
                  />
                ) : null}
                <div className="min-w-0">
                  <h1 className="font-display text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
                    {data.recipe.name}
                  </h1>
                  {data.recipe.subtitle ? (
                    <p className="text-sm text-muted-foreground">{data.recipe.subtitle}</p>
                  ) : null}
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t('yield')}: <span className="tabular-nums text-foreground">{yieldText}</span>
                    {data.recipe.yieldWeightGrams !== null
                      ? ` · ${t('yieldWeight')}: ${Math.round(data.recipe.yieldWeightGrams * factor)} g`
                      : ''}
                  </p>
                  {data.books.length > 0 ? (
                    <p className="mt-2 flex flex-wrap gap-1">
                      {data.books.map((b) => (
                        <span key={b.bookId} className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted-foreground">
                          {b.bookName}
                        </span>
                      ))}
                    </p>
                  ) : null}
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              {editing ? (
                editActions
              ) : (
                <>
                  <Button asChild variant="ghost" size="sm">
                    <Link href={`/recipes/${data.recipe.id}/slideshow`}>
                      <Presentation className="size-4" aria-hidden />
                      {t('slideshow.open')}
                    </Link>
                  </Button>
                  <Button type="button" onClick={startEdit} aria-label={t('editRecipe', { name: data.recipe.name })}>
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

          <section aria-labelledby="recipe-ingredients" className="flex flex-col gap-2">
            <h2 id="recipe-ingredients" className="text-base font-semibold text-foreground">
              {t('ingredients')}
            </h2>
            {editing ? (
              <RecipeInputListEdit
                sections={draft.sections}
                lines={draft.lines}
                ingredientOptions={data.ingredientOptions}
                componentOptions={data.componentOptions}
                lineUom={lineUom}
                onSectionsChange={(sections) => setDraft({ ...draft, sections })}
                onLinesChange={(lines) => setDraft({ ...draft, lines })}
              />
            ) : (
              <RecipeInputListView
                sections={data.sections}
                lines={data.lines}
                factor={factor}
                onAnchorScale={(base, target) => setFactor(target / base)}
              />
            )}
          </section>

          {editing ? <div className="flex justify-end border-t border-border pt-4">{editActions}</div> : null}
        </CardContent>
      </Card>

      {/* ── Supporting sections, below the recipe ───────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>{t('tabs.method')}</CardTitle>
        </CardHeader>
        <CardContent>
          {editing ? (
            <RecipeMethodEdit
              recipeId={data.recipe.id}
              sections={draft.methodSections}
              steps={draft.steps}
              onSectionsChange={(methodSections) => setDraft({ ...draft, methodSections })}
              onStepsChange={(steps) => setDraft({ ...draft, steps })}
            />
          ) : (
            <MethodPanel sections={data.methodSections} legacyNotes={data.recipe.notes} />
          )}
        </CardContent>
      </Card>

      {/* Cost is manager-only: the kitchen payload ships `cost: null`. */}
      {data.cost !== null ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('tabs.cost')}</CardTitle>
          </CardHeader>
          <CardContent>
            <CostPanel
              cost={data.cost}
              factor={factor}
              currency={data.currency}
              recipeId={data.recipe.id}
              recipeYield={{
                yieldQuantity: data.recipe.yieldQuantity,
                yieldUnit: data.recipe.yieldUnit,
                yieldPortions: data.recipe.yieldPortions,
              }}
            />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t('tabs.nutrition')}</CardTitle>
        </CardHeader>
        <CardContent>
          <RecipeNutritionTab recipeId={data.recipe.id} data={data.nutrition} />
        </CardContent>
      </Card>

      {allergenPanel}

      <p className="text-center">
        <Link
          href={`/recipes/${data.recipe.id}?editor=legacy`}
          className="text-xs text-muted-foreground underline-offset-2 hover:underline"
        >
          {t('legacyEditorLink')}
        </Link>
      </p>

      <ConfirmDialog
        open={confirmCancel}
        title={t('discard.title')}
        description={t('discard.body')}
        confirmLabel={t('discard.confirm')}
        cancelLabel={t('discard.keep')}
        destructive
        onConfirm={closeEditor}
        onCancel={() => setConfirmCancel(false)}
      />
    </div>
  );
}
