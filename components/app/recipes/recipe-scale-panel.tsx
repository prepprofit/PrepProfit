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

type Mode = 'portions' | 'anchor';

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
}) {
  const t = useTranslations('recipes.scale');

  const [mode, setMode] = React.useState<Mode>('portions');
  const [targetText, setTargetText] = React.useState(String(yieldPortions));
  const [anchorLineId, setAnchorLineId] = React.useState(lines[0]?.id ?? '');
  const [anchorUnit, setAnchorUnit] = React.useState<Unit>('g');
  const [anchorText, setAnchorText] = React.useState('');

  const lineQuantities = React.useMemo(() => lines.map((l) => l.quantity), [lines]);
  const anchorLine = lines.find((l) => l.id === anchorLineId);

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
  } else {
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
          </div>
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
