'use client';

import * as React from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ArrowLeft, Download, Printer, RotateCcw } from 'lucide-react';
import {
  type MeasurementSystem,
  type Unit,
  displayUnitsFor,
  formatQuantity,
  fromCanonical,
  pickDisplayUnit,
  toCanonical,
  unitLabel,
} from '@/lib/units';
import type { RecipeScaleResult } from '@/lib/calculations/recipeScale';
import {
  basketTargetGrams,
  portionsParamFor,
  scaleFromAnchor,
  scaleFromBasket,
  type WorkbenchLine,
  type WorkbenchRecipe,
} from '@/lib/kitchen-scale/scale-workbench-model';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

/** A kitchen preset the workbench can scale to (operational, no cost). */
export type WorkbenchPreset = {
  id: string;
  name: string;
  /** Canonical target finished weight (grams). */
  targetWeightGrams: number;
};

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function unitOptionLabel(unit: Unit): string {
  return unitLabel(unit) === '' ? 'pcs' : unitLabel(unit);
}

/**
 * Kitchen Scale workbench (Kitchen Scale module). Client-only DERIVE-ON-READ view
 * over the SAVED recipe — it writes nothing and carries no money for either role.
 * Left: preset basket + custom target weight. Right: the scaled ingredient table;
 * editing any quantity re-anchors the whole scale on that line. Print/PDF reuse
 * the operational prep-card routes and only render with a valid `?portions=`.
 */
export function ScaleWorkbench({
  recipeId,
  recipeName,
  recipe,
  lines,
  presets,
  measurementSystem,
}: {
  recipeId: string;
  recipeName: string;
  recipe: WorkbenchRecipe;
  lines: WorkbenchLine[];
  presets: WorkbenchPreset[];
  measurementSystem: MeasurementSystem;
}) {
  const t = useTranslations('kitchenScale');

  const weightUnits = React.useMemo(
    () => displayUnitsFor('weight', measurementSystem),
    [measurementSystem],
  );
  // Basket state: per-preset quantity text + a loose custom weight.
  const [presetQty, setPresetQty] = React.useState<Record<string, string>>({});
  const [customText, setCustomText] = React.useState('');
  const [customUnit, setCustomUnit] = React.useState<Unit>(
    () => weightUnits[0] ?? 'g',
  );
  // Anchor override: editing a scaled quantity pins the scale to that line and
  // takes precedence over the basket until the basket changes or Reset.
  const [anchor, setAnchor] = React.useState<{
    lineId: string;
    text: string;
    unit: Unit;
  } | null>(null);

  const canScaleByWeight =
    recipe.yieldWeightGrams != null && recipe.yieldWeightGrams > 0;

  const basket = {
    presetQuantities: presets.map((p) => ({
      targetWeightGrams: p.targetWeightGrams,
      quantity: Number(presetQty[p.id] ?? ''),
    })),
    customWeightGrams:
      customText.trim() === '' ? 0 : toCanonical(Number(customText), customUnit),
  };
  const targetTotalGrams = basketTargetGrams(basket);

  // Derive the scale: anchor override first, then the basket. An empty input is
  // "no result yet" (factor 1 table), never an error.
  let result: RecipeScaleResult | null = null;
  if (anchor && anchor.text.trim() !== '') {
    result = scaleFromAnchor(
      recipe,
      lines,
      anchor.lineId,
      toCanonical(Number(anchor.text), anchor.unit),
    );
  } else if (!anchor && targetTotalGrams > 0) {
    result = scaleFromBasket(recipe, lines, basket);
  }

  const ok = result?.ok ? result : null;
  const factor = ok ? ok.factor : 1;
  const portionsParam = result ? portionsParamFor(result) : null;
  const query = portionsParam != null ? `?portions=${portionsParam}` : '';
  // No scale input = export the unscaled card (routes treat a missing ?portions=
  // as factor 1). Disable only when an actual scale exists but is invalid.
  const exportDisabled = result != null && portionsParam == null;

  const setBasketPresetQty = (id: string, value: string) => {
    setAnchor(null);
    setPresetQty((prev) => ({ ...prev, [id]: value }));
  };
  const setBasketCustom = (value: string) => {
    setAnchor(null);
    setCustomText(value);
  };
  const reset = () => {
    setPresetQty({});
    setCustomText('');
    setAnchor(null);
  };

  // Begin editing a line: seed the input with the line's CURRENT scaled value in
  // its friendliest display unit, so a click-and-nudge re-anchors from there.
  const startAnchor = (line: WorkbenchLine) => {
    if (anchor?.lineId === line.id) return;
    const scaled = line.quantity * factor;
    const unit = pickDisplayUnit(scaled, line.dimension, measurementSystem);
    setAnchor({
      lineId: line.id,
      text: String(round4(fromCanonical(scaled, unit))),
      unit,
    });
  };

  return (
    <div className="flex flex-col gap-5">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <Link
          href="/kitchen-scale"
          className="inline-flex size-9 items-center justify-center rounded-full border border-border bg-surface text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground"
          aria-label={t('back')}
        >
          <ArrowLeft className="size-4" />
        </Link>
        <h1 className="font-display text-lg font-semibold text-foreground">
          {recipeName}
        </h1>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <ExportButton
            href={`/recipes/${recipeId}/prep-card/print${query}`}
            disabled={exportDisabled}
            icon={<Printer className="size-4" />}
            label={t('printPrep')}
          />
          <ExportButton
            href={`/api/recipes/${recipeId}/prep-card/pdf${query}`}
            disabled={exportDisabled}
            icon={<Download className="size-4" />}
            label={t('downloadPrep')}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-2">
        {/* Left: target basket */}
        <Card>
          <CardHeader>
            <CardTitle>{t('basketTitle')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {!canScaleByWeight && (
              <p className="text-sm text-muted-foreground">
                {t('needsYieldWeight')}
              </p>
            )}

            {presets.length > 0 ? (
              <div className="flex flex-col gap-2">
                <span className="text-xs text-muted-foreground">
                  {t('presetBasketHint')}
                </span>
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
                      <Input
                        aria-label={t('presetQuantity')}
                        inputMode="decimal"
                        className="w-20"
                        placeholder="0"
                        value={presetQty[p.id] ?? ''}
                        onChange={(e) => setBasketPresetQty(p.id, e.target.value)}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t('noPresets')}</p>
            )}

            <div className="flex items-end gap-1.5">
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-foreground">
                  {t('customWeight')}
                </span>
                <Input
                  inputMode="decimal"
                  className="w-28"
                  placeholder="0"
                  value={customText}
                  onChange={(e) => setBasketCustom(e.target.value)}
                />
              </label>
              <Select
                aria-label={t('customWeightUnit')}
                className="w-24"
                value={customUnit}
                disabled={weightUnits.length <= 1}
                onChange={(e) => setCustomUnit(e.target.value as Unit)}
              >
                {weightUnits.map((u) => (
                  <option key={u} value={u}>
                    {unitOptionLabel(u)}
                  </option>
                ))}
              </Select>
            </div>

            {targetTotalGrams > 0 && (
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="text-muted-foreground">
                  {t('targetTotalWeight')}
                </span>
                <span className="font-medium tabular-nums text-foreground">
                  {formatQuantity(targetTotalGrams, 'weight', measurementSystem)}
                </span>
              </div>
            )}

            <div>
              <Button type="button" variant="ghost" size="sm" onClick={reset}>
                <RotateCcw className="size-4" />
                {t('reset')}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Right: scaled ingredients */}
        <Card>
          <CardHeader>
            <CardTitle>{t('tableTitle')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {result && !result.ok && (
              <p role="alert" className="text-sm text-destructive">
                {t(`errors.${result.reason}`)}
              </p>
            )}

            {ok && (
              <p className="font-display text-sm font-semibold text-foreground">
                {t('result', {
                  from: recipe.yieldPortions,
                  to: round4(ok.scaledPortions),
                  factor: round4(ok.factor),
                })}
              </p>
            )}

            {lines.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('noLines')}</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {lines.map((line) => {
                  const isAnchor = anchor?.lineId === line.id;
                  return (
                    <li
                      key={line.id}
                      className="flex items-center justify-between gap-3 rounded-md px-1 py-0.5"
                    >
                      <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                        {line.name}
                      </span>
                      {isAnchor ? (
                        <span className="flex items-center gap-1.5">
                          <Input
                            aria-label={t('anchorAmount', { name: line.name })}
                            inputMode="decimal"
                            className="w-24"
                            autoFocus
                            value={anchor.text}
                            onChange={(e) =>
                              setAnchor({ ...anchor, text: e.target.value })
                            }
                          />
                          <Select
                            aria-label={t('anchorUnit')}
                            className="w-24"
                            value={anchor.unit}
                            onChange={(e) =>
                              setAnchor({
                                ...anchor,
                                unit: e.target.value as Unit,
                              })
                            }
                          >
                            {displayUnitsFor(line.dimension, measurementSystem).map(
                              (u) => (
                                <option key={u} value={u}>
                                  {unitOptionLabel(u)}
                                </option>
                              ),
                            )}
                          </Select>
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => startAnchor(line)}
                          className="rounded-md px-2 py-1 text-sm tabular-nums text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground"
                          title={t('editToReAnchor')}
                        >
                          {formatQuantity(
                            line.quantity * (ok ? ok.factor : 1),
                            line.dimension,
                            measurementSystem,
                          )}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="text-xs text-muted-foreground">{t('editToReAnchor')}</p>
          </CardContent>
        </Card>
      </div>
    </div>
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
      {/* Plain <a>: /api PDF downloads must not go through Link client navigation
          or prefetch (rate-limited + audited route); same pattern as the print page. */}
      <a href={href}>
        {icon}
        {label}
      </a>
    </Button>
  );
}
