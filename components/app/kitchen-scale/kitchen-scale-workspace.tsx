'use client';

import * as React from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Download,
  Printer,
  RotateCcw,
} from 'lucide-react';
import {
  type MeasurementSystem,
  type Unit,
  displayUnitsFor,
  fromCanonical,
  pickDisplayUnit,
  toCanonical,
  unitLabel,
} from '@/lib/units';
import { parseDecimalInput } from '@/lib/calculations/recipeScale';
import {
  combinedPresetTargetGrams,
  prepCardQueryFor,
  scaleForBasis,
  scaledLines,
  type CalculationBasis,
  type PresetSelection,
  type WorkbenchLine,
  type WorkbenchPreset,
  type WorkbenchRecipe,
} from '@/lib/kitchen-scale/scale-workbench-model';
import type { KitchenScaleMethodSection } from '@/lib/kitchen-scale/prep-document';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { readKitchenScaleListReturn } from './kitchen-scale-list-return';

const CANONICAL_UNIT: Record<WorkbenchLine['dimension'], string> = {
  weight: 'g',
  volume: 'ml',
  count: '',
};

/** Practical weighing precision, thousands-separated — the EXACT same number
 *  formatting the print/PDF uses (`formatDocumentQuantity`), so screen, print
 *  and download always show the identical figure. */
function formatNumber(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return rounded.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/** Value + canonical unit split into two parts, for a big-value/small-unit layout. */
function formatQuantityParts(
  value: number,
  dimension: WorkbenchLine['dimension'],
): { value: string; unit: string } {
  return { value: formatNumber(value), unit: CANONICAL_UNIT[dimension] };
}

/** Canonical units, e.g. "2,105 g" — for single-string captions. */
function formatCanonical(value: number, dimension: WorkbenchLine['dimension']): string {
  const { value: v, unit } = formatQuantityParts(value, dimension);
  return unit ? `${v} ${unit}` : v;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * Kitchen Scale calculator (Kitchen Scale redesign) — a full-width, DERIVE-ON-READ
 * view over the SAVED recipe. It writes nothing and carries no money for either
 * role. Three interchangeable calculation methods (target weight, ingredient
 * amount, combined kitchen presets) share ONE `CalculationBasis`, so applying
 * one always clears the others. Print/Download reuse the operational prep-card
 * routes with the SAME `?factor=...` the calculator derived.
 */
export function KitchenScaleWorkspace({
  recipeId,
  recipeName,
  recipe,
  lines,
  presets,
  method,
  legacyNotes,
  measurementSystem,
}: {
  recipeId: string;
  recipeName: string;
  recipe: WorkbenchRecipe;
  lines: WorkbenchLine[];
  presets: WorkbenchPreset[];
  method: KitchenScaleMethodSection[];
  legacyNotes: string | null;
  measurementSystem: MeasurementSystem;
}) {
  const t = useTranslations('kitchenScale.workspace');

  const [returnHref, setReturnHref] = React.useState('/kitchen-scale');
  React.useEffect(() => {
    const saved = readKitchenScaleListReturn();
    if (saved) setReturnHref(saved.href);
  }, []);

  const weightUnits = React.useMemo(
    () => displayUnitsFor('weight', measurementSystem),
    [measurementSystem],
  );
  const canScaleByWeight = recipe.yieldWeightGrams != null && recipe.yieldWeightGrams > 0;

  // ── The single active calculation basis ──────────────────────────────────
  const [basis, setBasis] = React.useState<CalculationBasis>({ kind: 'original' });
  const [error, setError] = React.useState<string | null>(null);

  // Method A — target weight (always visible in the compact calc strip).
  const [weightText, setWeightText] = React.useState('');
  const [weightUnit, setWeightUnit] = React.useState<Unit>(
    () => pickDisplayUnit(recipe.yieldWeightGrams ?? 0, 'weight', measurementSystem),
  );
  const [weightTouched, setWeightTouched] = React.useState(false);

  // Method B — ingredient amount (inline row editor).
  const [anchor, setAnchor] = React.useState<{ lineId: string; text: string; unit: Unit } | null>(null);
  // A ref (not state) so `onBlur` — fired synchronously as the input unmounts
  // after Escape — can reliably see "we just cancelled" even if its closure
  // still holds the pre-cancel `anchor` value.
  const skipNextAnchorBlur = React.useRef(false);

  // Method C — combined kitchen presets (expandable panel).
  const [presetsOpen, setPresetsOpen] = React.useState(false);
  const [presetQty, setPresetQty] = React.useState<Record<string, string>>({});
  const [presetsTouched, setPresetsTouched] = React.useState(false);

  const [methodExpanded, setMethodExpanded] = React.useState(false);
  const [pendingHref, setPendingHref] = React.useState<string | null>(null);

  const hasUnappliedEdit = weightTouched || anchor !== null || presetsTouched;

  const result = scaleForBasis(recipe, lines, basis);
  const factor = result.ok ? result.factor : 1;

  // ── Method A: target weight ───────────────────────────────────────────────
  const applyWeight = () => {
    const value = parseDecimalInput(weightText);
    if (!Number.isFinite(value) || value <= 0) {
      setError('invalid_target');
      return;
    }
    const targetGrams = toCanonical(value, weightUnit);
    const next: CalculationBasis = { kind: 'weight', targetGrams };
    const attempt = scaleForBasis(recipe, lines, next);
    setBasis(next);
    setError(attempt.ok ? null : attempt.reason);
    setWeightTouched(false);
    setAnchor(null);
    setPresetsOpen(false);
    setPresetsTouched(false);
  };

  // ── Method B: ingredient amount ───────────────────────────────────────────
  const startAnchor = (line: WorkbenchLine) => {
    if (anchor?.lineId === line.id) return;
    const scaled = line.quantity * factor;
    const unit = pickDisplayUnit(scaled, line.dimension, measurementSystem);
    setAnchor({ lineId: line.id, text: String(round4(fromCanonical(scaled, unit))), unit });
    setError(null);
  };
  const applyAnchor = () => {
    if (skipNextAnchorBlur.current) {
      skipNextAnchorBlur.current = false;
      return;
    }
    if (!anchor) return;
    const value = parseDecimalInput(anchor.text);
    if (!Number.isFinite(value) || value <= 0) {
      setError('invalid_anchor');
      return;
    }
    const line = lines.find((l) => l.id === anchor.lineId);
    const targetCanonical = toCanonical(value, anchor.unit);
    const next: CalculationBasis = {
      kind: 'line',
      lineId: anchor.lineId,
      lineName: line?.name ?? '',
      targetCanonical,
    };
    const attempt = scaleForBasis(recipe, lines, next);
    setBasis(next);
    setError(attempt.ok ? null : attempt.reason);
    setAnchor(null);
    setWeightText('');
    setWeightTouched(false);
    setPresetsOpen(false);
    setPresetsTouched(false);
  };
  const cancelAnchor = () => {
    skipNextAnchorBlur.current = true;
    setAnchor(null);
    setError(null);
  };

  // ── Method C: combined kitchen presets ────────────────────────────────────
  const presetSelections: PresetSelection[] = presets
    .map((p) => ({ presetId: p.id, name: p.name, quantity: parseDecimalInput(presetQty[p.id] ?? '') }))
    .filter((s) => Number.isFinite(s.quantity) && s.quantity > 0);
  const presetTotalGrams = combinedPresetTargetGrams(
    presets.map((p) => ({ targetWeightGrams: p.targetWeightGrams, quantity: parseDecimalInput(presetQty[p.id] ?? '') })),
  );
  const appliedPresetSummary = basis.kind === 'preset' ? basis : null;

  const setPresetQtyField = (id: string, value: string) => {
    setPresetQty((prev) => ({ ...prev, [id]: value }));
    setPresetsTouched(true);
  };
  const applyPresets = () => {
    if (presetTotalGrams <= 0) {
      setError('invalid_target');
      return;
    }
    const next: CalculationBasis = {
      kind: 'preset',
      selections: presetSelections,
      extraGrams: 0,
      totalGrams: presetTotalGrams,
    };
    const attempt = scaleForBasis(recipe, lines, next);
    setBasis(next);
    setError(attempt.ok ? null : attempt.reason);
    setPresetsOpen(false);
    setPresetsTouched(false);
    setWeightText('');
    setWeightTouched(false);
    setAnchor(null);
  };

  // ── Reset ─────────────────────────────────────────────────────────────────
  const reset = () => {
    setBasis({ kind: 'original' });
    setError(null);
    setWeightText('');
    setWeightTouched(false);
    setAnchor(null);
    setPresetsOpen(false);
    setPresetQty({});
    setPresetsTouched(false);
  };

  // ── Print / download ───────────────────────────────────────────────────────
  const query = prepCardQueryFor(basis, result);
  const exportDisabled = query === null;

  const goExport = (href: string) => {
    if (hasUnappliedEdit) {
      setPendingHref(href);
      return;
    }
    window.location.href = href;
  };

  const printHref = `/recipes/${recipeId}/prep-card/print${query ?? ''}`;
  const downloadHref = `/api/recipes/${recipeId}/prep-card/pdf${query ?? ''}`;

  const displayedLines = scaledLines(lines, factor);
  const originalWeightText =
    recipe.yieldWeightGrams != null && recipe.yieldWeightGrams > 0
      ? t('originalWeight', { weight: formatCanonical(recipe.yieldWeightGrams, 'weight') })
      : t('originalPortionsOnly', { count: recipe.yieldPortions });

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <Link
            href={returnHref}
            className="mt-1 inline-flex size-9 shrink-0 items-center justify-center rounded-full border border-border bg-surface text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground"
            aria-label={t('backToRecipes')}
            title={t('backToRecipes')}
          >
            <ArrowLeft className="size-4" />
          </Link>
          <div className="min-w-0">
            <h1 className="font-display text-2xl font-semibold leading-tight text-foreground sm:text-3xl">
              {recipeName}
            </h1>
            <p className="text-sm text-muted-foreground">{originalWeightText}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={exportDisabled}
            onClick={() => goExport(printHref)}
          >
            <Printer className="size-4" />
            {t('print')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={exportDisabled}
            onClick={() => goExport(downloadHref)}
          >
            <Download className="size-4" />
            {t('download')}
          </Button>
        </div>
      </div>

      {/* Compact calculation strip */}
      <div className="flex flex-wrap items-end gap-2 rounded-xl border border-border bg-surface p-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">{t('targetWeight.label')}</span>
          <div className="flex items-center gap-1.5">
            <Input
              inputMode="decimal"
              className="h-11 w-28 text-base"
              placeholder="0"
              value={weightText}
              disabled={!canScaleByWeight}
              onChange={(e) => {
                setWeightText(e.target.value);
                setWeightTouched(true);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') applyWeight();
              }}
              onBlur={() => {
                if (weightText.trim() !== '') applyWeight();
              }}
            />
            <Select
              aria-label={t('targetWeight.unit')}
              className="h-11 w-20"
              value={weightUnit}
              disabled={!canScaleByWeight || weightUnits.length <= 1}
              onChange={(e) => setWeightUnit(e.target.value as Unit)}
            >
              {weightUnits.map((u) => (
                <option key={u} value={u}>
                  {unitLabel(u)}
                </option>
              ))}
            </Select>
          </div>
        </label>

        <Button
          type="button"
          variant={presetsOpen ? 'default' : 'outline'}
          size="sm"
          className="h-11"
          disabled={presets.length === 0}
          onClick={() => setPresetsOpen((v) => !v)}
        >
          {t('presets.toggle')}
        </Button>

        <Button type="button" variant="ghost" size="sm" className="h-11" onClick={reset}>
          <RotateCcw className="size-4" />
          {t('resetToOriginal')}
        </Button>

        {!canScaleByWeight && (
          <p className="w-full text-xs text-muted-foreground">{t('targetWeight.needsYieldWeight')}</p>
        )}
      </div>

      {/* Combined kitchen presets — expandable, not a permanent panel */}
      {presetsOpen ? (
        <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-3">
          <span className="text-sm font-medium text-foreground">{t('presets.panelTitle')}</span>
          {presets.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('presets.none')}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {presets.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{p.name}</span>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {t('presets.eachWeight', { weight: formatCanonical(p.targetWeightGrams, 'weight') })}
                  </span>
                  <Input
                    aria-label={t('presets.quantityLabel')}
                    inputMode="decimal"
                    className="h-10 w-20"
                    placeholder="0"
                    value={presetQty[p.id] ?? ''}
                    onChange={(e) => setPresetQtyField(p.id, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') applyPresets();
                    }}
                  />
                </li>
              ))}
            </ul>
          )}
          {presetTotalGrams > 0 && (
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">{t('presets.combinedTotal')}</span>
              <span className="font-semibold tabular-nums text-foreground">
                {formatCanonical(presetTotalGrams, 'weight')}
              </span>
            </div>
          )}
          <Button type="button" size="sm" disabled={presetTotalGrams <= 0} onClick={applyPresets}>
            {t('presets.apply')}
          </Button>
        </div>
      ) : appliedPresetSummary ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-accent-300/60 bg-accent-50 px-3 py-2 text-sm dark:bg-accent-500/10">
          <span className="text-accent-800 dark:text-accent-200">
            {t('presets.summaryPrefix')}{' '}
            {appliedPresetSummary.selections
              .map((s) => t('presets.itemText', { quantity: formatNumber(s.quantity), name: s.name }))
              .join(' + ')}
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={() => setPresetsOpen(true)}>
            {t('presets.adjust')}
          </Button>
        </div>
      ) : null}

      {/* Calculation-basis caption / error */}
      {error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/15 dark:text-red-300">
          {t(`errors.${error}`)}
        </p>
      )}
      {!error && basis.kind !== 'original' && (
        <p className="text-sm font-semibold text-accent-700 dark:text-accent-300">
          {basis.kind === 'weight'
            ? t('basis.weight', { amount: formatCanonical(basis.targetGrams, 'weight') })
            : basis.kind === 'line'
              ? t('basis.line', {
                  name: basis.lineName,
                  amount: formatCanonical(
                    basis.targetCanonical,
                    lines.find((l) => l.id === basis.lineId)?.dimension ?? 'weight',
                  ),
                })
              : t('basis.preset', {
                  summary: basis.selections
                    .map((s) => t('presets.itemText', { quantity: formatNumber(s.quantity), name: s.name }))
                    .join(' + '),
                  total: formatCanonical(basis.totalGrams, 'weight'),
                })}
        </p>
      )}

      {/* Ingredients — full width, saved order */}
      <div className="rounded-xl border border-border bg-surface">
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <span className="text-sm font-semibold text-foreground">{t('ingredientsTitle')}</span>
          <span className="text-xs text-muted-foreground">{t('ingredientAmount.hint')}</span>
        </div>
        {displayedLines.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">{t('noLines')}</p>
        ) : (
          <ul className="divide-y divide-border">
            {displayedLines.map((line, i) => {
              const original = lines[i]!;
              const isAnchor = anchor?.lineId === line.id;
              return (
                <li key={line.id} className="flex min-h-11 flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3">
                  <span className="min-w-0 flex-1 text-[24px] leading-tight text-foreground">
                    {line.name}
                    {original.isSubRecipe && (
                      <span className="ml-1.5 text-sm font-normal text-muted-foreground">
                        {t('subRecipe')}
                      </span>
                    )}
                  </span>
                  {isAnchor ? (
                    <span className="flex items-center gap-1.5">
                      <Input
                        aria-label={t('ingredientAmount.editTitle', { name: line.name })}
                        inputMode="decimal"
                        className="h-11 w-28 text-lg"
                        autoFocus
                        value={anchor.text}
                        onChange={(e) => setAnchor({ ...anchor, text: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') applyAnchor();
                          if (e.key === 'Escape') cancelAnchor();
                        }}
                        onBlur={applyAnchor}
                      />
                      <Select
                        aria-label={t('targetWeight.unit')}
                        className="h-11 w-20"
                        value={anchor.unit}
                        onChange={(e) => setAnchor({ ...anchor, unit: e.target.value as Unit })}
                      >
                        {displayUnitsFor(original.dimension, measurementSystem).map((u) => (
                          <option key={u} value={u}>
                            {unitLabel(u) || '×'}
                          </option>
                        ))}
                      </Select>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => startAnchor(original)}
                      className="min-h-11 shrink-0 rounded-lg px-3 py-1.5 text-right transition-colors hover:bg-surface-2"
                    >
                      <span className="text-[30px] font-semibold leading-none tabular-nums text-foreground">
                        {formatQuantityParts(line.quantity, line.dimension).value}
                      </span>{' '}
                      <span className="text-[15px] text-muted-foreground">
                        {formatQuantityParts(line.quantity, line.dimension).unit}
                      </span>
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Preparation method — expandable, below ingredients */}
      {(method.length > 0 || legacyNotes) && (
        <div className="rounded-xl border border-border bg-surface">
          <button
            type="button"
            onClick={() => setMethodExpanded((v) => !v)}
            aria-expanded={methodExpanded}
            className="flex min-h-11 w-full items-center justify-between px-4 py-3 text-left"
          >
            <span className="text-sm font-semibold text-foreground">{t('methodTitle')}</span>
            {methodExpanded ? (
              <ChevronUp className="size-4 text-muted-foreground" aria-hidden />
            ) : (
              <ChevronDown className="size-4 text-muted-foreground" aria-hidden />
            )}
          </button>
          {methodExpanded && (
            <div className="flex flex-col gap-4 border-t border-border px-4 py-4">
              {method.length > 0
                ? method.map((section, si) => (
                    <div key={si}>
                      {section.title && (
                        <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          {section.title}
                        </h3>
                      )}
                      <ol className="flex flex-col gap-2">
                        {section.steps.map((step, i) => (
                          <li key={i} className="flex gap-2 text-sm">
                            <span className="mt-0.5 size-6 shrink-0 rounded-full bg-surface-2 text-center text-xs font-medium leading-6">
                              {i + 1}
                            </span>
                            <span className="whitespace-pre-wrap">{step}</span>
                          </li>
                        ))}
                      </ol>
                    </div>
                  ))
                : (
                  <p className="whitespace-pre-wrap text-sm text-muted-foreground">{legacyNotes}</p>
                )}
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={pendingHref !== null}
        title={t('unresolvedEdit.title')}
        description={t('unresolvedEdit.body')}
        confirmLabel={t('unresolvedEdit.continueAnyway')}
        cancelLabel={t('unresolvedEdit.cancel')}
        onConfirm={() => {
          if (pendingHref) window.location.href = pendingHref;
          setPendingHref(null);
        }}
        onCancel={() => setPendingHref(null)}
      />
    </div>
  );
}
