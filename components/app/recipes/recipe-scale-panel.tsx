'use client';

import * as React from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Printer, Download, FileText, RotateCcw } from 'lucide-react';
import {
  type Dimension,
  type MeasurementSystem,
  type Unit,
  displayUnitsFor,
  formatQuantity,
  fromCanonical,
  pickDisplayUnit,
  toCanonical,
  unitLabel,
} from '@/lib/units';
import {
  deriveScale,
  scaleMoneyCents,
  sumPresetBasketGrams,
  type RecipeScaleResult,
} from '@/lib/calculations/recipeScale';
import { RECIPE_SCALE_PORTIONS_MAX } from '@/lib/validation/recipe-scale';
import { formatMoney } from '@/lib/format/money';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

/** One recipe line the panel can scale / anchor on (operational fields only). */
export type ScalePanelLine = {
  id: string;
  ingredientId: string;
  name: string;
  dimension: Dimension;
  /** Canonical amount (g / ml / count). */
  quantity: number;
};

/** A kitchen preset the panel can scale to (operational fields only, no cost). */
export type ScalePreset = {
  id: string;
  name: string;
  /** Canonical target finished weight (grams). */
  targetWeightGrams: number;
};

type Mode = 'portions' | 'anchor' | 'weight';

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function unitOptionLabel(unit: Unit): string {
  return unitLabel(unit) === '' ? 'pcs' : unitLabel(unit);
}

/**
 * Recipe scaling panel (Recipe scaling MVP). A client-only, DERIVE-ON-READ view: it
 * resizes the recipe live and writes NOTHING. Operational-first — it shows scaled
 * quantities to both roles; the scaled batch-cost preview renders only for managers
 * (`canSeeCosts` + a live total), because kitchen never receives money.
 *
 * Both scale modes funnel through one `?portions=` export param: target-portions
 * passes the target directly; anchor mode passes the equivalent (possibly fractional)
 * portions, so the exact factor survives the URL. Print/download are disabled while
 * the editor has unsaved/pending edits — the export routes read the SAVED recipe, so
 * the panel must never show one result and export a different one.
 */
export function RecipeScalePanel({
  recipeId,
  yieldPortions,
  lines,
  measurementSystem,
  currency,
  canSeeCosts,
  batchTotalCents,
  exportDisabled,
  presets,
  yieldWeightGrams,
}: {
  recipeId: string;
  yieldPortions: number;
  lines: ScalePanelLine[];
  measurementSystem: MeasurementSystem;
  currency: string;
  canSeeCosts: boolean;
  /** Live batch total (cents) for the manager preview, or null. */
  batchTotalCents: number | null;
  /** True while header/line edits are dirty or a save is pending. */
  exportDisabled: boolean;
  /** Kitchen presets to scale to (target finished weights). */
  presets: ScalePreset[];
  /** Live batch yield weight in canonical grams; null = not set (no weight scaling). */
  yieldWeightGrams: number | null;
}) {
  const t = useTranslations('recipes.scale');

  const [mode, setMode] = React.useState<Mode>('portions');
  const [targetText, setTargetText] = React.useState(String(yieldPortions));
  const [anchorLineId, setAnchorLineId] = React.useState(lines[0]?.id ?? '');
  const [anchorUnit, setAnchorUnit] = React.useState<Unit>('g');
  const [anchorText, setAnchorText] = React.useState('');
  // Weight mode (target finished weight): entered in the org's weight units.
  const weightUnits = React.useMemo(
    () => displayUnitsFor('weight', measurementSystem),
    [measurementSystem],
  );
  const [weightUnit, setWeightUnit] = React.useState<Unit>(
    () => weightUnits[0] ?? 'g',
  );
  const [weightText, setWeightText] = React.useState('');
  // Preset basket: how many of each preset to make, keyed by preset id (text while
  // typing). A blank/0/invalid entry contributes nothing — an unfilled row is ignored.
  const [presetQty, setPresetQty] = React.useState<Record<string, string>>({});
  // A recipe with no batch yield weight has nothing to scale a target weight from.
  const canScaleByWeight = yieldWeightGrams != null && yieldWeightGrams > 0;

  const lineQuantities = React.useMemo(() => lines.map((l) => l.quantity), [lines]);
  const anchorLine = lines.find((l) => l.id === anchorLineId);

  // If the batch yield weight is cleared while weight mode is active, fall back to
  // the always-available portions mode (the weight tab is disabled in that state).
  React.useEffect(() => {
    if (!canScaleByWeight && mode === 'weight') setMode('portions');
  }, [canScaleByWeight, mode]);

  // Default the anchor amount/unit to the line's current value when it is selected.
  const selectAnchorLine = (id: string) => {
    setAnchorLineId(id);
    const line = lines.find((l) => l.id === id);
    if (line) {
      const unit = pickDisplayUnit(line.quantity, line.dimension, measurementSystem);
      setAnchorUnit(unit);
      setAnchorText(String(round4(fromCanonical(line.quantity, unit))));
    }
  };

  // Preset basket → one canonical target weight. The loose custom-weight field is
  // expressed in the org's weight unit; each preset row contributes weight × quantity.
  const customWeightGrams =
    weightText.trim() === '' ? 0 : toCanonical(Number(weightText), weightUnit);
  const targetTotalGrams = sumPresetBasketGrams(
    presets.map((p) => ({
      targetWeightGrams: p.targetWeightGrams,
      quantity: Number(presetQty[p.id] ?? ''),
    })),
    customWeightGrams,
  );

  // Derive the scale from the active mode. An empty input is "no result yet" (not an
  // error); a present-but-invalid input surfaces a localized error.
  let result: RecipeScaleResult | null = null;
  let hasInput = false;
  if (mode === 'portions') {
    hasInput = targetText.trim() !== '';
    if (hasInput) {
      result = deriveScale(
        yieldPortions,
        { kind: 'portions', targetPortions: Number(targetText) },
        lineQuantities,
      );
    }
  } else if (mode === 'anchor') {
    hasInput = anchorLine !== undefined && anchorText.trim() !== '';
    if (hasInput && anchorLine) {
      result = deriveScale(
        yieldPortions,
        {
          kind: 'anchor',
          anchorLineQuantity: anchorLine.quantity,
          targetCanonical: toCanonical(Number(anchorText), anchorUnit),
        },
        lineQuantities,
      );
    }
  } else {
    // weight: factor = targetWeightGrams / yield_weight_grams. The target is the preset
    // basket (Σ preset weight × quantity) plus the loose custom weight, all in canonical
    // grams. A missing base weight surfaces invalid_yield via deriveScale; a zero/empty
    // total is "no result yet".
    hasInput = targetTotalGrams > 0;
    if (hasInput) {
      result = deriveScale(
        yieldPortions,
        {
          kind: 'yieldWeight',
          baseWeightGrams: yieldWeightGrams ?? 0,
          targetWeightGrams: targetTotalGrams,
        },
        lineQuantities,
      );
    }
  }

  const ok = result?.ok ? result : null;
  const scaledPortions = ok ? round4(ok.scaledPortions) : null;
  const factor = ok ? round4(ok.factor) : null;

  // Export portions param: within validation bounds, else exports stay disabled.
  const portionsParam =
    scaledPortions != null && scaledPortions > 0 && scaledPortions <= RECIPE_SCALE_PORTIONS_MAX
      ? scaledPortions
      : null;
  const canExport = !exportDisabled && portionsParam != null;
  const query = portionsParam != null ? `?portions=${portionsParam}` : '';

  const scaledTotalCents =
    canSeeCosts && batchTotalCents != null && ok
      ? scaleMoneyCents(batchTotalCents, ok.factor)
      : null;

  const reset = () => {
    setMode('portions');
    setTargetText(String(yieldPortions));
    setWeightText('');
    setPresetQty({});
  };

  // Clicking a preset switches to weight mode and fills the target with the preset's
  // weight (expressed in the friendliest weight unit). Derivation then flows exactly
  // like a typed target weight, so the result list + export use the same path.
  const scaleToPreset = (preset: ScalePreset) => {
    const unit = pickDisplayUnit(preset.targetWeightGrams, 'weight', measurementSystem);
    setMode('weight');
    setWeightUnit(unit);
    setWeightText(String(round4(fromCanonical(preset.targetWeightGrams, unit))));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">{t('description')}</p>

        {/* Mode switch */}
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-foreground">{t('mode')}</span>
          <div className="inline-flex w-fit rounded-lg border border-border p-0.5">
            <button
              type="button"
              onClick={() => setMode('portions')}
              className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                mode === 'portions'
                  ? 'bg-surface-2 font-medium text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {t('modePortions')}
            </button>
            <button
              type="button"
              onClick={() => setMode('anchor')}
              disabled={lines.length === 0}
              className={`rounded-md px-3 py-1.5 text-sm transition-colors disabled:opacity-50 ${
                mode === 'anchor'
                  ? 'bg-surface-2 font-medium text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {t('modeAnchor')}
            </button>
            <button
              type="button"
              onClick={() => setMode('weight')}
              disabled={!canScaleByWeight}
              className={`rounded-md px-3 py-1.5 text-sm transition-colors disabled:opacity-50 ${
                mode === 'weight'
                  ? 'bg-surface-2 font-medium text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {t('modeWeight')}
            </button>
          </div>
          {!canScaleByWeight && (
            <p className="text-xs text-muted-foreground">{t('needsYieldWeight')}</p>
          )}
        </div>

        {/* Inputs */}
        {mode === 'portions' ? (
          <label className="flex max-w-xs flex-col gap-1.5">
            <span className="text-sm font-medium text-foreground">
              {t('targetPortions')}
            </span>
            <Input
              inputMode="decimal"
              value={targetText}
              onChange={(e) => setTargetText(e.target.value)}
            />
          </label>
        ) : mode === 'weight' ? (
          <div className="flex flex-col gap-4">
            {/* Preset basket: enter how many of each size to make. */}
            {presets.length > 0 && (
              <div className="flex flex-col gap-2">
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium text-foreground">
                    {t('presetBasketLabel')}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {t('presetBasketHint')}
                  </span>
                </div>
                <ul className="flex flex-col gap-2">
                  {presets.map((p) => (
                    <li
                      key={p.id}
                      className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2"
                    >
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                        {p.name}
                      </span>
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {t('eachWeight', {
                          weight: formatQuantity(
                            p.targetWeightGrams,
                            'weight',
                            measurementSystem,
                          ),
                        })}
                      </span>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => scaleToPreset(p)}
                      >
                        {t('scaleToPreset', { name: p.name })}
                      </Button>
                      <Input
                        aria-label={t('presetQuantity')}
                        inputMode="decimal"
                        className="w-20"
                        placeholder="0"
                        value={presetQty[p.id] ?? ''}
                        onChange={(e) =>
                          setPresetQty((prev) => ({ ...prev, [p.id]: e.target.value }))
                        }
                      />
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Loose custom weight, added on top of the basket. */}
            <div className="flex items-end gap-1.5">
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-foreground">
                  {t('customWeight')}
                </span>
                <Input
                  inputMode="decimal"
                  className="w-28"
                  placeholder="0"
                  value={weightText}
                  onChange={(e) => setWeightText(e.target.value)}
                />
              </label>
              <Select
                aria-label={t('targetWeightUnit')}
                className="w-24"
                value={weightUnit}
                disabled={weightUnits.length <= 1}
                onChange={(e) => setWeightUnit(e.target.value as Unit)}
              >
                {weightUnits.map((u) => (
                  <option key={u} value={u}>
                    {unitOptionLabel(u)}
                  </option>
                ))}
              </Select>
            </div>

            {/* Combined target weight readout (basket + custom). */}
            {targetTotalGrams > 0 && (
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="text-muted-foreground">{t('targetTotalWeight')}</span>
                <span className="font-medium tabular-nums text-foreground">
                  {formatQuantity(targetTotalGrams, 'weight', measurementSystem)}
                </span>
              </div>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-foreground">
                {t('anchorIngredient')}
              </span>
              <Select
                value={anchorLineId}
                onChange={(e) => selectAnchorLine(e.target.value)}
              >
                {lines.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-foreground">
                {t('anchorAmount')}
              </span>
              <Input
                inputMode="decimal"
                className="w-28"
                value={anchorText}
                onChange={(e) => setAnchorText(e.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-foreground">
                {t('anchorUnit')}
              </span>
              <Select
                className="w-24"
                value={anchorUnit}
                disabled={!anchorLine}
                onChange={(e) => setAnchorUnit(e.target.value as Unit)}
              >
                {(anchorLine
                  ? displayUnitsFor(anchorLine.dimension, measurementSystem)
                  : []
                ).map((u) => (
                  <option key={u} value={u}>
                    {unitOptionLabel(u)}
                  </option>
                ))}
              </Select>
            </label>
          </div>
        )}

        {/* Error */}
        {hasInput && result && !result.ok && (
          <p role="alert" className="text-sm text-destructive">
            {t(`errors.${result.reason}`)}
          </p>
        )}

        {/* Result */}
        {ok && scaledPortions != null && factor != null && (
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-2/40 p-4">
            <p className="font-display text-base font-semibold text-foreground">
              {t('result', {
                from: yieldPortions,
                to: scaledPortions,
                factor,
              })}
            </p>

            <ul className="flex flex-col gap-1 text-sm">
              {lines.map((l) => (
                <li key={l.id} className="flex items-center justify-between gap-3">
                  <span className="text-foreground">{l.name}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {formatQuantity(
                      l.quantity * ok.factor,
                      l.dimension,
                      measurementSystem,
                    )}
                  </span>
                </li>
              ))}
            </ul>

            {scaledTotalCents != null && (
              <div className="flex items-center justify-between border-t border-border pt-2 text-sm">
                <span className="text-muted-foreground">{t('scaledTotal')}</span>
                <span className="font-medium tabular-nums text-foreground">
                  {formatMoney(scaledTotalCents, currency)}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={reset}>
            <RotateCcw className="size-4" />
            {t('reset')}
          </Button>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <ExportButton
              href={`/recipes/${recipeId}/prep-card/print${query}`}
              disabled={!canExport}
              icon={<Printer className="size-4" />}
              label={t('printPrep')}
            />
            <ExportButton
              href={`/api/recipes/${recipeId}/prep-card/pdf${query}`}
              disabled={!canExport}
              icon={<Download className="size-4" />}
              label={t('downloadPrep')}
            />
            {canSeeCosts && (
              <ExportButton
                href={`/recipes/${recipeId}/card/print${query}`}
                disabled={!canExport}
                icon={<FileText className="size-4" />}
                label={t('openCostSheet')}
              />
            )}
          </div>
        </div>

        {exportDisabled && (
          <p className="text-xs text-muted-foreground">{t('saveFirst')}</p>
        )}
      </CardContent>
    </Card>
  );
}

/** An export action: a real link when enabled, an inert disabled button otherwise. */
function ExportButton({
  href,
  disabled,
  icon,
  label,
}: {
  href: string;
  disabled: boolean;
  icon: React.ReactNode;
  label: string;
}) {
  if (disabled) {
    return (
      <Button type="button" variant="outline" size="sm" disabled>
        {icon}
        {label}
      </Button>
    );
  }
  return (
    <Button asChild variant="outline" size="sm">
      <Link href={href}>
        {icon}
        {label}
      </Link>
    </Button>
  );
}
