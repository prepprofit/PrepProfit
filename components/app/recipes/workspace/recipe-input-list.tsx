'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { formatMoney } from '@/lib/format/money';
import { roundCanonical } from '@/lib/calculations/recipeScale';
import { formatWeightForUnit, parseWeightInput, type WeightDisplayUnit } from '@/lib/format/weight';
import {
  canonicalQuantity,
  formatAmount,
  parseAmount,
  quantityMode,
  type DraftLine,
  type DraftSection,
} from '@/lib/recipes/editor-model';

/**
 * The saved recipe's ingredient list (recipe page): section headers, ingredient lines
 * and sub-recipe lines in one visual order, scaled client-side by the view's factor.
 * Editing lives in the recipe editor; the shapes are shared through
 * `lib/recipes/editor-model`.
 */
export type { DraftLine, DraftSection, LineUom, PickerOption } from '@/lib/recipes/editor-model';

function groupBySection(
  sections: DraftSection[],
  lines: DraftLine[],
): { section: DraftSection | null; lines: DraftLine[] }[] {
  const groups: { section: DraftSection | null; lines: DraftLine[] }[] = [];
  const defaultGroup = {
    section: null,
    lines: lines.filter((l) => l.sectionRef === null),
  };
  if (defaultGroup.lines.length > 0) groups.push(defaultGroup);
  for (const section of sections) {
    groups.push({
      section,
      lines: lines.filter((l) => l.sectionRef === section.ref),
    });
  }
  return groups;
}

/** Read-only merged list with client-side scaling + per-line anchor scaling. */
export function RecipeInputListView({
  sections,
  lines,
  factor,
  onAnchorScale,
  lineCosts,
  currency,
  noPriceLabel,
  displayUnit,
}: {
  sections: DraftSection[];
  lines: DraftLine[];
  factor: number;
  /** Called when the user pins one line to a new amount (plan §7.1). */
  onAnchorScale: (baseQuantity: number, target: number) => void;
  /** Manager only: line key → batch line cost in cents (null = no price yet). */
  lineCosts?: Record<string, number | null>;
  currency?: string;
  noPriceLabel?: string;
  /** Recipe-wide g/kg display preference for weight lines (ml, pieces and other typed units keep their own). */
  displayUnit: WeightDisplayUnit;
}) {
  const t = useTranslations('recipes.workspace');
  const [editingKey, setEditingKey] = React.useState<string | null>(null);
  const [target, setTarget] = React.useState('');

  if (lines.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('emptyLines')}</p>;
  }

  /** The base the typed target scales against, in the unit that is DISPLAYED. */
  const commitAnchor = (line: DraftLine) => {
    const mode = quantityMode(line);
    // Weight lines are typed in the g/kg display unit and compared in grams; an
    // entered unit (cup, oz…) or ml/pieces compare in their own unit — both scale
    // linearly, so the factor is the same either way.
    const raw = mode.kind === 'weight' ? parseWeightInput(target, displayUnit) : parseAmount(target);
    const base =
      mode.kind === 'entered' && line.kind === 'ingredient' ? (line.enteredQuantity ?? 0) : canonicalQuantity(line);
    if (raw !== null && Number.isFinite(raw) && raw > 0 && base > 0) {
      onAnchorScale(base, raw);
    }
    setEditingKey(null);
  };

  return (
    <div className="flex flex-col gap-4">
      {groupBySection(sections, lines).map((group) => (
        <div key={group.section?.ref ?? '__default'}>
          {group.section ? (
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{group.section.title}</h3>
          ) : null}
          <ul className="divide-y divide-border">
            {group.lines.map((line) => {
              const mode = quantityMode(line);
              const scaled = roundCanonical(canonicalQuantity(line) * factor);
              const shown =
                mode.kind === 'weight'
                  ? formatWeightForUnit(scaled, displayUnit)
                  : mode.kind === 'entered' && line.kind === 'ingredient'
                    ? formatAmount(roundCanonical((line.enteredQuantity ?? 0) * factor))
                    : formatAmount(scaled, 2);
              const label = mode.kind === 'weight' ? displayUnit : mode.label;
              return (
                <li key={line.key} className="flex items-start gap-3 py-2.5">
                  {editingKey === line.key ? (
                    <Input
                      autoFocus
                      value={target}
                      onChange={(e) => setTarget(e.target.value)}
                      onBlur={() => commitAnchor(line)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitAnchor(line);
                        if (e.key === 'Escape') setEditingKey(null);
                      }}
                      inputMode="decimal"
                      className="h-7 w-24 text-right tabular-nums"
                      aria-label={t('scale')}
                    />
                  ) : (
                    <button
                      type="button"
                      className="w-24 shrink-0 rounded px-1 text-right font-medium tabular-nums underline-offset-2 hover:underline"
                      onClick={() => {
                        setEditingKey(line.key);
                        setTarget(shown);
                      }}
                      title={t('scale')}
                    >
                      {shown} <span className="text-muted-foreground">{label}</span>
                    </button>
                  )}
                  <div className="min-w-0">
                    <p className="text-base leading-snug">
                      {line.name}
                      {line.kind === 'ingredient' && line.prepName ? (
                        <span className="ml-1 text-muted-foreground">· {line.prepName}</span>
                      ) : null}
                      {line.kind === 'component' ? (
                        <span className="ml-2 rounded bg-surface-2 px-1.5 py-0.5 text-xs text-muted-foreground">
                          {t('subRecipe')}
                        </span>
                      ) : null}
                    </p>
                    {line.note ? <p className="text-xs text-muted-foreground">{line.note}</p> : null}
                  </div>
                  {lineCosts && currency ? (
                    <span className="ml-auto shrink-0 pl-3 text-right text-sm tabular-nums">
                      {lineCosts[line.id ?? line.key] != null ? (
                        <span className="text-foreground">
                          {formatMoney(Math.round((lineCosts[line.id ?? line.key] as number) * factor), currency)}
                        </span>
                      ) : (
                        <span className="text-xs text-amber-700 dark:text-amber-300">{noPriceLabel}</span>
                      )}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}
