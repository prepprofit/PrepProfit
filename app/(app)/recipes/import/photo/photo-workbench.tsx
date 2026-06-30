'use client';

import { useEffect, useMemo, useRef, useState, useActionState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  Camera,
  CheckCircle2,
  AlertTriangle,
  Sparkles,
  Plus,
  Trash2,
  RotateCcw,
  ArrowRight,
  Image as ImageIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { type MeasurementSystem } from '@/lib/units';
import { useActionError } from '@/lib/i18n/use-action-error';
import type { ActionErrorCode } from '@/lib/action-result';
import type {
  PhotoDraftLine,
  PhotoExtractionDraft,
  PhotoExtractionPreview,
} from '@/lib/ai/types';
import { deriveDraftLineStatus } from '@/lib/ai/photo-draft';
import { RECIPE_NOTES_MAX_LENGTH } from '@/lib/validation/recipes';
import { parseRecipeUnit } from '@/lib/units/descriptor';
import { parseQuantityText } from '@/lib/units/quantity';
import { confirmImportAction, type ImportActionState } from '@/app/(app)/import/actions';
import {
  RecipeResolutionPanel,
  RecipeGrid,
  Stat,
  initResolutionChoices,
  buildResolutions,
  countUnresolved,
  countDimensionMismatches,
} from '@/app/(app)/import/recipe-resolution';
import type { IngredientOption } from '@/lib/data/ingredients';

const ISSUE_DISPLAY_LIMIT = 50;

/** True measurable units offered in the per-line unit picker. */
const CANONICAL_UNITS = ['g', 'kg', 'ml', 'l', 'tsp', 'tbsp', 'cup', 'floz', 'oz', 'lb', 'count'];
/** Package/entry descriptors (need a pack size to canonicalize). */
const DESCRIPTOR_UNITS = ['pkt', 'bag', 'box', 'block', 'can', 'jar', 'bunch', 'clove', 'slice', 'sheet', 'stick', 'pinch'];
/** Measurable units a package size can be expressed in. */
const PACK_UNITS = ['g', 'kg', 'ml', 'l', 'oz', 'lb'];

const inputClass =
  'w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm text-foreground outline-none focus:border-accent-500';

/** Parse a written quantity to a number for live status, or null when unusable. */
function deriveQuantity(text: string): number | null {
  if (text.trim() === '') return null;
  const parsed = parseQuantityText(text);
  return 'value' in parsed ? parsed.value : null;
}

/**
 * AI photo extraction workbench (Sprint 4.7 improvement plan). The upload returns an
 * EDITABLE PhotoExtractionDraft — every line the model read is shown (ready /
 * needs_review / ignored), and the chef corrects name/quantity/unit/package size/
 * section, adds missing lines, or removes crossed-out ones, all on one screen. Only
 * when every active line is ready does Stage post the edited draft to the server,
 * which validates it, builds the import job, and returns the resolution preview —
 * then the unchanged confirm path creates the recipe.
 */
export function PhotoImportWorkbench({
  measurementSystem,
  ingredientOptions,
}: {
  measurementSystem: MeasurementSystem;
  ingredientOptions: IngredientOption[];
}) {
  const [resetKey, setResetKey] = useState(0);
  return (
    <PhotoFlow
      key={resetKey}
      measurementSystem={measurementSystem}
      ingredientOptions={ingredientOptions}
      onStartOver={() => setResetKey((k) => k + 1)}
    />
  );
}

function PhotoFlow({
  measurementSystem,
  ingredientOptions,
  onStartOver,
}: {
  measurementSystem: MeasurementSystem;
  ingredientOptions: IngredientOption[];
  onStartOver: () => void;
}) {
  const t = useTranslations('recipes.importPhoto');
  const actionError = useActionError();

  const [extracting, setExtracting] = useState(false);
  const [staging, setStaging] = useState(false);
  const [error, setError] = useState<ActionErrorCode | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<PhotoExtractionDraft | null>(null);
  const [preview, setPreview] = useState<PhotoExtractionPreview | null>(null);
  const [linkChoices, setLinkChoices] = useState<Record<string, string>>({});

  const [confirmState, confirmAction, confirming] = useActionState(
    confirmImportAction,
    null as ImportActionState | null,
  );
  const committed =
    confirmState?.ok && confirmState.phase === 'committed' ? confirmState : null;

  // Free the local object URL when the photo changes or the flow unmounts.
  useEffect(() => () => { if (imageUrl) URL.revokeObjectURL(imageUrl); }, [imageUrl]);

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    setSelectedFile(file);
    if (file) setError(null);
    // Allow re-selecting the same file (onChange won't fire otherwise).
    e.target.value = '';
  }

  async function onExtract(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!selectedFile || selectedFile.size === 0) {
      setError('INVALID_INPUT');
      return;
    }
    setError(null);
    setExtracting(true);
    try {
      const data = new FormData();
      data.set('image', selectedFile);
      const res = await fetch('/api/recipes/import/photo', { method: 'POST', body: data });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { code?: ActionErrorCode };
        setError(body.code ?? 'UNEXPECTED');
        return;
      }
      const result = (await res.json()) as PhotoExtractionDraft;
      setDraft(result);
      setImageUrl(URL.createObjectURL(selectedFile));
    } catch {
      setError('UNEXPECTED');
    } finally {
      setExtracting(false);
    }
  }

  function patchRecipe(patch: Partial<PhotoExtractionDraft['recipe']>) {
    setDraft((d) => (d ? { ...d, recipe: { ...d.recipe, ...patch } } : d));
  }

  function patchLine(id: string, patch: Partial<PhotoDraftLine>) {
    setDraft((d) =>
      d
        ? {
            ...d,
            recipe: {
              ...d.recipe,
              lines: d.recipe.lines.map((l) => (l.id === id ? { ...l, ...patch } : l)),
            },
          }
        : d,
    );
  }

  function addLine() {
    const line: PhotoDraftLine = {
      id: crypto.randomUUID(),
      rawText: null,
      section: null,
      ingredientName: '',
      quantityText: null,
      quantityValue: null,
      unitToken: null,
      packageSizeValue: null,
      packageSizeUnitToken: null,
      confidence: 1,
      status: 'needs_review',
      issues: [],
    };
    setDraft((d) => (d ? { ...d, recipe: { ...d.recipe, lines: [...d.recipe.lines, line] } } : d));
  }

  async function onStage() {
    if (!draft) return;
    setError(null);
    setStaging(true);
    try {
      const payload = {
        attemptId: draft.attemptId,
        recipe: {
          name: draft.recipe.name,
          yieldPortions: draft.recipe.yieldPortions,
          preparationNotes: draft.recipe.preparationNotes,
          lines: draft.recipe.lines.map((l) => ({ ...l, issues: [] })),
        },
      };
      const res = await fetch('/api/recipes/import/photo/stage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { code?: ActionErrorCode };
        setError(body.code ?? 'UNEXPECTED');
        return;
      }
      const result = (await res.json()) as PhotoExtractionPreview;
      setPreview(result);
      setLinkChoices(initResolutionChoices(result.recipePayload));
    } catch {
      setError('UNEXPECTED');
    } finally {
      setStaging(false);
    }
  }

  if (committed) {
    // The recipe name is still in client state (preview is not cleared on commit),
    // so the finish screen can name what it created without a server round-trip.
    const createdName = preview?.recipePayload.recipes[0]?.name?.trim() ?? null;
    const headline =
      !committed.alreadyCommitted && createdName
        ? t('committed.createdNamed', { name: createdName })
        : committed.alreadyCommitted
          ? t('committed.already')
          : t('committed.created', { count: committed.created });
    const newIngredients = committed.newIngredientCount ?? 0;

    return (
      <Card>
        <CardContent className="flex flex-col gap-5 py-6">
          <div className="flex items-center gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-500/15">
              <CheckCircle2 className="size-5 text-emerald-600 dark:text-emerald-400" />
            </span>
            <p className="text-base font-semibold text-foreground">{headline}</p>
          </div>

          {/* Vision/import prices are never trusted, so new ingredients land unpriced —
              nudge the chef to set prices so the recipe cost is honest. */}
          {newIngredients > 0 && (
            <div className="flex flex-col items-start gap-2 rounded-lg border border-amber-300/60 bg-amber-50 p-3 dark:border-amber-500/30 dark:bg-amber-500/10">
              <p className="inline-flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-300">
                <AlertTriangle className="size-4" />
                {t('committed.newIngredients', { count: newIngredients })}
              </p>
              <Link
                href="/ingredients"
                className="inline-flex items-center gap-1.5 text-sm font-medium text-amber-800 underline-offset-2 hover:underline dark:text-amber-200"
              >
                {t('committed.reviewIngredients')}
                <ArrowRight className="size-3.5" />
              </Link>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            {committed.recipeId && (
              <Button asChild>
                <Link href={`/recipes/${committed.recipeId}`}>
                  {t('committed.viewRecipe')}
                  <ArrowRight className="size-4" />
                </Link>
              </Button>
            )}
            <Button variant="outline" onClick={onStartOver}>
              {t('committed.importAnother')}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (preview) {
    return (
      <PhotoPreview
        preview={preview}
        measurementSystem={measurementSystem}
        ingredientOptions={ingredientOptions}
        choices={linkChoices}
        onChoiceChange={(name, value) =>
          setLinkChoices((prev) => ({ ...prev, [name]: value }))
        }
        confirmState={confirmState}
        confirmAction={confirmAction}
        confirming={confirming}
        onStartOver={onStartOver}
      />
    );
  }

  if (draft) {
    return (
      <DraftWorkbench
        draft={draft}
        imageUrl={imageUrl}
        error={error}
        staging={staging}
        onPatchRecipe={patchRecipe}
        onPatchLine={patchLine}
        onAddLine={addLine}
        onRemoveLine={(id) => patchLine(id, { status: 'ignored' })}
        onRestoreLine={(id) => patchLine(id, { status: 'needs_review' })}
        onStage={onStage}
        onStartOver={onStartOver}
      />
    );
  }

  // Upload.
  return (
    <Card>
      <ExtractionProgressDialog open={extracting} />
      <CardHeader>
        <CardTitle>{t('upload.title')}</CardTitle>
        <CardDescription>{t('upload.help')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onExtract} className="flex flex-col gap-4">
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            capture="environment"
            onChange={onPickFile}
            className="hidden"
          />
          <input
            ref={galleryInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={onPickFile}
            className="hidden"
          />
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              type="button"
              variant="outline"
              className="flex-1"
              disabled={extracting}
              onClick={() => cameraInputRef.current?.click()}
            >
              <Camera className="size-4" />
              {t('upload.takePhoto')}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="flex-1"
              disabled={extracting}
              onClick={() => galleryInputRef.current?.click()}
            >
              <ImageIcon className="size-4" />
              {t('upload.chooseFromGallery')}
            </Button>
          </div>
          {selectedFile && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <CheckCircle2 className="size-4 text-accent-600" />
              {selectedFile.name}
            </p>
          )}
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {actionError(error)}
            </p>
          )}
          <div>
            <Button type="submit" disabled={extracting || !selectedFile}>
              {extracting ? (
                <>
                  <Sparkles className="size-4 animate-pulse" />
                  {t('upload.extracting')}
                </>
              ) : (
                <>
                  <Sparkles className="size-4" />
                  {t('upload.cta')}
                </>
              )}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Extraction progress modal                                                  */
/* -------------------------------------------------------------------------- */

/** Step message keys, shown in order; the flow holds on the last one. */
const PROGRESS_STEP_KEYS = ['reading', 'ingredients', 'quantities', 'assembling'] as const;
const STEP_INTERVAL_MS = 3500;
const PROGRESS_TICK_MS = 150;
/** The bar eases toward this ceiling but never reaches it until the server replies. */
const PROGRESS_CEILING = 92;

/**
 * Non-dismissible loading dialog shown while the photo is being extracted
 * (a 15–20s server round-trip). It does NOT report real progress — the bar
 * eases asymptotically toward a ceiling and the step message advances on a
 * timer, so the wait feels alive and never looks frozen. When `open` flips
 * back to false the dialog closes; the bar snaps to 100% on the way out.
 */
function ExtractionProgressDialog({ open }: { open: boolean }) {
  const t = useTranslations('recipes.importPhoto');
  const [progress, setProgress] = useState(0);
  const [stepIndex, setStepIndex] = useState(0);

  // Reset and drive the animations only while open.
  useEffect(() => {
    if (!open) {
      setProgress(100); // snap full on the way out
      return;
    }
    setProgress(0);
    setStepIndex(0);

    const bar = setInterval(() => {
      setProgress((p) => p + (PROGRESS_CEILING - p) * 0.045);
    }, PROGRESS_TICK_MS);
    const step = setInterval(() => {
      setStepIndex((i) => Math.min(i + 1, PROGRESS_STEP_KEYS.length - 1));
    }, STEP_INTERVAL_MS);

    return () => {
      clearInterval(bar);
      clearInterval(step);
    };
  }, [open]);

  return (
    <Dialog open={open}>
      <DialogContent
        // Stay put: the extraction is in flight, so block every close affordance.
        onEscapeKeyDown={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        className="max-w-md"
      >
        <div className="flex flex-col items-center gap-5 rounded-xl border border-border bg-surface p-8 text-center shadow-xl">
          <span className="flex size-12 items-center justify-center rounded-full bg-accent-50 dark:bg-accent-500/10">
            <Sparkles className="size-6 animate-pulse text-accent-600 dark:text-accent-400" />
          </span>

          <div className="flex flex-col gap-1.5">
            <DialogTitle className="text-base font-semibold text-foreground">
              {t('upload.progress.title')}
            </DialogTitle>
            <p className="text-sm text-muted-foreground" aria-live="polite">
              {t(`upload.progress.steps.${PROGRESS_STEP_KEYS[stepIndex]}`)}
            </p>
          </div>

          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2"
            role="progressbar"
            aria-label={t('upload.progress.title')}
          >
            <div
              className="h-full rounded-full bg-accent-500 transition-[width] duration-150 ease-out"
              style={{ width: `${progress}%` }}
            />
          </div>

          <DialogDescription className="text-xs text-muted-foreground">
            {t('upload.progress.hint')}
          </DialogDescription>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/* Editable draft workbench                                                   */
/* -------------------------------------------------------------------------- */

function DraftWorkbench({
  draft,
  imageUrl,
  error,
  staging,
  onPatchRecipe,
  onPatchLine,
  onAddLine,
  onRemoveLine,
  onRestoreLine,
  onStage,
  onStartOver,
}: {
  draft: PhotoExtractionDraft;
  imageUrl: string | null;
  error: ActionErrorCode | null;
  staging: boolean;
  onPatchRecipe: (patch: Partial<PhotoExtractionDraft['recipe']>) => void;
  onPatchLine: (id: string, patch: Partial<PhotoDraftLine>) => void;
  onAddLine: () => void;
  onRemoveLine: (id: string) => void;
  onRestoreLine: (id: string) => void;
  onStage: () => void;
  onStartOver: () => void;
}) {
  const t = useTranslations('recipes.importPhoto');
  const actionError = useActionError();

  const lines = draft.recipe.lines;
  const activeLines = lines.filter((l) => l.status !== 'ignored');
  const ignoredLines = lines.filter((l) => l.status === 'ignored');

  // Live resolvability — the SAME derivation the server uses (G2 stays consistent).
  const needsReview = activeLines.filter((l) => deriveDraftLineStatus(l).status === 'needs_review');
  const blocked = activeLines.length === 0 || needsReview.length > 0;

  // Group active lines by section (first-seen order) for review.
  const groups = useMemo(() => {
    const acc: { section: string | null; items: PhotoDraftLine[] }[] = [];
    for (const l of activeLines) {
      const key = l.section?.trim() ? l.section.trim() : null;
      let g = acc.find((x) => x.section === key);
      if (!g) {
        g = { section: key, items: [] };
        acc.push(g);
      }
      g.items.push(l);
    }
    return acc;
  }, [activeLines]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('draft.title')}</CardTitle>
        <CardDescription>{t('draft.subtitle')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {draft.qualityFlags.length > 0 && (
          <div className="flex flex-col gap-2 rounded-lg border border-amber-300/60 bg-amber-50 p-3 dark:border-amber-500/30 dark:bg-amber-500/10">
            <p className="inline-flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-300">
              <AlertTriangle className="size-4" />
              {t('preview.qualityTitle')}
            </p>
            <ul className="flex flex-col gap-1 text-sm text-amber-700 dark:text-amber-200">
              {draft.qualityFlags.map((flag) => (
                <li key={flag}>{t(`flags.${flag}`)}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
          {/* Source photo (local preview only — never uploaded back). */}
          {imageUrl && (
            <div className="order-first lg:order-none">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={imageUrl}
                alt={t('draft.photoAlt')}
                className="sticky top-4 max-h-[70vh] w-full rounded-lg border border-border object-contain"
              />
            </div>
          )}

          <div className="flex flex-col gap-4">
            {/* Recipe header. */}
            <div className="flex flex-col gap-3 sm:flex-row">
              <label className="flex flex-1 flex-col gap-1 text-xs font-medium text-muted-foreground">
                {t('draft.recipeName')}
                <input
                  className={inputClass}
                  value={draft.recipe.name}
                  onChange={(e) => onPatchRecipe({ name: e.target.value })}
                />
              </label>
              <label className="flex w-full flex-col gap-1 text-xs font-medium text-muted-foreground sm:w-32">
                {t('draft.yield')}
                <input
                  className={inputClass}
                  type="number"
                  min={1}
                  value={draft.recipe.yieldPortions ?? ''}
                  placeholder={t('draft.yieldPlaceholder')}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    onPatchRecipe({
                      yieldPortions: e.target.value === '' || !Number.isFinite(n) || n < 1 ? null : Math.floor(n),
                    });
                  }}
                />
              </label>
            </div>

            {/* Instructions / notes read from the photo — reviewed/edited before staging
                (AI output is untrusted; the chef confirms it). Capped to the persistable
                recipe bound so the reviewed text matches what can be saved. */}
            <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
              {t('draft.instructionsNotes')}
              <textarea
                className={`${inputClass} min-h-24 resize-y`}
                value={draft.recipe.preparationNotes ?? ''}
                maxLength={RECIPE_NOTES_MAX_LENGTH}
                placeholder={t('draft.instructionsNotesPlaceholder')}
                onChange={(e) =>
                  onPatchRecipe({
                    preparationNotes: e.target.value === '' ? null : e.target.value,
                  })
                }
              />
            </label>

            {/* Lines grouped by section. */}
            {groups.map((group, gi) => (
              <div key={gi} className="flex flex-col gap-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {group.section ?? t('draft.sectionNone')}
                </p>
                <ul className="flex flex-col gap-2">
                  {group.items.map((line) => (
                    <LineEditor
                      key={line.id}
                      line={line}
                      onPatch={(patch) => onPatchLine(line.id, patch)}
                      onRemove={() => onRemoveLine(line.id)}
                    />
                  ))}
                </ul>
              </div>
            ))}

            <div>
              <Button variant="outline" size="sm" onClick={onAddLine}>
                <Plus className="size-4" />
                {t('draft.addLine')}
              </Button>
            </div>

            {/* Removed (ignored) lines — restorable until staging. */}
            {ignoredLines.length > 0 && (
              <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-2/40 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('draft.removed')}
                </p>
                <ul className="flex flex-col gap-1">
                  {ignoredLines.map((line) => (
                    <li key={line.id} className="flex items-center justify-between gap-2 text-sm">
                      <span className="text-muted-foreground line-through">
                        {line.ingredientName || line.rawText || t('draft.unnamed')}
                      </span>
                      <Button variant="ghost" size="sm" onClick={() => onRestoreLine(line.id)}>
                        <RotateCcw className="size-3.5" />
                        {t('draft.restore')}
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>

        {error && (
          <p className="text-sm text-destructive" role="alert">
            {actionError(error)}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={onStage} disabled={blocked || staging}>
            {staging ? t('draft.staging') : t('draft.stage')}
          </Button>
          {blocked && (
            <p className="text-sm text-muted-foreground">
              {activeLines.length === 0 ? t('draft.noLines') : t('draft.blockedHint', { count: needsReview.length })}
            </p>
          )}
          <Button variant="ghost" onClick={onStartOver} disabled={staging}>
            {t('startOver')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function LineEditor({
  line,
  onPatch,
  onRemove,
}: {
  line: PhotoDraftLine;
  onPatch: (patch: Partial<PhotoDraftLine>) => void;
  onRemove: () => void;
}) {
  const t = useTranslations('recipes.importPhoto');
  const { status, issues } = deriveDraftLineStatus(line);
  const isDescriptor = parseRecipeUnit(line.unitToken ?? '').kind === 'descriptor';

  // The unit picker offers canonical units + descriptors, preserving the model's
  // token if it is something else (so a rare unit is never silently lost).
  const cur = (line.unitToken ?? '').trim().toLowerCase();
  const extra = cur && ![...CANONICAL_UNITS, ...DESCRIPTOR_UNITS].includes(cur) ? [cur] : [];

  return (
    <li
      className={`flex flex-col gap-2 rounded-lg border p-2.5 ${
        status === 'needs_review' ? 'border-amber-400/70 bg-amber-50/40 dark:bg-amber-500/5' : 'border-border'
      }`}
    >
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-[10rem] flex-1 flex-col gap-1 text-[11px] font-medium text-muted-foreground">
          {t('draft.ingredientName')}
          <input
            className={inputClass}
            value={line.ingredientName}
            onChange={(e) => onPatch({ ingredientName: e.target.value })}
          />
        </label>
        <label className="flex w-20 flex-col gap-1 text-[11px] font-medium text-muted-foreground">
          {t('draft.quantity')}
          <input
            className={inputClass}
            value={line.quantityText ?? ''}
            onChange={(e) =>
              onPatch({ quantityText: e.target.value, quantityValue: deriveQuantity(e.target.value) })
            }
          />
        </label>
        <label className="flex w-28 flex-col gap-1 text-[11px] font-medium text-muted-foreground">
          {t('draft.unit')}
          <select
            className={inputClass}
            value={cur}
            onChange={(e) => onPatch({ unitToken: e.target.value === '' ? null : e.target.value })}
          >
            <option value="">{t('draft.unitNone')}</option>
            {extra.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
            {CANONICAL_UNITS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
            {DESCRIPTOR_UNITS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </label>
        <Button
          variant="ghost"
          size="sm"
          onClick={onRemove}
          aria-label={t('draft.remove')}
          className="text-muted-foreground hover:text-destructive"
        >
          <Trash2 className="size-4" />
        </Button>
      </div>

      {/* Package size — shown for a descriptor unit; canonicalizes the line. */}
      {isDescriptor && (
        <div className="flex flex-wrap items-end gap-2 pl-1">
          <span className="pb-1.5 text-[11px] font-medium text-muted-foreground">
            {t('draft.packageSize')}
          </span>
          <label className="flex w-20 flex-col gap-1 text-[11px] text-muted-foreground">
            <span className="sr-only">{t('draft.packageSizeValue')}</span>
            <input
              className={inputClass}
              inputMode="decimal"
              value={line.packageSizeValue ?? ''}
              onChange={(e) => {
                const n = Number(e.target.value);
                onPatch({
                  packageSizeValue: e.target.value !== '' && Number.isFinite(n) && n > 0 ? n : null,
                  // The chef is overriding the value — it is no longer the inferred pack.
                  packageSizeInferred: false,
                });
              }}
            />
          </label>
          <label className="flex w-24 flex-col gap-1 text-[11px] text-muted-foreground">
            <span className="sr-only">{t('draft.packageSizeUnit')}</span>
            <select
              className={inputClass}
              value={line.packageSizeUnitToken ?? ''}
              onChange={(e) =>
                onPatch({
                  packageSizeUnitToken: e.target.value === '' ? null : e.target.value,
                  packageSizeInferred: false,
                })
              }
            >
              <option value="">—</option>
              {PACK_UNITS.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </label>
          {line.packageSizeInferred && (
            <span className="inline-flex items-center gap-1 pb-1.5 text-[11px] text-accent-600 dark:text-accent-400">
              <Sparkles className="size-3" />
              {t('draft.packageSizeInferred')}
            </span>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 pl-1">
        <label className="flex flex-1 items-center gap-1.5 text-[11px] text-muted-foreground">
          {t('draft.section')}
          <input
            className={`${inputClass} max-w-[12rem]`}
            value={line.section ?? ''}
            onChange={(e) => onPatch({ section: e.target.value === '' ? null : e.target.value })}
          />
        </label>
        {status === 'needs_review' ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
            <AlertTriangle className="size-3" />
            {issues[0] ? t(`draftIssues.${issues[0].code}`) : t('draft.status.needsReview')}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
            <CheckCircle2 className="size-3" />
            {t('draft.status.ready')}
          </span>
        )}
      </div>
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/* Post-stage resolution + confirm (reuses the 4.6 panel/grid, unchanged)     */
/* -------------------------------------------------------------------------- */

function PhotoPreview({
  preview,
  measurementSystem,
  ingredientOptions,
  choices,
  onChoiceChange,
  confirmState,
  confirmAction,
  confirming,
  onStartOver,
}: {
  preview: PhotoExtractionPreview;
  measurementSystem: MeasurementSystem;
  ingredientOptions: IngredientOption[];
  choices: Record<string, string>;
  onChoiceChange: (name: string, value: string) => void;
  confirmState: ImportActionState | null;
  confirmAction: (formData: FormData) => void;
  confirming: boolean;
  onStartOver: () => void;
}) {
  const t = useTranslations('recipes.importPhoto');
  const tImport = useTranslations('import');
  const tResolve = useTranslations('import.recipes.resolve');
  const actionError = useActionError();
  const { counts, issues, recipePayload, qualityFlags } = preview;
  const shownIssues = issues.slice(0, ISSUE_DISPLAY_LIMIT);
  const resolutionsJson = useMemo(
    () => JSON.stringify(buildResolutions(choices)),
    [choices],
  );
  const unresolved = countUnresolved(recipePayload, choices);
  const mismatches = countDimensionMismatches(recipePayload, choices, ingredientOptions);
  const resolutionBlocked = unresolved > 0 || mismatches > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('preview.title')}</CardTitle>
        <CardDescription>{t('preview.subtitle')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {qualityFlags.length > 0 && (
          <div className="flex flex-col gap-2 rounded-lg border border-amber-300/60 bg-amber-50 p-3 dark:border-amber-500/30 dark:bg-amber-500/10">
            <p className="inline-flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-300">
              <AlertTriangle className="size-4" />
              {t('preview.qualityTitle')}
            </p>
            <ul className="flex flex-col gap-1 text-sm text-amber-700 dark:text-amber-200">
              {qualityFlags.map((flag) => (
                <li key={flag}>{t(`flags.${flag}`)}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex flex-wrap gap-2 text-sm">
          <Stat tone="good" label={t('preview.importable', { count: counts.importable })} />
          {counts.skipped > 0 && (
            <Stat tone="muted" label={t('preview.skipped', { count: counts.skipped })} />
          )}
        </div>

        {issues.length > 0 && (
          <div className="flex flex-col gap-2">
            <p className="inline-flex items-center gap-2 text-sm font-medium text-foreground">
              <AlertTriangle className="size-4 text-amber-500" />
              {tImport('issues.title')}
            </p>
            <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
              {shownIssues.map((issue, i) => (
                <li key={`${issue.line}-${issue.column}-${i}`}>
                  <span className="font-medium text-foreground">
                    {tImport('issues.line', { line: issue.line })}
                  </span>
                  {issue.column && <span> · {issue.column}</span>}
                  <span> — {tImport(`issues.codes.${issue.code}`)}</span>
                </li>
              ))}
            </ul>
            {issues.length > shownIssues.length && (
              <p className="text-xs text-muted-foreground">
                {tImport('issues.more', { count: issues.length - shownIssues.length })}
              </p>
            )}
          </div>
        )}

        <RecipeResolutionPanel
          payload={recipePayload}
          choices={choices}
          onChange={onChoiceChange}
          ingredientOptions={ingredientOptions}
        />
        <RecipeGrid payload={recipePayload} measurementSystem={measurementSystem} />

        {confirmState && !confirmState.ok && (
          <p className="text-sm text-destructive" role="alert">
            {actionError(confirmState.code)}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-3">
          {counts.importable > 0 ? (
            <form action={confirmAction}>
              <input type="hidden" name="jobId" value={preview.jobId} />
              <input type="hidden" name="resolutions" value={resolutionsJson} />
              <Button type="submit" disabled={confirming || resolutionBlocked}>
                {confirming
                  ? t('preview.confirming')
                  : t('preview.confirm', { count: counts.importable })}
              </Button>
            </form>
          ) : (
            <p className="text-sm text-muted-foreground">{t('preview.nothingToImport')}</p>
          )}
          {resolutionBlocked && (
            <p className="text-sm text-muted-foreground">
              {unresolved > 0
                ? tResolve('resolveMissingHint', { count: unresolved })
                : tResolve('fixDimensionHint', { count: mismatches })}
            </p>
          )}
          <Button variant="ghost" onClick={onStartOver} disabled={confirming}>
            {t('startOver')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
