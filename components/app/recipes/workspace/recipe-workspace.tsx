'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
  RecipeWorkspaceTabs,
  type MethodSectionView,
  type WorkspaceCostView,
  type WorkspaceTab,
} from './recipe-workspace-tabs';
import { RecipeUomTab, type UomTabItem } from './recipe-uom-tab';
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
  /** UoM tab data (Fase 4) — operational, both roles. */
  uom: UomTabItem[];
  /** Nutrition tab data (Fase 6) — operational, both roles; edit = manager. */
  nutrition: NutritionTabData;
};

const TABS: WorkspaceTab[] = ['method', 'cost', 'nutrition', 'uom'];

/**
 * Recipes 2.0 workspace root (plan §8/§9): split view, `?tab=`/`?mode=` as URL
 * state, client-side derived batch scaling, and an edit draft persisted
 * atomically via `saveWorkspaceAction` with optimistic concurrency.
 */
export function RecipeWorkspace({
  data,
  allergenPanel,
}: {
  data: WorkspaceClientData;
  /** Operational allergen panel (Sprint 9) — rendered in the right column,
      inside the tabbed block so the sticky tab bar travels across it. */
  allergenPanel?: React.ReactNode;
}) {
  const t = useTranslations('recipes.workspace');
  const actionError = useActionError();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const tabParam = searchParams.get('tab');
  const tab: WorkspaceTab = TABS.includes(tabParam as WorkspaceTab)
    ? (tabParam as WorkspaceTab)
    : 'method';
  const mode = searchParams.get('mode') === 'edit' ? 'edit' : 'view';

  const setParam = (key: 'tab' | 'mode', value: string | null) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value === null) params.delete(key);
    else params.set(key, value);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  // ── view-mode derived scale (never persisted) ──────────────────────────
  const [factor, setFactor] = React.useState(1);

  // Per-ingredient UoM context for the line editor (anchors + prep picker),
  // derived from the UoM tab payload (operational, both roles).
  const lineUom = React.useMemo(() => {
    const map: Record<string, LineUom> = {};
    for (const item of data.uom) {
      map[item.ingredientId] = {
        anchors: item.equivalency,
        prepActions: item.prepActions.map((p) => ({
          id: p.id,
          name: p.name,
          anchors: {
            weightGrams: p.weightGrams,
            volumeMl: p.volumeMl,
            eachCount: p.eachCount,
          },
        })),
      };
    }
    return map;
  }, [data.uom]);

  // ── edit draft (local until Done) ──────────────────────────────────────
  const [draft, setDraft] = React.useState<{
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
  } | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [conflict, setConflict] = React.useState(false);

  const startEdit = () => {
    setDraft({
      name: data.recipe.name,
      subtitle: data.recipe.subtitle ?? '',
      yieldQuantity:
        data.recipe.yieldQuantity === null
          ? ''
          : String(data.recipe.yieldQuantity),
      yieldUnit: data.recipe.yieldUnit ?? '',
      sections: data.sections,
      lines: data.lines,
      methodSections: data.methodDraftSections,
      steps: data.methodDraftSteps,
      coverMediaId: data.recipe.coverMediaId,
      coverUrl: data.recipe.coverUrl,
    });
    setError(null);
    setConflict(false);
    setParam('mode', 'edit');
  };

  const cancelEdit = () => {
    setDraft(null);
    setError(null);
    setParam('mode', null);
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    const yieldQuantity =
      draft.yieldQuantity.trim() === ''
        ? null
        : Number(draft.yieldQuantity.replace(',', '.'));
    const result = await saveWorkspaceAction({
      recipeId: data.recipe.id,
      expectedVersion: data.recipe.version,
      header: {
        name: draft.name.trim() || undefined,
        subtitle: draft.subtitle.trim() === '' ? null : draft.subtitle.trim(),
        yieldQuantity:
          yieldQuantity !== null && Number.isFinite(yieldQuantity) && yieldQuantity > 0
            ? yieldQuantity
            : null,
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
    setSaving(false);
    if (result.ok) {
      setDraft(null);
      setParam('mode', null);
      router.refresh();
    } else if (result.code === 'WORKSPACE_VERSION_CONFLICT') {
      setConflict(true);
    } else {
      setError(actionError(result.code));
    }
  };

  const editing = mode === 'edit' && draft !== null;

  return (
    <div className="flex flex-col gap-4">
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
              setDraft(null);
              setParam('mode', null);
              router.refresh();
            }}
          >
            {t('reload')}
          </Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      ) : null}

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          {editing ? (
            <div className="flex flex-col gap-2">
              <Input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder={t('namePlaceholder')}
                className="max-w-md text-lg font-semibold"
                aria-label={t('namePlaceholder')}
              />
              <Input
                value={draft.subtitle}
                onChange={(e) =>
                  setDraft({ ...draft, subtitle: e.target.value })
                }
                placeholder={t('subtitlePlaceholder')}
                className="max-w-md"
                aria-label={t('subtitlePlaceholder')}
              />
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  {t('yield')}
                </span>
                <Input
                  value={draft.yieldQuantity}
                  onChange={(e) =>
                    setDraft({ ...draft, yieldQuantity: e.target.value })
                  }
                  placeholder={t('yieldQuantityPlaceholder')}
                  inputMode="decimal"
                  className="h-8 w-24"
                  aria-label={t('yieldQuantityPlaceholder')}
                />
                <Input
                  value={draft.yieldUnit}
                  onChange={(e) =>
                    setDraft({ ...draft, yieldUnit: e.target.value })
                  }
                  placeholder={t('yieldUnitPlaceholder')}
                  className="h-8 w-44"
                  aria-label={t('yieldUnitPlaceholder')}
                />
              </div>
              <div className="flex items-center gap-2">
                {draft.coverMediaId ? (
                  <>
                    {draft.coverUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- short signed URL from the private store; next/image cannot optimize it
                      <img
                        src={draft.coverUrl}
                        alt=""
                        className="h-14 w-20 rounded-md border border-border object-cover"
                      />
                    ) : null}
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setDraft({ ...draft, coverMediaId: null, coverUrl: null })
                      }
                    >
                      {t('media.removeCover')}
                    </Button>
                  </>
                ) : (
                  <RecipeMediaUpload
                    recipeId={data.recipe.id}
                    label={t('media.setCover')}
                    onUploaded={(m) =>
                      setDraft({
                        ...draft,
                        coverMediaId: m.mediaId,
                        coverUrl: m.url,
                      })
                    }
                  />
                )}
              </div>
            </div>
          ) : (
            <>
              {data.recipe.coverUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- short signed URL from the private store; next/image cannot optimize it
                <img
                  src={data.recipe.coverUrl}
                  alt=""
                  className="mb-2 h-32 w-full max-w-md rounded-xl border border-border object-cover"
                />
              ) : null}
              <h1 className="truncate text-2xl font-semibold">
                {data.recipe.name}
              </h1>
              {data.recipe.subtitle ? (
                <p className="text-sm text-muted-foreground">
                  {data.recipe.subtitle}
                </p>
              ) : null}
              <p className="mt-1 text-sm text-muted-foreground">
                {t('yield')}:{' '}
                {data.recipe.yieldQuantity !== null && data.recipe.yieldUnit
                  ? `${data.recipe.yieldQuantity * factor} ${data.recipe.yieldUnit}`
                  : t('portions', {
                      count: Math.round(data.recipe.yieldPortions * factor),
                    })}
                {data.recipe.yieldWeightGrams !== null
                  ? ` · ${t('yieldWeight')}: ${Math.round(
                      data.recipe.yieldWeightGrams * factor,
                    )} g`
                  : ''}
              </p>
              {data.books.length > 0 ? (
                <p className="mt-1 flex flex-wrap gap-1">
                  {data.books.map((b) => (
                    <span
                      key={b.bookId}
                      className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted-foreground"
                    >
                      {b.bookName}
                    </span>
                  ))}
                </p>
              ) : null}
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={`/recipes/${data.recipe.id}?editor=legacy`}
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
          >
            {t('legacyEditorLink')}
          </Link>
          {!editing ? (
            <Button asChild variant="outline" size="sm">
              <Link href={`/recipes/${data.recipe.id}/slideshow`}>
                {t('slideshow.open')}
              </Link>
            </Button>
          ) : null}
          {editing ? (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={cancelEdit}
                disabled={saving}
              >
                {t('cancel')}
              </Button>
              <Button type="button" onClick={save} disabled={saving}>
                {saving ? t('saving') : t('done')}
              </Button>
            </>
          ) : (
            <Button type="button" onClick={startEdit}>
              {t('edit')}
            </Button>
          )}
        </div>
      </div>

      {/* Split pane: stacked below lg, 50/50 from lg up (plan §14). */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="min-w-0">
          {!editing ? (
            <div className="mb-3">
              <BatchScaleControl factor={factor} onFactorChange={setFactor} />
            </div>
          ) : null}
          <h2 className="mb-2 text-sm font-semibold">{t('ingredients')}</h2>
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
        </div>
        <div className="min-w-0">
          <RecipeWorkspaceTabs
            tab={tab}
            onTabChange={(next) => setParam('tab', next)}
            methodSections={data.methodSections}
            methodEditor={
              editing ? (
                <RecipeMethodEdit
                  recipeId={data.recipe.id}
                  sections={draft.methodSections}
                  steps={draft.steps}
                  onSectionsChange={(methodSections) =>
                    setDraft({ ...draft, methodSections })
                  }
                  onStepsChange={(steps) => setDraft({ ...draft, steps })}
                />
              ) : null
            }
            uomPanel={<RecipeUomTab items={data.uom} />}
            nutritionPanel={
              <RecipeNutritionTab
                recipeId={data.recipe.id}
                data={data.nutrition}
              />
            }
            allergenPanel={allergenPanel}
            legacyNotes={data.recipe.notes}
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
        </div>
      </div>
    </div>
  );
}
