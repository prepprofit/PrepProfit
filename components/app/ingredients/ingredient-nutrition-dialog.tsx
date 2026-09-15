'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Check, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { useActionError } from '@/lib/i18n/use-action-error';
import {
  CORE_NUTRIENT_KEYS,
  NUTRIENT_KEYS,
  type IngredientNutritionStatus,
  type NutrientKey,
} from '@/lib/calculations/nutrition';
import { NUTRIENT_MAX } from '@/lib/validation/ingredient-nutrition';
import { parseNutrientInput } from '@/lib/nutrition/manual-input';
import {
  nutritionViewMissingCore,
  nutritionViewStatus,
  type IngredientNutritionView,
} from '@/lib/nutrition/profile-view';
import type { UsdaFood } from '@/lib/usda/client';
import type { ActionErrorCode } from '@/lib/action-result';
import {
  lookupExternalFoodByBarcodeAction,
  previewUsdaFoodAction,
  refreshIngredientNutritionAction,
  saveIngredientNutritionAction,
  searchUsdaFoodsAction,
  updateIngredientNutritionValuesAction,
  type ExternalFoodPreview,
} from '@/app/(app)/ingredients/nutrition-actions';

/**
 * THE ingredient nutrition editor — opened from the Nutrition action on the
 * Ingredients list and from a recipe's Nutrition tab ("Add nutrition"), so both
 * edit the ONE profile the ingredient owns (never a recipe copy).
 *
 * Nutrition is optional and never interrupts other work. There is no Save
 * button:
 *  - a food / barcode result is only SELECTED for review; "Use this match" is
 *    the one explicit action that saves it (and replaces an existing profile);
 *  - manual values autosave after a short pause or on leaving the field. Only
 *    valid numbers are sent; a momentarily empty field is never a deletion —
 *    clearing a saved value is the explicit Clear button; 0 is a real zero.
 *    A failed save keeps the typed values and offers Retry, and closing with
 *    pending/failed/invalid edits asks before anything is discarded.
 *
 * Kitchen users (`canEdit` false) get a read-only view; every action re-checks
 * the manager role server-side anyway.
 */

export const NUTRIENT_UNIT: Record<NutrientKey, string> = {
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

/** The everyday label nutrients shown when comparing matches. */
const KEY_NUTRIENTS: NutrientKey[] = [
  'caloriesKcal',
  'totalFatG',
  'saturatedFatG',
  'totalCarbohydrateG',
  'totalSugarsG',
  'dietaryFiberG',
  'proteinG',
  'sodiumMg',
];

const CORE_SET: ReadonlySet<NutrientKey> = new Set(CORE_NUTRIENT_KEYS);
const AUTOSAVE_DELAY_MS = 800;
const OFF_LICENSE_URL = 'https://opendatacommons.org/licenses/odbl/1-0/';

type Tab = 'search' | 'barcode' | 'manual';
type ValuePatch = Partial<Record<NutrientKey, number | null>>;
type SaveIndicator =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; message: string; retry: () => void };

function round(v: number): number {
  return Math.round(v * 100) / 100;
}

function formatValue(v: number): string {
  return String(Math.round(v * 10000) / 10000);
}

function manualTexts(view: IngredientNutritionView | null): Record<NutrientKey, string> {
  const out = {} as Record<NutrientKey, string>;
  for (const k of NUTRIENT_KEYS) {
    const v = view && view.source === 'custom' ? view.values[k] : null;
    out[k] = v == null ? '' : formatValue(v);
  }
  return out;
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleDateString('en', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      });
}

export function NutritionStatusChip({
  status,
  className,
}: {
  status: IngredientNutritionStatus;
  className?: string;
}) {
  const t = useTranslations('ingredients.nutrition.status');
  return (
    <span
      className={cn(
        'inline-flex w-fit items-center rounded-full px-2 py-0.5 text-[11px] font-medium',
        status === 'added' &&
          'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-200',
        status === 'incomplete' &&
          'bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200',
        status === 'not_added' && 'bg-surface-2 text-muted-foreground',
        className,
      )}
    >
      {t(status)}
    </span>
  );
}

export function IngredientNutritionDialog({
  ingredientId,
  ingredientName,
  suggestedFdcId = null,
  profile: initialProfile,
  canEdit,
  onChange,
  onClose,
}: {
  ingredientId: string;
  ingredientName: string;
  /** Catalogue USDA hint — offered for review, never saved automatically. */
  suggestedFdcId?: number | null;
  profile: IngredientNutritionView | null;
  canEdit: boolean;
  /** Called after every successful save with the ingredient's new profile. */
  onChange?: (view: IngredientNutritionView | null) => void;
  /** `changed` = at least one save happened while the editor was open. */
  onClose: (changed: boolean) => void;
}) {
  const t = useTranslations('ingredients.nutrition');
  const actionError = useActionError();

  const [profile, setProfile] = React.useState<IngredientNutritionView | null>(initialProfile);
  const changedRef = React.useRef(false);
  const [tab, setTab] = React.useState<Tab>(
    initialProfile?.source === 'custom' ? 'manual' : 'search',
  );
  const [indicator, setIndicator] = React.useState<SaveIndicator>({
    kind: 'idle',
  });
  const [confirmClose, setConfirmClose] = React.useState(false);

  const adopt = React.useCallback(
    (view: IngredientNutritionView | null) => {
      setProfile(view);
      changedRef.current = true;
      onChange?.(view);
    },
    [onChange],
  );

  const autosave = useManualAutosave({
    ingredientId,
    profile,
    onSaved: adopt,
    setIndicator,
    errorMessage: actionError,
  });

  // An external match / refresh / conversion replaces the whole profile.
  const adoptReplacement = React.useCallback(
    (view: IngredientNutritionView) => {
      adopt(view);
      autosave.resetFrom(view);
    },
    [adopt, autosave],
  );

  // Never lose pending edits silently when the tab/window is closed.
  const hasUnsaved = autosave.hasUnsaved;
  React.useEffect(() => {
    if (!hasUnsaved) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [hasUnsaved]);

  const requestClose = async () => {
    const ok = await autosave.flush();
    if (ok && autosave.invalidKeys().length === 0) {
      onClose(changedRef.current);
    } else {
      setConfirmClose(true);
    }
  };

  const status = nutritionViewStatus(profile);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void requestClose();
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        className="top-[5vh] max-h-[90vh] max-w-xl overflow-y-auto rounded-2xl border border-border bg-surface p-5 shadow-lg"
      >
        <IndicatorContext.Provider value={indicator}>
          <div className="flex flex-col gap-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 flex-col gap-1">
                <DialogTitle className="font-display text-lg font-semibold leading-tight">
                  {t('title')}
                </DialogTitle>
                <p className="truncate text-sm text-muted-foreground">{ingredientName}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <SaveIndicatorView indicator={indicator} />
                <NutritionStatusChip status={status} />
                <button
                  type="button"
                  aria-label={t('close')}
                  onClick={() => void requestClose()}
                  className="cursor-pointer rounded-md p-1 text-muted-foreground hover:bg-surface-2 hover:text-foreground"
                >
                  <X className="size-4" />
                </button>
              </div>
            </div>

            {confirmClose ? (
              <div
                role="alert"
                className="flex flex-col gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/40"
              >
                <p className="font-medium">{t('pending.title')}</p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setConfirmClose(false)}
                  >
                    {t('pending.keepEditing')}
                  </Button>
                  {autosave.invalidKeys().length === 0 ? (
                    <Button
                      type="button"
                      size="sm"
                      onClick={async () => {
                        if (await autosave.flush()) onClose(changedRef.current);
                      }}
                    >
                      {t('pending.retry')}
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      autosave.discard();
                      onClose(changedRef.current);
                    }}
                  >
                    {t('pending.discard')}
                  </Button>
                </div>
              </div>
            ) : null}

            <CurrentProfile
              profile={profile}
              canEdit={canEdit}
              ingredientId={ingredientId}
              onRefreshed={adoptReplacement}
              setIndicator={setIndicator}
            />

            {!canEdit ? (
              <p className="text-xs text-muted-foreground">{t('readOnly')}</p>
            ) : (
              <>
                <div role="tablist" className="flex flex-wrap gap-1 rounded-lg bg-surface-2 p-1">
                  {(['search', 'barcode', 'manual'] as const).map((key) => (
                    <button
                      key={key}
                      type="button"
                      role="tab"
                      aria-selected={tab === key}
                      onClick={() => setTab(key)}
                      className={cn(
                        'flex-1 cursor-pointer rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground',
                        tab === key && 'bg-surface text-foreground shadow-sm',
                      )}
                    >
                      {t(`tabs.${key}`)}
                    </button>
                  ))}
                </div>

                {tab === 'search' ? (
                  <SearchPane
                    ingredientId={ingredientId}
                    ingredientName={ingredientName}
                    suggestedFdcId={suggestedFdcId}
                    profile={profile}
                    beforeSave={autosave.flush}
                    onSaved={adoptReplacement}
                    setIndicator={setIndicator}
                    onManual={() => setTab('manual')}
                  />
                ) : null}
                {tab === 'barcode' ? (
                  <BarcodePane
                    ingredientId={ingredientId}
                    profile={profile}
                    beforeSave={autosave.flush}
                    onSaved={adoptReplacement}
                    setIndicator={setIndicator}
                  />
                ) : null}
                {tab === 'manual' ? (
                  <ManualPane
                    ingredientId={ingredientId}
                    profile={profile}
                    autosave={autosave}
                    onConverted={adoptReplacement}
                    setIndicator={setIndicator}
                  />
                ) : null}
              </>
            )}
          </div>
        </IndicatorContext.Provider>
      </DialogContent>
    </Dialog>
  );
}

function SaveIndicatorView({ indicator }: { indicator: SaveIndicator }) {
  const t = useTranslations('ingredients.nutrition.save');
  if (indicator.kind === 'idle') return null;
  if (indicator.kind === 'saving') {
    return (
      <span role="status" className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <Loader2 className="size-3 animate-spin" aria-hidden />
        {t('saving')}
      </span>
    );
  }
  if (indicator.kind === 'saved') {
    return (
      <span role="status" className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <Check className="size-3" aria-hidden />
        {t('saved')}
      </span>
    );
  }
  return null;
}

const IndicatorContext = React.createContext<SaveIndicator>({ kind: 'idle' });

/** Failed-save banner with a clear Retry, shown inside the active pane. */
function SaveErrorBanner() {
  const indicator = React.useContext(IndicatorContext);
  const t = useTranslations('ingredients.nutrition.save');
  if (indicator.kind !== 'error') return null;
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
    >
      <span>{t('failed', { message: indicator.message })}</span>
      <Button type="button" size="sm" variant="outline" onClick={indicator.retry}>
        {t('retry')}
      </Button>
    </div>
  );
}

// ─────────────────────────── manual autosave engine ─────────────────────────

type ManualAutosave = ReturnType<typeof useManualAutosave>;

function useManualAutosave({
  ingredientId,
  profile,
  onSaved,
  setIndicator,
  errorMessage,
}: {
  ingredientId: string;
  profile: IngredientNutritionView | null;
  onSaved: (view: IngredientNutritionView | null) => void;
  setIndicator: (i: SaveIndicator) => void;
  errorMessage: (code: ActionErrorCode) => string;
}) {
  const [texts, setTexts] = React.useState<Record<NutrientKey, string>>(() => manualTexts(profile));
  const textsRef = React.useRef(texts);
  textsRef.current = texts;
  const [failed, setFailed] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  // Keys typed but not yet confirmed by the server: undefined = untouched.
  const pending = React.useRef<ValuePatch>({});
  const [pendingCount, setPendingCount] = React.useState(0);
  const timer = React.useRef<number | null>(null);
  const inFlight = React.useRef<Promise<boolean> | null>(null);
  // The manual values the server currently holds (per 100 g).
  const savedRef = React.useRef<Record<NutrientKey, number | null>>(savedValuesOf(profile));
  savedRef.current = savedValuesOf(profile);

  const syncPendingCount = () => setPendingCount(Object.keys(pending.current).length);

  const clearTimer = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const sendOnce = React.useCallback(async (): Promise<boolean> => {
    const batch = pending.current;
    if (Object.keys(batch).length === 0) return true;
    pending.current = {};
    setBusy(true);
    setIndicator({ kind: 'saving' });
    const result = await updateIngredientNutritionValuesAction({
      ingredientId,
      values: batch,
    }).catch(() => ({ ok: false as const, code: 'UNEXPECTED' as const }));
    setBusy(false);
    if (result.ok) {
      savedRef.current = savedValuesOf(result.data.view);
      onSaved(result.data.view);
      setFailed(false);
      syncPendingCount();
      setIndicator({ kind: 'saved' });
      return true;
    }
    // Keep what was typed: re-queue the batch under any newer edits.
    pending.current = { ...batch, ...pending.current };
    syncPendingCount();
    setFailed(true);
    setIndicator({
      kind: 'error',
      message: errorMessage(result.code),
      retry: () => void flushRef.current(),
    });
    return false;
  }, [ingredientId, onSaved, setIndicator, errorMessage]);

  /** Send everything pending now; resolves false when a save failed. */
  const flush = React.useCallback(async (): Promise<boolean> => {
    clearTimer();
    for (;;) {
      const current = inFlight.current;
      if (current) {
        const ok = await current;
        if (inFlight.current === current) inFlight.current = null;
        if (!ok) return false;
        continue;
      }
      if (Object.keys(pending.current).length === 0) return true;
      const run = sendOnce();
      inFlight.current = run;
      const ok = await run;
      if (inFlight.current === run) inFlight.current = null;
      if (!ok) return false;
    }
  }, [sendOnce]);
  const flushRef = React.useRef(flush);
  flushRef.current = flush;

  const schedule = () => {
    clearTimer();
    timer.current = window.setTimeout(() => {
      timer.current = null;
      void flushRef.current();
    }, AUTOSAVE_DELAY_MS);
  };

  React.useEffect(() => clearTimer, []);

  const setText = (key: NutrientKey, text: string) => {
    setTexts((prev) => ({ ...prev, [key]: text }));
    const parsed = parseNutrientInput(key, text);
    // While a save is in flight the stored value is about to change, so an
    // "unchanged" value is still queued (re-sending it is harmless).
    if (
      parsed.kind === 'value' &&
      (parsed.value !== savedRef.current[key] || inFlight.current !== null)
    ) {
      pending.current = { ...pending.current, [key]: parsed.value };
      syncPendingCount();
      schedule();
      return;
    }
    // Empty (mid-typing) or invalid input is never sent; an unchanged value
    // cancels a queued edit for that field.
    if (key in pending.current) {
      const next = { ...pending.current };
      delete next[key];
      pending.current = next;
      syncPendingCount();
    }
  };

  const blur = (key: NutrientKey) => {
    const parsed = parseNutrientInput(key, textsRef.current[key]);
    const saved = savedRef.current[key];
    // Leaving a field empty is not a deletion: show the saved value again.
    if (parsed.kind === 'empty' && saved !== null && pending.current[key] !== null) {
      setTexts((prev) => ({ ...prev, [key]: formatValue(saved) }));
    }
    void flush();
  };

  const clear = (key: NutrientKey) => {
    setTexts((prev) => ({ ...prev, [key]: '' }));
    pending.current = { ...pending.current, [key]: null };
    syncPendingCount();
    void flush();
  };

  const invalidKeys = () =>
    NUTRIENT_KEYS.filter((k) => parseNutrientInput(k, textsRef.current[k]).kind === 'invalid');

  const resetFrom = React.useCallback((view: IngredientNutritionView | null) => {
    clearTimer();
    pending.current = {};
    setPendingCount(0);
    setFailed(false);
    savedRef.current = savedValuesOf(view);
    setTexts(manualTexts(view));
  }, []);

  const discard = () => {
    clearTimer();
    pending.current = {};
    setPendingCount(0);
  };

  const hasInvalid = NUTRIENT_KEYS.some((k) => parseNutrientInput(k, texts[k]).kind === 'invalid');

  return {
    texts,
    setText,
    blur,
    clear,
    flush,
    discard,
    resetFrom,
    invalidKeys,
    busy,
    failed,
    hasInvalid,
    hasUnsaved: pendingCount > 0 || busy || failed || hasInvalid,
    savedValue: (key: NutrientKey) => savedRef.current[key],
  };
}

function savedValuesOf(view: IngredientNutritionView | null): Record<NutrientKey, number | null> {
  const out = {} as Record<NutrientKey, number | null>;
  for (const k of NUTRIENT_KEYS) {
    out[k] = view && view.source === 'custom' ? view.values[k] : null;
  }
  return out;
}

// ─────────────────────────────── current profile ─────────────────────────────

function CurrentProfile({
  profile,
  canEdit,
  ingredientId,
  onRefreshed,
  setIndicator,
}: {
  profile: IngredientNutritionView | null;
  canEdit: boolean;
  ingredientId: string;
  onRefreshed: (view: IngredientNutritionView) => void;
  setIndicator: (i: SaveIndicator) => void;
}) {
  const t = useTranslations('ingredients.nutrition');
  const tNutrient = useTranslations('recipes.workspace.nutrition.nutrients');
  const actionError = useActionError();
  const [showAll, setShowAll] = React.useState(!canEdit);
  const [refreshing, setRefreshing] = React.useState(false);
  const [refreshError, setRefreshError] = React.useState<string | null>(null);

  if (!profile) {
    return <p className="text-sm text-muted-foreground">{t('empty')}</p>;
  }

  const external = profile.source !== 'custom';
  const missing = nutritionViewMissingCore(profile);
  const updated = formatDate(profile.refreshedAt ?? profile.updatedAt);

  const refresh = async () => {
    setRefreshing(true);
    setRefreshError(null);
    setIndicator({ kind: 'saving' });
    const result = await refreshIngredientNutritionAction({ ingredientId });
    setRefreshing(false);
    if (result.ok) {
      onRefreshed(result.data.view);
      setIndicator({ kind: 'saved' });
    } else {
      setRefreshError(actionError(result.code));
      setIndicator({ kind: 'idle' });
    }
  };

  // Manual profiles are shown (and edited) in the manual form for managers.
  const showValues = external || !canEdit;
  const keys = showAll ? [...NUTRIENT_KEYS] : KEY_NUTRIENTS;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {t(`current.source.${profile.source}`)}
          </p>
          {profile.sourceDescription ? (
            <p className="text-sm font-semibold">{profile.sourceDescription}</p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            {[
              profile.brandOwner,
              profile.barcode,
              profile.basisUnit === 'ml'
                ? t('current.per100ml', { grams: round(profile.basisGrams) })
                : t('current.per100g'),
              updated ? t('current.updated', { date: updated }) : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        {canEdit && external ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={refreshing}
            title={t('current.refreshTitle')}
            onClick={refresh}
          >
            {refreshing ? t('current.refreshing') : t('current.refresh')}
          </Button>
        ) : null}
      </div>

      {refreshError ? (
        <p role="alert" className="text-xs text-red-700 dark:text-red-300">
          {refreshError}
        </p>
      ) : null}

      {showValues ? (
        <>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs">
            {keys.map((key) => (
              <div
                key={key}
                className="flex justify-between gap-2 border-b border-border/50 py-0.5"
              >
                <dt className="text-muted-foreground">{tNutrient(key)}</dt>
                <dd className="tabular-nums">
                  {profile.values[key] === null
                    ? t('current.unknown')
                    : `${round(profile.values[key])} ${NUTRIENT_UNIT[key]}`}
                </dd>
              </div>
            ))}
          </dl>
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="w-fit cursor-pointer text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            {showAll ? t('current.hideAll') : t('current.showAll')}
          </button>
        </>
      ) : null}

      {missing.length > 0 ? (
        <p className="text-xs text-amber-700 dark:text-amber-300">
          {t('current.missingCore', {
            list: missing.map((k) => tNutrient(k)).join(', '),
          })}
        </p>
      ) : null}
    </div>
  );
}

// ─────────────────────────────── search (USDA) ───────────────────────────────

function SearchPane({
  ingredientId,
  ingredientName,
  suggestedFdcId,
  profile,
  beforeSave,
  onSaved,
  setIndicator,
  onManual,
}: {
  ingredientId: string;
  ingredientName: string;
  suggestedFdcId: number | null;
  profile: IngredientNutritionView | null;
  beforeSave: () => Promise<boolean>;
  onSaved: (view: IngredientNutritionView) => void;
  setIndicator: (i: SaveIndicator) => void;
  onManual: () => void;
}) {
  const t = useTranslations('ingredients.nutrition');
  const actionError = useActionError();
  const [scope, setScope] = React.useState<'common' | 'branded'>('common');
  const [query, setQuery] = React.useState(ingredientName);
  const [results, setResults] = React.useState<UsdaFood[] | null>(null);
  const [selected, setSelected] = React.useState<UsdaFood | null>(null);
  const [searching, setSearching] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notConfigured, setNotConfigured] = React.useState(false);
  const [suggested, setSuggested] = React.useState<UsdaFood | null>(null);
  const [loadingSuggested, setLoadingSuggested] = React.useState(false);

  const showSuggestion =
    suggestedFdcId !== null &&
    !(profile?.source === 'usda' && profile.externalId === String(suggestedFdcId));

  const handleFailure = (code: ActionErrorCode) => {
    if (code === 'USDA_NOT_CONFIGURED') setNotConfigured(true);
    else setError(actionError(code));
  };

  const search = async () => {
    setSearching(true);
    setError(null);
    setSelected(null);
    const result = await searchUsdaFoodsAction({ query, scope });
    setSearching(false);
    if (result.ok) setResults(result.data.foods);
    else handleFailure(result.code);
  };

  const loadSuggested = async () => {
    if (suggestedFdcId === null) return;
    setLoadingSuggested(true);
    setError(null);
    const result = await previewUsdaFoodAction({ fdcId: suggestedFdcId });
    setLoadingSuggested(false);
    if (result.ok) {
      setSuggested(result.data.food);
      setSelected(result.data.food);
    } else {
      handleFailure(result.code);
    }
  };

  const applyMatch = async (food: UsdaFood) => {
    setSaving(true);
    setError(null);
    if (!(await beforeSave())) {
      setSaving(false);
      return;
    }
    setIndicator({ kind: 'saving' });
    const result = await saveIngredientNutritionAction({
      source: 'usda',
      ingredientId,
      fdcId: food.fdcId,
    });
    setSaving(false);
    if (result.ok) {
      onSaved(result.data.view);
      setIndicator({ kind: 'saved' });
      setSelected(null);
    } else {
      setIndicator({
        kind: 'error',
        message: actionError(result.code),
        retry: () => void applyMatch(food),
      });
    }
  };

  if (notConfigured) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-sm text-muted-foreground">{t('search.notConfigured')}</p>
        <Button type="button" size="sm" variant="outline" onClick={onManual}>
          {t('tabs.manual')}
        </Button>
      </div>
    );
  }

  const renderFood = (food: UsdaFood) => {
    const isSelected = selected?.fdcId === food.fdcId;
    return (
      <li key={food.fdcId} className="flex flex-col">
        <button
          type="button"
          aria-pressed={isSelected}
          onClick={() => setSelected(isSelected ? null : food)}
          className={cn(
            'w-full cursor-pointer rounded-md border border-border px-3 py-2 text-left text-sm hover:bg-surface-2',
            isSelected && 'border-accent-500 bg-accent-500/5',
          )}
        >
          <span className="font-medium">{food.description}</span>
          <span className="block text-xs text-muted-foreground">
            {[t('current.source.usda'), food.dataType, food.brandOwner].filter(Boolean).join(' · ')}
          </span>
          <span className="block text-xs tabular-nums text-muted-foreground">
            {[
              food.nutrientsPer100g.caloriesKcal !== null
                ? `${round(food.nutrientsPer100g.caloriesKcal)} kcal`
                : null,
              food.nutrientsPer100g.totalFatG !== null
                ? `${round(food.nutrientsPer100g.totalFatG)} g fat`
                : null,
              food.nutrientsPer100g.proteinG !== null
                ? `${round(food.nutrientsPer100g.proteinG)} g protein`
                : null,
            ]
              .filter(Boolean)
              .join(' · ')}{' '}
            / 100 g
          </span>
        </button>
        {isSelected ? (
          <MatchReview
            values={food.nutrientsPer100g}
            basisLabel={t('match.per100g')}
            profile={profile}
            saving={saving}
            partial={false}
            onUse={() => void applyMatch(food)}
          />
        ) : null}
      </li>
    );
  };

  return (
    <div className="flex flex-col gap-3">
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
          placeholder={t('search.placeholder')}
          aria-label={t('search.label')}
        />
        <Button type="button" onClick={search} disabled={searching || query.trim().length < 2}>
          {searching ? t('search.searching') : t('search.submit')}
        </Button>
      </div>
      <div className="flex gap-1">
        {(['common', 'branded'] as const).map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={scope === s}
            onClick={() => setScope(s)}
            className={cn(
              'cursor-pointer rounded-full border border-border px-2.5 py-0.5 text-xs text-muted-foreground hover:text-foreground',
              scope === s && 'border-foreground/40 bg-surface-2 text-foreground',
            )}
          >
            {s === 'common' ? t('search.everyday') : t('search.brands')}
          </button>
        ))}
      </div>

      <SaveErrorBanner />

      {error ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      ) : null}

      {showSuggestion && !suggested ? (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-xs">
          <span className="text-muted-foreground">{t('search.suggested')}</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={loadingSuggested}
            onClick={loadSuggested}
          >
            {loadingSuggested ? t('search.loadingSuggested') : t('search.showSuggested')}
          </Button>
        </div>
      ) : null}
      {suggested ? (
        <div className="flex flex-col gap-1">
          <p className="text-xs text-muted-foreground">{t('search.suggested')}</p>
          <ul>{renderFood(suggested)}</ul>
        </div>
      ) : null}

      {results !== null ? (
        results.length > 0 ? (
          <>
            <p className="text-xs text-muted-foreground">{t('search.hint')}</p>
            <ul className="flex flex-col gap-1">{results.map(renderFood)}</ul>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{t('search.noResults')}</p>
        )
      ) : null}
      <p className="text-[11px] text-muted-foreground">{t('search.attribution')}</p>
    </div>
  );
}

/** Review card for a selected match — the only place it can be saved. */
function MatchReview({
  values,
  basisLabel,
  profile,
  saving,
  partial,
  onUse,
  blocked,
  children,
}: {
  values: Record<NutrientKey, number | null>;
  basisLabel: string;
  profile: IngredientNutritionView | null;
  saving: boolean;
  partial: boolean;
  onUse: () => void;
  /** A message that blocks saving (e.g. 100 ml without an equivalency). */
  blocked?: string | null;
  children?: React.ReactNode;
}) {
  const t = useTranslations('ingredients.nutrition');
  const tNutrient = useTranslations('recipes.workspace.nutrition.nutrients');
  const missing = KEY_NUTRIENTS.filter((k) => values[k] === null);
  return (
    <div className="mt-1 flex flex-col gap-2 rounded-lg border border-border bg-surface-2/50 p-3">
      {children}
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {basisLabel}
      </p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs">
        {KEY_NUTRIENTS.filter((k) => values[k] !== null).map((key) => (
          <div key={key} className="flex justify-between gap-2 border-b border-border/50 py-0.5">
            <dt className="text-muted-foreground">{tNutrient(key)}</dt>
            <dd className="tabular-nums">
              {round(values[key] as number)} {NUTRIENT_UNIT[key]}
            </dd>
          </div>
        ))}
      </dl>
      {missing.length > 0 ? (
        <p
          className={cn(
            'text-[11px]',
            missing.some((k) => CORE_SET.has(k))
              ? 'text-amber-700 dark:text-amber-300'
              : 'text-muted-foreground',
          )}
        >
          {t('match.notProvided', {
            list: missing.map((k) => tNutrient(k)).join(', '),
          })}
        </p>
      ) : null}
      {blocked ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] dark:border-amber-800 dark:bg-amber-950/40">
          {blocked}
        </p>
      ) : (
        <div className="flex flex-col items-end gap-1">
          {profile ? (
            <p className="text-[11px] text-muted-foreground">
              {t('match.replaceHint', {
                source: t(`current.source.${profile.source}`),
              })}
            </p>
          ) : null}
          <Button type="button" size="sm" disabled={saving} onClick={onUse}>
            {saving
              ? t('match.saving')
              : profile
                ? t('match.replace')
                : partial
                  ? t('match.usePartial')
                  : t('match.use')}
          </Button>
        </div>
      )}
    </div>
  );
}

// ───────────────────────── barcode (Open Food Facts) ─────────────────────────

function BarcodePane({
  ingredientId,
  profile,
  beforeSave,
  onSaved,
  setIndicator,
}: {
  ingredientId: string;
  profile: IngredientNutritionView | null;
  beforeSave: () => Promise<boolean>;
  onSaved: (view: IngredientNutritionView) => void;
  setIndicator: (i: SaveIndicator) => void;
}) {
  const t = useTranslations('ingredients.nutrition.barcode');
  const actionError = useActionError();
  const [barcode, setBarcode] = React.useState('');
  const [preview, setPreview] = React.useState<ExternalFoodPreview | null>(null);
  const [looking, setLooking] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [disabled, setDisabled] = React.useState(false);

  const lookup = async () => {
    setLooking(true);
    setError(null);
    setPreview(null);
    const result = await lookupExternalFoodByBarcodeAction({
      ingredientId,
      barcode,
    });
    setLooking(false);
    if (result.ok) setPreview(result.data.preview);
    else if (result.code === 'OPEN_FOOD_FACTS_DISABLED') setDisabled(true);
    else setError(actionError(result.code));
  };

  const applyMatch = async (product: ExternalFoodPreview) => {
    setSaving(true);
    setError(null);
    if (!(await beforeSave())) {
      setSaving(false);
      return;
    }
    setIndicator({ kind: 'saving' });
    const result = await saveIngredientNutritionAction({
      source: 'open_food_facts',
      ingredientId,
      barcode: product.barcode ?? barcode,
      // Selecting a partial product and pressing the button IS the confirmation.
      confirmPartial: product.qualityStatus === 'partial',
    });
    setSaving(false);
    if (result.ok) {
      onSaved(result.data.view);
      setIndicator({ kind: 'saved' });
      setPreview(null);
      setBarcode('');
    } else {
      setIndicator({
        kind: 'error',
        message: actionError(result.code),
        retry: () => void applyMatch(product),
      });
    }
  };

  if (disabled) return <p className="text-sm text-muted-foreground">{t('disabled')}</p>;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">{t('hint')}</p>
      <div className="flex gap-2">
        <Input
          value={barcode}
          inputMode="numeric"
          onChange={(e) => setBarcode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void lookup();
            }
          }}
          placeholder={t('placeholder')}
          aria-label={t('label')}
        />
        <Button type="button" onClick={lookup} disabled={looking || !barcode.trim()}>
          {looking ? t('searching') : t('submit')}
        </Button>
      </div>

      <SaveErrorBanner />

      {error ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      ) : null}

      {preview ? (
        <MatchReview
          values={preview.nutrients}
          basisLabel={preview.basisUnit === 'ml' ? t('preview.basisMl') : t('preview.basisG')}
          profile={profile}
          saving={saving}
          partial={preview.qualityStatus === 'partial'}
          blocked={preview.requiresEquivalency ? t('preview.equivalencyRequired') : null}
          onUse={() => void applyMatch(preview)}
        >
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Open Food Facts
            </p>
            <p className="text-sm font-semibold">{preview.description}</p>
            <p className="text-xs text-muted-foreground">
              {[preview.brandOwner, preview.packageQuantity].filter(Boolean).join(' · ')}
            </p>
          </div>
          {preview.stale ? (
            <p className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] dark:border-amber-800 dark:bg-amber-950/40">
              {t('preview.stale')}
            </p>
          ) : null}
          <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs">
            <dt className="text-muted-foreground">{t('preview.barcode')}</dt>
            <dd className="tabular-nums">{preview.barcode}</dd>
            {preview.sourceCountry ? (
              <>
                <dt className="text-muted-foreground">{t('preview.countries')}</dt>
                <dd className="capitalize">{preview.sourceCountry}</dd>
              </>
            ) : null}
            {preview.sourceLanguage ? (
              <>
                <dt className="text-muted-foreground">{t('preview.language')}</dt>
                <dd className="uppercase">{preview.sourceLanguage}</dd>
              </>
            ) : null}
          </dl>
          {preview.sourceUpdatedAt ? (
            <p className="text-[11px] text-muted-foreground">
              {t('preview.updated', {
                date: formatDate(preview.sourceUpdatedAt) ?? '',
              })}
            </p>
          ) : null}
          {preview.qualityWarnings.length > 0 ? (
            <ul className="list-disc pl-4 text-[11px] text-amber-700 dark:text-amber-300">
              {preview.qualityWarnings.map((code) => (
                <li key={code}>{t(`warning.${code}`)}</li>
              ))}
            </ul>
          ) : null}
          <p className="text-[11px] text-muted-foreground">
            {t('attribution')} ·{' '}
            <a
              href={`https://world.openfoodfacts.org/product/${preview.barcode ?? ''}`}
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              {t('viewOnOff')}
            </a>{' '}
            ·{' '}
            <a href={OFF_LICENSE_URL} target="_blank" rel="noreferrer" className="underline">
              {t('license')}
            </a>
          </p>
        </MatchReview>
      ) : null}
    </div>
  );
}

// ─────────────────────────────── manual entry ────────────────────────────────

function ManualPane({
  ingredientId,
  profile,
  autosave,
  onConverted,
  setIndicator,
}: {
  ingredientId: string;
  profile: IngredientNutritionView | null;
  autosave: ManualAutosave;
  onConverted: (view: IngredientNutritionView) => void;
  setIndicator: (i: SaveIndicator) => void;
}) {
  const t = useTranslations('ingredients.nutrition');
  const tNutrient = useTranslations('recipes.workspace.nutrition.nutrients');
  const actionError = useActionError();
  const [converting, setConverting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  if (profile && profile.source !== 'custom') {
    const convert = async () => {
      setConverting(true);
      setError(null);
      setIndicator({ kind: 'saving' });
      const result = await updateIngredientNutritionValuesAction({
        ingredientId,
        values: {},
        convertExternal: true,
      });
      setConverting(false);
      if (result.ok && result.data.view) {
        onConverted(result.data.view);
        setIndicator({ kind: 'saved' });
      } else {
        setIndicator({ kind: 'idle' });
        setError(actionError(result.ok ? 'UNEXPECTED' : result.code));
      }
    };
    return (
      <div className="flex flex-col items-start gap-2 rounded-lg border border-border p-3 text-sm">
        <p className="font-medium">
          {t('manual.externalTitle', {
            source: t(`current.source.${profile.source}`),
          })}
        </p>
        <p className="text-xs text-muted-foreground">{t('manual.externalBody')}</p>
        {error ? (
          <p role="alert" className="text-xs text-red-700 dark:text-red-300">
            {error}
          </p>
        ) : null}
        <Button type="button" size="sm" variant="outline" disabled={converting} onClick={convert}>
          {converting ? t('manual.converting') : t('manual.convert')}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">{t('current.per100g')}</p>
        <p className="text-xs text-muted-foreground">{t('manual.hint')}</p>
        <p className="text-xs text-muted-foreground">{t('manual.liquidHint')}</p>
      </div>

      <SaveErrorBanner />
      {autosave.hasInvalid ? (
        <p className="text-xs text-red-700 dark:text-red-300">{t('save.invalid')}</p>
      ) : null}

      <div className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
        {NUTRIENT_KEYS.map((key) => {
          const text = autosave.texts[key];
          const parsed = parseNutrientInput(key, text);
          const saved = autosave.savedValue(key);
          const invalid = parsed.kind === 'invalid';
          const emptyOverSaved = parsed.kind === 'empty' && saved !== null;
          const inputId = `nutrient-${ingredientId}-${key}`;
          const hintId = `${inputId}-hint`;
          return (
            <div key={key} className="flex flex-col gap-1 text-xs">
              <label htmlFor={inputId} className="flex items-center gap-1">
                <span>
                  {tNutrient(key)} ({NUTRIENT_UNIT[key]})
                </span>
                {CORE_SET.has(key) ? (
                  <span className="text-muted-foreground" title={t('manual.core')}>
                    *
                  </span>
                ) : null}
              </label>
              <div className="flex items-center gap-1">
                <Input
                  id={inputId}
                  value={text}
                  inputMode="decimal"
                  placeholder={t('manual.unknown')}
                  aria-invalid={invalid || undefined}
                  aria-describedby={invalid || emptyOverSaved ? hintId : undefined}
                  onChange={(e) => autosave.setText(key, e.target.value)}
                  onBlur={() => autosave.blur(key)}
                  className={cn(
                    'h-8 tabular-nums',
                    invalid && 'border-red-500 focus-visible:ring-red-500',
                  )}
                />
                {saved !== null ? (
                  <button
                    type="button"
                    aria-label={t('manual.clear', { nutrient: tNutrient(key) })}
                    title={t('manual.clear', { nutrient: tNutrient(key) })}
                    onClick={() => autosave.clear(key)}
                    className="cursor-pointer rounded-md p-1 text-muted-foreground hover:bg-surface-2 hover:text-foreground"
                  >
                    <X className="size-3.5" />
                  </button>
                ) : (
                  <span className="w-[22px]" aria-hidden />
                )}
              </div>
              {invalid ? (
                <span id={hintId} className="text-[11px] text-red-700 dark:text-red-300">
                  {t('manual.invalid', { max: NUTRIENT_MAX[key] })}
                </span>
              ) : emptyOverSaved ? (
                <span id={hintId} className="text-[11px] text-muted-foreground">
                  {t('manual.emptyNotSaved')}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
      <p className="text-[11px] text-muted-foreground">* {t('manual.core')}</p>
    </div>
  );
}
