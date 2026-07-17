'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { roundCanonical } from '@/lib/calculations/recipeScale';

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
      quantity: number;
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

export type PickerOption = { id: string; name: string };

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
    const base = lineQuantity(line);
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
                        setTarget(String(scaled));
                      }}
                      title={t('scale')}
                    >
                      {scaled}{' '}
                      <span className="text-muted-foreground">
                        {line.kind === 'ingredient' ? line.unitLabel : 'g'}
                      </span>
                    </button>
                  )}
                  <div className="min-w-0">
                    <p className="truncate text-sm">
                      {line.name}
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
  onSectionsChange,
  onLinesChange,
}: {
  sections: DraftSection[];
  lines: DraftLine[];
  ingredientOptions: PickerOption[];
  componentOptions: PickerOption[];
  onSectionsChange: (sections: DraftSection[]) => void;
  onLinesChange: (lines: DraftLine[]) => void;
}) {
  const t = useTranslations('recipes.workspace');

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
        quantity: 0,
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
              value={String(lineQuantity(line))}
              onChange={(e) => {
                const value = Number(e.target.value.replace(',', '.'));
                const quantity = Number.isFinite(value) && value >= 0 ? value : 0;
                updateLine(
                  line.key,
                  line.kind === 'ingredient'
                    ? { quantity }
                    : { quantityGrams: quantity },
                );
              }}
              inputMode="decimal"
              className="h-8 w-24 text-right tabular-nums"
              aria-label={t('scale')}
            />
            <span className="w-8 text-xs text-muted-foreground">
              {line.kind === 'ingredient' ? line.unitLabel : 'g'}
            </span>
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
