'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { startWorkflow } from '@flows/react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { useActionError } from '@/lib/i18n/use-action-error';
import type { WeightDisplayUnit } from '@/lib/format/weight';
import type { FolderTreeNode } from '@/lib/folders/tree';
import {
  addComponentLine,
  addIngredientLine,
  draftInputWeightGrams,
  firstComponentWithoutWeight,
  linesForSave,
  parseAmount,
  validatePresetRows,
  weightSummary,
  type DraftLine,
  type DraftMethodSection,
  type DraftSection,
  type DraftStep,
  type LineUom,
  type PickerOption,
  type PresetProblem,
  type PresetRow,
} from '@/lib/recipes/editor-model';
import { createRecipeFromEditorAction, saveRecipeEditorAction } from '@/app/(app)/recipes/editor-actions';
import { RecipeMediaUpload } from '@/components/app/recipes/workspace/recipe-media-upload';
import { FolderSelect } from './folder-select';
import { IngredientRows } from './ingredient-list';
import { IngredientSearch, type SearchPick } from './ingredient-search';
import { MethodSection } from './method-section';
import { PresetsSection } from './presets-section';
import { UnitSwitch } from './unit-switch';
import { EditorWeightSummary, type YieldDraft } from './weight-summary';
import { useLeaveGuard } from './use-leave-guard';

/** Everything the editor needs — empty for a new recipe, the saved values when editing. */
export type RecipeEditorData = {
  recipe: {
    /** null = a new recipe: nothing exists until "Save recipe" succeeds. */
    id: string | null;
    version: number | null;
    name: string;
    folderId: string | null;
    displayUnit: WeightDisplayUnit;
    notes: string;
    yieldPercentage: number;
    yieldWeightSource: 'measured' | 'calculated' | null;
    yieldWeightGrams: number | null;
    yieldReviewNeeded: boolean;
    coverMediaId: string | null;
    coverUrl: string | null;
  };
  sections: DraftSection[];
  lines: DraftLine[];
  methodSections: DraftMethodSection[];
  steps: DraftStep[];
  presets: { id: string; name: string; targetWeightGrams: number }[];
  folders: FolderTreeNode[];
  ingredientOptions: PickerOption[];
  componentOptions: PickerOption[];
  lineUom: Record<string, LineUom>;
};

type Draft = {
  name: string;
  folderId: string | null;
  displayUnit: WeightDisplayUnit;
  lines: DraftLine[];
  notes: string;
  steps: DraftStep[];
  presets: PresetRow[];
  yield: YieldDraft;
  coverMediaId: string | null;
  coverUrl: string | null;
};

function initialDraft(data: RecipeEditorData): Draft {
  const r = data.recipe;
  return {
    name: r.name,
    folderId: r.folderId,
    displayUnit: r.displayUnit,
    lines: data.lines,
    notes: r.notes,
    steps: data.steps,
    presets: data.presets.map((p) => ({ key: p.id, id: p.id, name: p.name, weightText: String(p.targetWeightGrams) })),
    yield: {
      mode: r.yieldWeightSource === 'measured' ? 'measured' : 'percent',
      percentText: String(r.yieldPercentage),
      measuredText: r.yieldWeightSource === 'measured' && r.yieldWeightGrams != null ? String(r.yieldWeightGrams) : '',
    },
    coverMediaId: r.coverMediaId,
    coverUrl: r.coverUrl,
  };
}

/**
 * The recipe editor — ONE form for creating and editing: name, folder, ingredients
 * (with one shared g/kg switch), a compact weight summary, the preparation method /
 * notes, and optional kitchen presets. Everything is a local draft saved atomically
 * by "Save recipe"; a new recipe only exists once that save succeeds, so Cancel never
 * leaves an empty record behind. Scaling, slideshow and prep tasks live on the saved
 * recipe, not here.
 */
export function RecipeEditor({
  data,
  cancelHref,
  initialFinishedWeightOpen = false,
  details,
}: {
  data: RecipeEditorData;
  /** Where Cancel goes: the recipe (editing) or the list/folder it was started from. */
  cancelHref: string;
  initialFinishedWeightOpen?: boolean;
  /** Edit mode only: the saved recipe's cost and nutrition, shown collapsed. */
  details?: { cost?: React.ReactNode; nutrition?: React.ReactNode };
}) {
  const t = useTranslations('recipes.editor');
  const actionError = useActionError();
  const router = useRouter();
  const isNew = data.recipe.id === null;

  const [draft, setDraft] = React.useState<Draft>(() => initialDraft(data));
  const initialKey = React.useRef(JSON.stringify(initialDraft(data)));
  const [folders, setFolders] = React.useState(data.folders);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [conflict, setConflict] = React.useState(false);
  const [nameError, setNameError] = React.useState(false);
  const [invalidLineKey, setInvalidLineKey] = React.useState<string | null>(null);
  const [presetProblem, setPresetProblem] = React.useState<{ key: string; problem: PresetProblem } | null>(null);
  const [presetsOpen, setPresetsOpen] = React.useState(false);
  const [yieldOpen, setYieldOpen] = React.useState(initialFinishedWeightOpen);
  const [leaveHref, setLeaveHref] = React.useState<string | null>(null);
  const [announcement, setAnnouncement] = React.useState('');

  const nameRef = React.useRef<HTMLInputElement>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const quantityRefs = React.useRef(new Map<string, HTMLInputElement>());
  const pendingFocus = React.useRef<string | null>(null);

  const dirty = JSON.stringify(draft) !== initialKey.current;

  useLeaveGuard(dirty && !saving, (href) => setLeaveHref(href));

  React.useEffect(() => {
    if (isNew) nameRef.current?.focus();
  }, [isNew]);

  // Focus a row's quantity once it has rendered (after add / duplicate pick / remove).
  React.useEffect(() => {
    const key = pendingFocus.current;
    if (!key) return;
    pendingFocus.current = null;
    if (key === '__search__') {
      searchRef.current?.focus();
      return;
    }
    const el = quantityRefs.current.get(key);
    el?.focus();
    el?.select();
  });

  const patch = (next: Partial<Draft>) => setDraft((d) => ({ ...d, ...next }));

  // ── Derived numbers (live, from the draft) ──────────────────────────────────
  const summary = weightSummary(draft.lines);
  const inputGrams = draftInputWeightGrams(draft.lines);
  const percent = parseAmount(draft.yield.percentText);
  const percentValid = percent !== null && Number.isInteger(percent) && percent >= 1 && percent <= 100;
  const measured = draft.yield.measuredText === '' ? null : Number(draft.yield.measuredText);
  const measuredValid = measured !== null && Number.isFinite(measured) && measured > 0;
  const finishedGrams =
    draft.yield.mode === 'measured'
      ? measuredValid
        ? measured
        : null
      : percentValid && inputGrams !== null
        ? Math.round(((inputGrams * (percent as number)) / 100) * 100) / 100
        : null;
  const yieldProblem =
    draft.yield.mode === 'percent'
      ? percentValid
        ? null
        : t('weight.percentInvalid')
      : measuredValid
        ? null
        : t('weight.finishedInvalid');

  const usedIngredientIds = React.useMemo(
    () => new Set(draft.lines.flatMap((l) => (l.kind === 'ingredient' ? [l.ingredientId] : []))),
    [draft.lines],
  );
  const usedComponentIds = React.useMemo(
    () => new Set(draft.lines.flatMap((l) => (l.kind === 'component' ? [l.componentRecipeId] : []))),
    [draft.lines],
  );

  const onPick = (pick: SearchPick) => {
    const result =
      pick.kind === 'ingredient' ? addIngredientLine(draft.lines, pick.option) : addComponentLine(draft.lines, pick.option);
    if (result.added) patch({ lines: result.lines });
    setAnnouncement(result.added ? t('ingredients.added', { name: pick.option.name }) : t('ingredients.alreadyAdded', { name: pick.option.name }));
    pendingFocus.current = result.focusKey;
    if (!result.added) {
      // Nothing re-renders the list for a duplicate pick, so focus right away.
      const el = quantityRefs.current.get(result.focusKey);
      el?.focus();
      el?.select();
      pendingFocus.current = null;
    }
  };

  // ── Save ────────────────────────────────────────────────────────────────────
  const save = async () => {
    if (saving) return;
    setError(null);
    const name = draft.name.trim();
    if (name === '') {
      setNameError(true);
      nameRef.current?.focus();
      return;
    }
    const missingWeight = firstComponentWithoutWeight(draft.lines);
    if (missingWeight) {
      setInvalidLineKey(missingWeight.key);
      setError(t('ingredients.componentNeedsWeight', { name: missingWeight.name }));
      quantityRefs.current.get(missingWeight.key)?.focus();
      return;
    }
    setInvalidLineKey(null);
    if (yieldProblem) {
      setYieldOpen(true);
      setError(yieldProblem);
      return;
    }
    const presets = validatePresetRows(draft.presets);
    if (!presets.ok) {
      setPresetProblem({ key: presets.key, problem: presets.problem });
      setPresetsOpen(true);
      setError(t(`presets.errors.${presets.problem}`));
      return;
    }
    setPresetProblem(null);

    const fields = {
      name,
      folderId: draft.folderId,
      displayUnit: draft.displayUnit,
      notes: draft.notes,
      yield: {
        percentage:
          draft.yield.mode === 'percent'
            ? (percent as number)
            : inputGrams !== null && measuredValid
              ? Math.min(100, Math.max(1, Math.round(((measured as number) / inputGrams) * 100)))
              : percentValid
                ? (percent as number)
                : data.recipe.yieldPercentage,
        measuredGrams: draft.yield.mode === 'measured' ? measured : null,
      },
      lines: linesForSave(draft.lines),
      presets: presets.presets,
    };

    setSaving(true);
    try {
      if (isNew) {
        const result = await createRecipeFromEditorAction(fields);
        if (!result.ok) {
          setError(actionError(result.code));
          return;
        }
        initialKey.current = JSON.stringify(draft);
        void startWorkflow('first-recipe-created').catch(() => undefined);
        router.push(`/recipes/${result.data.id}?saved=1`);
        return;
      }
      const result = await saveRecipeEditorAction({
        ...fields,
        recipeId: data.recipe.id,
        expectedVersion: data.recipe.version,
        sections: data.sections.map((s) => ({ id: s.id, tempId: s.id ? undefined : s.ref, title: s.title.trim() || '…' })),
        methodSections: data.methodSections.map((s) => ({ id: s.id, tempId: s.id ? undefined : s.ref, title: s.title.trim() || '…' })),
        steps: draft.steps
          .filter((s) => s.instruction.trim() !== '')
          .map((s) => ({ id: s.id, instruction: s.instruction.trim(), sectionRef: s.sectionRef, mediaIds: s.media.map((m) => m.mediaId) })),
        coverMediaId: draft.coverMediaId,
      });
      if (!result.ok) {
        if (result.code === 'WORKSPACE_VERSION_CONFLICT') setConflict(true);
        else setError(actionError(result.code));
        return;
      }
      initialKey.current = JSON.stringify(draft);
      router.push(`/recipes/${data.recipe.id}?saved=1`);
    } finally {
      setSaving(false);
    }
  };

  // Ctrl/Cmd+S saves from anywhere in the form.
  const saveRef = React.useRef(save);
  saveRef.current = save;
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const cancel = () => {
    if (dirty) setLeaveHref(cancelHref);
    else router.push(cancelHref);
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 pb-10">
      {/* ── Action bar: stays reachable while the form scrolls ─────────────── */}
      <div className="sticky -top-4 z-20 -mx-4 flex items-center justify-between gap-3 bg-background/95 px-4 py-3 backdrop-blur md:-top-6 lg:-top-8">
        <h1 className="truncate text-sm font-medium text-muted-foreground">{isNew ? t('newTitle') : t('editTitle')}</h1>
        <div className="flex shrink-0 items-center gap-2">
          <Button type="button" variant="ghost" onClick={cancel} disabled={saving}>
            {t('cancel')}
          </Button>
          <Button type="button" onClick={() => void save()} disabled={saving} className="min-w-32">
            {saving ? t('saving') : t('save')}
          </Button>
        </div>
      </div>

      {conflict ? (
        <div role="alert" className="rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm dark:border-red-800 dark:bg-red-950/40">
          <p className="font-medium">{t('conflictTitle')}</p>
          <p className="text-muted-foreground">{t('conflictBody')}</p>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-500/15 dark:text-red-300">
          {error}
        </p>
      ) : null}

      {/* ── Name, folder, ingredients, weight ─────────────────────────────── */}
      <Card>
        <CardContent className="flex flex-col gap-6 p-5 sm:p-7">
          <div className="flex flex-col gap-2">
            <label htmlFor="recipe-editor-name" className="text-sm font-medium text-muted-foreground">
              {t('nameLabel')}
            </label>
            <input
              id="recipe-editor-name"
              ref={nameRef}
              value={draft.name}
              maxLength={160}
              autoComplete="off"
              placeholder={t('namePlaceholder')}
              aria-invalid={nameError}
              aria-describedby={nameError ? 'recipe-editor-name-error' : undefined}
              onChange={(e) => {
                patch({ name: e.target.value });
                if (nameError && e.target.value.trim() !== '') setNameError(false);
              }}
              className="h-14 w-full rounded-xl border border-border bg-surface px-4 font-display text-2xl font-semibold tracking-tight text-foreground transition-colors placeholder:font-normal placeholder:text-muted-foreground/60 hover:border-muted-foreground/40 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-16 sm:text-[28px] aria-[invalid=true]:border-red-500"
            />
            {nameError ? (
              <p id="recipe-editor-name-error" className="text-sm text-red-700 dark:text-red-300">
                {t('nameRequired')}
              </p>
            ) : null}
            <div className="flex items-center gap-2">
              <span className="sr-only">{t('folder.label')}</span>
              <FolderSelect
                folders={folders}
                value={draft.folderId}
                onChange={(folderId) => patch({ folderId })}
                onFolderCreated={(folder) => setFolders((list) => [...list, folder])}
              />
            </div>
          </div>

          <section aria-labelledby="recipe-editor-ingredients" className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <h2 id="recipe-editor-ingredients" className="text-lg font-semibold text-foreground">
                {t('ingredients.title')}
              </h2>
              <UnitSwitch value={draft.displayUnit} onChange={(displayUnit) => patch({ displayUnit })} label={t('ingredients.unitSwitch')} />
            </div>

            {draft.lines.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border px-4 py-5 text-center text-sm text-muted-foreground">
                {t('ingredients.empty')}
              </p>
            ) : (
              <IngredientRows
                lines={draft.lines}
                displayUnit={draft.displayUnit}
                lineUom={data.lineUom}
                invalidKey={invalidLineKey}
                onLinesChange={(lines) => {
                  patch({ lines });
                  if (invalidLineKey && !lines.some((l) => l.key === invalidLineKey && l.kind === 'component' && !(l.quantityGrams > 0))) {
                    setInvalidLineKey(null);
                  }
                }}
                registerQuantity={(key, el) => {
                  if (el) quantityRefs.current.set(key, el);
                  else quantityRefs.current.delete(key);
                }}
                onQuantityEnter={() => searchRef.current?.focus()}
                onRemoved={(nextKey) => {
                  pendingFocus.current = nextKey ?? '__search__';
                }}
                announce={setAnnouncement}
              />
            )}

            <div className="sticky -bottom-4 z-10 -mx-1 bg-surface px-1 pb-1 pt-1 md:-bottom-6 lg:-bottom-8">
              <IngredientSearch
                ref={searchRef}
                ingredientOptions={data.ingredientOptions}
                componentOptions={data.componentOptions}
                usedIngredientIds={usedIngredientIds}
                usedComponentIds={usedComponentIds}
                onPick={onPick}
              />
            </div>

            <EditorWeightSummary
              summary={summary}
              displayUnit={draft.displayUnit}
              inputGrams={inputGrams}
              finishedGrams={finishedGrams}
              yieldDraft={draft.yield}
              onYieldChange={(y) => patch({ yield: { ...draft.yield, ...y } })}
              problem={yieldOpen ? yieldProblem : null}
              reviewNeeded={data.recipe.yieldReviewNeeded}
              expanded={yieldOpen}
              onToggle={() => setYieldOpen((v) => !v)}
            />
          </section>
        </CardContent>
      </Card>

      {/* ── Preparation method / notes ─────────────────────────────────────── */}
      <Card>
        <CardContent className="p-5 sm:p-7">
          <MethodSection
            notes={draft.notes}
            onNotesChange={(notes) => patch({ notes })}
            sections={data.methodSections}
            steps={draft.steps}
            onStepsChange={(steps) => patch({ steps })}
          />
        </CardContent>
      </Card>

      {/* ── Kitchen presets (optional, collapsed) ──────────────────────────── */}
      <Card>
        <CardContent className="px-5 py-3 sm:px-7">
          <PresetsSection
            rows={draft.presets}
            onRowsChange={(presets) => {
              patch({ presets });
              setPresetProblem(null);
            }}
            open={presetsOpen}
            onOpenChange={setPresetsOpen}
            problem={presetProblem}
          />
        </CardContent>
      </Card>

      {/* ── Saved-recipe details, collapsed (edit only) ────────────────────── */}
      {!isNew ? (
        <Card>
          <CardContent className="px-5 py-1 sm:px-7">
            <h2 className="sr-only">{t('details.title')}</h2>
            <Accordion type="multiple" defaultValue={[]}>
              {details?.cost ? (
                <AccordionItem value="cost">
                  <AccordionTrigger className="text-base">{t('details.cost')}</AccordionTrigger>
                  <AccordionContent className="flex flex-col gap-3">
                    <p className="text-xs text-muted-foreground">{t('details.savedNote')}</p>
                    {details.cost}
                  </AccordionContent>
                </AccordionItem>
              ) : null}
              {details?.nutrition ? (
                <AccordionItem value="nutrition">
                  <AccordionTrigger className="text-base">{t('details.nutrition')}</AccordionTrigger>
                  <AccordionContent className="flex flex-col gap-4">
                    <p className="text-xs text-muted-foreground">{t('details.savedNote')}</p>
                    {details.nutrition}
                  </AccordionContent>
                </AccordionItem>
              ) : null}
              <AccordionItem value="photo">
                <AccordionTrigger className="text-base">{t('details.photo')}</AccordionTrigger>
                <AccordionContent>
                  <div className="flex flex-wrap items-center gap-3">
                    {draft.coverMediaId ? (
                      <>
                        {draft.coverUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element -- short signed URL from the private store; next/image cannot optimize it
                          <img src={draft.coverUrl} alt="" className="h-16 w-24 rounded-lg border border-border object-cover" />
                        ) : null}
                        <Button type="button" size="sm" variant="ghost" onClick={() => patch({ coverMediaId: null, coverUrl: null })}>
                          {t('details.removePhoto')}
                        </Button>
                      </>
                    ) : data.recipe.id ? (
                      <RecipeMediaUpload
                        recipeId={data.recipe.id}
                        label={t('details.addPhoto')}
                        onUploaded={(m) => patch({ coverMediaId: m.mediaId, coverUrl: m.url })}
                      />
                    ) : null}
                  </div>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </CardContent>
        </Card>
      ) : null}

      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>

      <ConfirmDialog
        open={leaveHref !== null}
        title={t('discard.title')}
        description={isNew ? t('discard.bodyNew') : t('discard.body')}
        confirmLabel={t('discard.confirm')}
        cancelLabel={t('discard.keep')}
        destructive
        onConfirm={() => {
          const href = leaveHref;
            initialKey.current = JSON.stringify(draft);
          setLeaveHref(null);
          if (href) router.push(href);
        }}
        onCancel={() => setLeaveHref(null)}
      />
    </div>
  );
}
