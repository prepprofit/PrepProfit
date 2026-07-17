'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { roundCanonical } from '@/lib/calculations/recipeScale';
import {
  convertQuantity,
  effectiveAnchors,
  type UomAnchors,
} from '@/lib/calculations/uom';
import {
  dimensionOf,
  unitLabel,
  type Dimension,
  type Unit,
} from '@/lib/units';

/**
 * The workspace's MERGED input sequence (plan §6.2/§9.2-9.3): section headers,
 * ingredient lines and sub-recipe lines in one visual order. This client model
 * mirrors `RecipeWorkspaceStructureDraft`: array position is the order the
 * save persists.
 */
export type DraftSection = { ref: string; id?: string; title: string };

export type DraftLine =
  | {
      key: string;
      kind: 'ingredient';
      id?: string;
      ingredientId: string;
      name: string;
      unitLabel: string;
      dimension: Dimension;
      quantity: number;
      /** Fase 4: what the chef typed. Both set, or both null (canonical entry). */
      enteredQuantity: number | null;
      enteredUnit: Unit | null;
      prepActionId: string | null;
      /** Display-only prep name resolved server-side (view mode). */
      prepName?: string | null;
      note: string;
      sectionRef: string | null;
    }
  | {
      key: string;
      kind: 'component';
      id?: string;
      componentRecipeId: string;
      name: string;
      quantityGrams: number;
      note: string;
      sectionRef: string | null;
    };

export type PickerOption = { id: string; name: string; dimension?: Dimension };

/** Per-ingredient UoM context the line editor needs (anchors + prep picker). */
export type LineUom = {
  anchors: UomAnchors | null;
  prepActions: { id: string; name: string; anchors: UomAnchors }[];
};

const ALL_UNITS: Unit[] = [
  'g',
  'kg',
  'oz',
  'lb',
  'ml',
  'l',
  'floz',
  'cup',
  'tsp',
  'tbsp',
  'count',
];

function lineQuantity(line: DraftLine): number {
  return line.kind === 'ingredient' ? line.quantity : line.quantityGrams;
}

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
}: {
  sections: DraftSection[];
  lines: DraftLine[];
  factor: number;
  /** Called when the user pins one line to a new amount (plan §7.1). */
  onAnchorScale: (baseQuantity: number, target: number) => void;
}) {
  const t = useTranslations('recipes.workspace');
  const [editingKey, setEditingKey] = React.useState<string | null>(null);
  const [target, setTarget] = React.useState('');

  if (lines.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('emptyLines')}</p>;
  }

  const commitAnchor = (line: DraftLine) => {
    const value = Number(target.replace(',', '.'));
    // The typed target is relative to what is DISPLAYED (entered pair when
    // present) — both scale linearly, so the factor is the same either way.
    const base =
      line.kind === 'ingredient' && line.enteredQuantity !== null
        ? line.enteredQuantity
        : lineQuantity(line);
    if (Number.isFinite(value) && value > 0 && base > 0) {
      onAnchorScale(base, value);
    }
    setEditingKey(null);
  };

  return (
    <div className="flex flex-col gap-4">
      {groupBySection(sections, lines).map((group) => (
        <div key={group.section?.ref ?? '__default'}>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {group.section?.title ?? t('defaultSection')}
          </h3>
          <ul className="divide-y divide-border">
            {group.lines.map((line) => {
              const scaled = roundCanonical(lineQuantity(line) * factor);
              // Fase 4: show what the chef TYPED (scaled) when present; the
              // canonical amount stays the anchor-scale + cost source.
              const entered =
                line.kind === 'ingredient' &&
                line.enteredQuantity !== null &&
                line.enteredUnit !== null
                  ? {
                      value: roundCanonical(line.enteredQuantity * factor),
                      label: unitLabel(line.enteredUnit),
                    }
                  : null;
              return (
                <li key={line.key} className="flex items-start gap-3 py-2">
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
                        setTarget(String(entered ? entered.value : scaled));
                      }}
                      title={t('scale')}
                    >
                      {entered ? entered.value : scaled}{' '}
                      <span className="text-muted-foreground">
                        {entered
                          ? entered.label
                          : line.kind === 'ingredient'
                            ? line.unitLabel
                            : 'g'}
                      </span>
                    </button>
                  )}
                  <div className="min-w-0">
                    <p className="truncate text-sm">
                      {line.name}
                      {line.kind === 'ingredient' && line.prepName ? (
                        <span className="ml-1 text-muted-foreground">
                          · {line.prepName}
                        </span>
                      ) : null}
                      {line.kind === 'component' ? (
                        <span className="ml-2 rounded bg-surface-2 px-1.5 py-0.5 text-xs text-muted-foreground">
                          {t('subRecipe')}
                        </span>
                      ) : null}
                    </p>
                    {line.note ? (
                      <p className="text-xs text-muted-foreground">{line.note}</p>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** Editable merged list: quantities, notes, reorder, add/remove. */
export function RecipeInputListEdit({
  sections,
  lines,
  ingredientOptions,
  componentOptions,
  lineUom,
  onSectionsChange,
  onLinesChange,
}: {
  sections: DraftSection[];
  lines: DraftLine[];
  ingredientOptions: PickerOption[];
  componentOptions: PickerOption[];
  /** UoM context per ingredient id (anchors + prep picker). Missing = none. */
  lineUom: Record<string, LineUom>;
  onSectionsChange: (sections: DraftSection[]) => void;
  onLinesChange: (lines: DraftLine[]) => void;
}) {
  const t = useTranslations('recipes.workspace');

  const uomFor = (ingredientId: string): LineUom =>
    lineUom[ingredientId] ?? { anchors: null, prepActions: [] };

  /** Anchors in effect for a line given its selected prep action. */
  const anchorsFor = (
    line: Extract<DraftLine, { kind: 'ingredient' }>,
  ): UomAnchors | null => {
    const uom = uomFor(line.ingredientId);
    const prep = uom.prepActions.find((p) => p.id === line.prepActionId);
    return effectiveAnchors(uom.anchors, prep?.anchors ?? null);
  };

  /** Units offered for a line: same dimension always; others only when convertible. */
  const unitOptionsFor = (
    line: Extract<DraftLine, { kind: 'ingredient' }>,
  ): Unit[] => {
    const anchors = anchorsFor(line);
    return ALL_UNITS.filter(
      (u) =>
        dimensionOf(u) === line.dimension ||
        convertQuantity(1, u, line.dimension, anchors).ok,
    );
  };

  const moveLine = (index: number, delta: -1 | 1) => {
    const next = [...lines];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    const [line] = next.splice(index, 1);
    next.splice(target, 0, line!);
    onLinesChange(next);
  };

  const updateLine = (key: string, patch: Partial<DraftLine>) => {
    onLinesChange(
      lines.map((l) => (l.key === key ? ({ ...l, ...patch } as DraftLine) : l)),
    );
  };

  const addIngredient = (ingredientId: string) => {
    const option = ingredientOptions.find((o) => o.id === ingredientId);
    if (!option) return;
    onLinesChange([
      ...lines,
      {
        key: `new-${crypto.randomUUID()}`,
        kind: 'ingredient',
        ingredientId: option.id,
        name: option.name,
        unitLabel: '',
        dimension: option.dimension ?? 'weight',
        quantity: 0,
        enteredQuantity: null,
        enteredUnit: null,
        prepActionId: null,
        note: '',
        sectionRef: null,
      },
    ]);
  };

  const addComponent = (componentRecipeId: string) => {
    const option = componentOptions.find((o) => o.id === componentRecipeId);
    if (!option) return;
    if (
      lines.some(
        (l) => l.kind === 'component' && l.componentRecipeId === option.id,
      )
    ) {
      return; // one line per component pair (DB unique)
    }
    onLinesChange([
      ...lines,
      {
        key: `new-${crypto.randomUUID()}`,
        kind: 'component',
        componentRecipeId: option.id,
        name: option.name,
        quantityGrams: 0,
        note: '',
        sectionRef: null,
      },
    ]);
  };

  const addSection = () => {
    onSectionsChange([
      ...sections,
      { ref: `tmp-${crypto.randomUUID()}`, title: '' },
    ]);
  };

  const removeSection = (ref: string) => {
    onSectionsChange(sections.filter((s) => s.ref !== ref));
    onLinesChange(
      lines.map((l) => (l.sectionRef === ref ? { ...l, sectionRef: null } : l)),
    );
  };

  const sectionSelectOptions = [
    { value: '', label: t('defaultSection') },
    ...sections.map((s) => ({ value: s.ref, label: s.title || '…' })),
  ];

  return (
    <div className="flex flex-col gap-4">
      {sections.map((section) => (
        <div key={section.ref} className="flex items-center gap-2">
          <Input
            value={section.title}
            onChange={(e) =>
              onSectionsChange(
                sections.map((s) =>
                  s.ref === section.ref ? { ...s, title: e.target.value } : s,
                ),
              )
            }
            placeholder={t('sectionTitlePlaceholder')}
            className="h-8 max-w-xs"
            aria-label={t('sectionTitlePlaceholder')}
          />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => removeSection(section.ref)}
            aria-label={t('removeSection')}
          >
            <Trash2 />
          </Button>
        </div>
      ))}

      <ul className="flex flex-col gap-2">
        {lines.map((line, index) => (
          <li
            key={line.key}
            className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface p-2"
          >
            <span className="min-w-32 flex-1 truncate text-sm">
              {line.name}
              {line.kind === 'component' ? (
                <span className="ml-2 rounded bg-surface-2 px-1.5 py-0.5 text-xs text-muted-foreground">
                  {t('subRecipe')}
                </span>
              ) : null}
            </span>
            <Input
              value={String(
                line.kind === 'ingredient' && line.enteredUnit !== null
                  ? (line.enteredQuantity ?? 0)
                  : lineQuantity(line),
              )}
              onChange={(e) => {
                const value = Number(e.target.value.replace(',', '.'));
                const amount = Number.isFinite(value) && value >= 0 ? value : 0;
                if (line.kind !== 'ingredient') {
                  updateLine(line.key, { quantityGrams: amount });
                  return;
                }
                if (line.enteredUnit === null) {
                  updateLine(line.key, { quantity: amount });
                  return;
                }
                const converted = convertQuantity(
                  amount,
                  line.enteredUnit,
                  line.dimension,
                  anchorsFor(line),
                );
                updateLine(line.key, {
                  enteredQuantity: amount,
                  quantity: converted.ok
                    ? roundCanonical(converted.canonical)
                    : line.quantity,
                });
              }}
              inputMode="decimal"
              className="h-8 w-24 text-right tabular-nums"
              aria-label={t('scale')}
            />
            {line.kind === 'ingredient' ? (
              <Select
                value={line.enteredUnit ?? ''}
                onChange={(e) => {
                  const unit = e.target.value === '' ? null : (e.target.value as Unit);
                  if (unit === null) {
                    // Back to canonical entry: the canonical amount stays.
                    updateLine(line.key, {
                      enteredUnit: null,
                      enteredQuantity: null,
                    });
                    return;
                  }
                  const amount = line.enteredQuantity ?? lineQuantity(line);
                  const converted = convertQuantity(
                    amount,
                    unit,
                    line.dimension,
                    anchorsFor(line),
                  );
                  updateLine(line.key, {
                    enteredUnit: unit,
                    enteredQuantity: amount,
                    quantity: converted.ok
                      ? roundCanonical(converted.canonical)
                      : line.quantity,
                  });
                }}
                className="h-8 w-24"
                aria-label={t('enteredUnit')}
              >
                <option value="">{line.unitLabel}</option>
                {unitOptionsFor(line).map((u) => (
                  <option key={u} value={u}>
                    {unitLabel(u) || t('uom.eachUnit')}
                  </option>
                ))}
              </Select>
            ) : (
              <span className="w-8 text-xs text-muted-foreground">g</span>
            )}
            {line.kind === 'ingredient' &&
            uomFor(line.ingredientId).prepActions.length > 0 ? (
              <Select
                value={line.prepActionId ?? ''}
                onChange={(e) =>
                  updateLine(line.key, {
                    prepActionId: e.target.value === '' ? null : e.target.value,
                  })
                }
                className="h-8 w-32"
                aria-label={t('prepAction')}
              >
                <option value="">{t('noPrep')}</option>
                {uomFor(line.ingredientId).prepActions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            ) : null}
            <Input
              value={line.note}
              onChange={(e) => updateLine(line.key, { note: e.target.value })}
              placeholder={t('notePlaceholder')}
              className="h-8 w-40"
              aria-label={t('note')}
            />
            <Select
              value={line.sectionRef ?? ''}
              onChange={(e) =>
                updateLine(line.key, {
                  sectionRef: e.target.value === '' ? null : e.target.value,
                })
              }
              className="h-8 w-36"
              aria-label={t('addSection')}
            >
              {sectionSelectOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => moveLine(index, -1)}
                disabled={index === 0}
                aria-label={t('moveUp')}
              >
                <ArrowUp />
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => moveLine(index, 1)}
                disabled={index === lines.length - 1}
                aria-label={t('moveDown')}
              >
                <ArrowDown />
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() =>
                  onLinesChange(lines.filter((l) => l.key !== line.key))
                }
                aria-label={t('removeLine')}
              >
                <Trash2 />
              </Button>
            </div>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-2">
        <Select
          value=""
          onChange={(e) => e.target.value && addIngredient(e.target.value)}
          className="h-8 w-48"
          aria-label={t('addIngredient')}
        >
          <option value="">{t('addIngredient')}</option>
          {ingredientOptions.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </Select>
        <Select
          value=""
          onChange={(e) => e.target.value && addComponent(e.target.value)}
          className="h-8 w-48"
          aria-label={t('addSubRecipe')}
        >
          <option value="">{t('addSubRecipe')}</option>
          {componentOptions.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </Select>
        <Button type="button" size="sm" variant="outline" onClick={addSection}>
          <Plus /> {t('addSection')}
        </Button>
      </div>
    </div>
  );
}
