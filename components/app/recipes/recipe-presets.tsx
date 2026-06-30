'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Check, ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react';
import {
  type MeasurementSystem,
  type Unit,
  displayUnitsFor,
  fromCanonical,
  pickDisplayUnit,
  toCanonical,
  unitLabel,
} from '@/lib/units';
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
import {
  addRecipePresetAction,
  removeRecipePresetAction,
  reorderRecipePresetsAction,
  updateRecipePresetAction,
} from '@/app/(app)/recipes/preset-actions';
import { useActionError } from '@/lib/i18n/use-action-error';

/** Operational-only preset shape shipped to BOTH roles (no cost ever loaded). */
export type EditorPreset = {
  id: string;
  name: string;
  /** Canonical target finished weight (grams). */
  targetWeightGrams: number;
  sortOrder: number;
};

type Row = EditorPreset & { unit: Unit; nameText: string; weightText: string };

function numberToText(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

function unitOptionLabel(unit: Unit): string {
  return unitLabel(unit) === '' ? 'pcs' : unitLabel(unit);
}

/**
 * Kitchen presets management (Recipe-editor parity). A named TARGET FINISHED WEIGHT
 * the recipe can later be scaled to. OPERATIONAL config — BOTH manager and kitchen
 * edit name + weight; the per-preset cost preview is derived MANAGER-side only (from
 * the live batch total + yield weight passed down) and never loaded from the server.
 *
 * Weights are stored canonically (grams) and edited in the org's weight units, like
 * the editor's batch yield weight field. Name + weight auto-save on blur, mirroring
 * the ingredient-line UX.
 */
export function RecipePresets({
  recipeId,
  presets,
  onPresetsChange,
  measurementSystem,
  canSeeCosts,
  currency,
  batchTotalCents,
  yieldWeightGrams,
}: {
  recipeId: string;
  /** Canonical preset list (owned by the editor so the scale panel stays in sync). */
  presets: EditorPreset[];
  /** Update the editor's canonical list after a successful mutation. */
  onPresetsChange: React.Dispatch<React.SetStateAction<EditorPreset[]>>;
  measurementSystem: MeasurementSystem;
  /** Manager only: render the per-preset estimated-cost column. */
  canSeeCosts: boolean;
  currency: string;
  /** Live batch total cents (managers); null for kitchen or when unavailable. */
  batchTotalCents: number | null;
  /** Live batch yield weight in canonical grams; null = not set. */
  yieldWeightGrams: number | null;
}) {
  const t = useTranslations('recipes.presets');
  const actionError = useActionError();

  const makeRow = React.useCallback(
    (p: EditorPreset): Row => {
      const unit = pickDisplayUnit(p.targetWeightGrams, 'weight', measurementSystem);
      return {
        ...p,
        unit,
        nameText: p.name,
        weightText: numberToText(fromCanonical(p.targetWeightGrams, unit)),
      };
    },
    [measurementSystem],
  );

  // Rows are the editable view of the canonical `presets` prop. Re-derive whenever
  // the canonical list changes (only after a successful mutation — the prop's array
  // reference is stable across unrelated editor re-renders), so the scale-panel
  // buttons and this list never drift. In-progress typing lives only in row state.
  const [rows, setRows] = React.useState<Row[]>(() => presets.map(makeRow));
  React.useEffect(() => {
    setRows(presets.map(makeRow));
  }, [presets, makeRow]);
  const [newName, setNewName] = React.useState('');
  const [newWeightText, setNewWeightText] = React.useState('');
  const [newUnit, setNewUnit] = React.useState<Unit>(
    () => displayUnitsFor('weight', measurementSystem)[0] ?? 'g',
  );
  const [error, setError] = React.useState<string | null>(null);
  const [savedId, setSavedId] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  const savedTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashSaved = React.useCallback((id: string) => {
    setSavedId(id);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSavedId(null), 1500);
  }, []);
  React.useEffect(
    () => () => {
      if (savedTimer.current) clearTimeout(savedTimer.current);
    },
    [],
  );

  // Per-preset estimated cost (managers only): scale the live batch total by the
  // exact factor and round ONCE — never derive from an already-rounded cost/kg.
  const presetCostCents = (targetWeightGrams: number): number | null => {
    if (!canSeeCosts || batchTotalCents == null) return null;
    if (yieldWeightGrams == null || !(yieldWeightGrams > 0)) return null;
    return Math.round((batchTotalCents * targetWeightGrams) / yieldWeightGrams);
  };

  const weightUnits = displayUnitsFor('weight', measurementSystem);

  const setRowField = (id: string, patch: Partial<Row>) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  // Switching a row's unit re-expresses the current entry (canonical grams unchanged).
  const onChangeRowUnit = (id: string, unit: Unit) => {
    setRows((prev) =>
      prev.map((r) => {
        if (r.id !== id) return r;
        const text = r.weightText.trim();
        const canonical = text === '' ? null : toCanonical(Number(text) || 0, r.unit);
        return {
          ...r,
          unit,
          weightText:
            canonical == null ? '' : numberToText(fromCanonical(canonical, unit)),
        };
      }),
    );
  };

  const persistRow = (id: string) => {
    const row = rows.find((r) => r.id === id);
    if (!row) return;
    const name = row.nameText.trim();
    const weight = Number(row.weightText);
    if (name === '') {
      setError(t('errors.nameRequired'));
      return;
    }
    if (!(weight > 0)) {
      setError(t('errors.weightRequired'));
      return;
    }
    const targetWeightGrams = Math.round(toCanonical(weight, row.unit) * 100) / 100;
    // No change → skip the round-trip (also avoids a false duplicate on re-blur).
    if (name === row.name && targetWeightGrams === row.targetWeightGrams) return;
    setError(null);
    startTransition(async () => {
      const result = await updateRecipePresetAction(recipeId, id, {
        name,
        targetWeightGrams,
      });
      if (result.ok) {
        const { name: savedName, targetWeightGrams: savedWeight } = result.data;
        onPresetsChange((prev) =>
          prev.map((p) =>
            p.id === id ? { ...p, name: savedName, targetWeightGrams: savedWeight } : p,
          ),
        );
        flashSaved(id);
      } else {
        setError(actionError(result.code));
      }
    });
  };

  const addPreset = () => {
    const name = newName.trim();
    const weight = Number(newWeightText);
    if (name === '') {
      setError(t('errors.nameRequired'));
      return;
    }
    if (!(weight > 0)) {
      setError(t('errors.weightRequired'));
      return;
    }
    const targetWeightGrams = Math.round(toCanonical(weight, newUnit) * 100) / 100;
    setError(null);
    startTransition(async () => {
      const result = await addRecipePresetAction(recipeId, {
        name,
        targetWeightGrams,
      });
      if (result.ok) {
        const created: EditorPreset = {
          id: result.data.id,
          name: result.data.name,
          targetWeightGrams: result.data.targetWeightGrams,
          sortOrder: result.data.sortOrder,
        };
        onPresetsChange((prev) => [...prev, created]);
        setNewName('');
        setNewWeightText('');
      } else {
        setError(actionError(result.code));
      }
    });
  };

  const removePreset = (id: string) => {
    setError(null);
    startTransition(async () => {
      const result = await removeRecipePresetAction(recipeId, id);
      if (result.ok) {
        onPresetsChange((prev) => prev.filter((p) => p.id !== id));
      } else {
        setError(actionError(result.code));
      }
    });
  };

  // Optimistic reorder on the canonical list, persisted as one atomic batch; restore
  // the previous order on failure. The rows effect re-derives from the new order.
  const movePreset = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= presets.length) return;
    const previous = presets;
    const next = presets.slice();
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved!);
    onPresetsChange(next);
    setError(null);
    startTransition(async () => {
      const result = await reorderRecipePresetsAction(recipeId, {
        orderedPresetIds: next.map((p) => p.id),
      });
      if (!result.ok) {
        onPresetsChange(previous);
        setError(actionError(result.code));
      }
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">{t('description')}</p>

        {error && (
          <div
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
          >
            {error}
          </div>
        )}

        {rows.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            {t('empty')}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {rows.map((row, idx) => {
              const costCents = presetCostCents(row.targetWeightGrams);
              return (
                <li
                  key={row.id}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2"
                >
                  <div className="flex items-center gap-0.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="size-7 p-0"
                      aria-label={t('moveUp')}
                      disabled={pending || idx === 0}
                      onClick={() => movePreset(idx, -1)}
                    >
                      <ChevronUp className="size-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="size-7 p-0"
                      aria-label={t('moveDown')}
                      disabled={pending || idx === rows.length - 1}
                      onClick={() => movePreset(idx, 1)}
                    >
                      <ChevronDown className="size-4" />
                    </Button>
                  </div>
                  <Input
                    aria-label={t('name')}
                    className="min-w-40 flex-1"
                    value={row.nameText}
                    disabled={pending}
                    onChange={(e) => setRowField(row.id, { nameText: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur();
                    }}
                    onBlur={() => persistRow(row.id)}
                  />
                  <div className="flex items-center gap-1.5">
                    <Input
                      aria-label={t('targetWeight')}
                      inputMode="decimal"
                      className="w-24"
                      value={row.weightText}
                      disabled={pending}
                      onChange={(e) =>
                        setRowField(row.id, { weightText: e.target.value })
                      }
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') e.currentTarget.blur();
                      }}
                      onBlur={() => persistRow(row.id)}
                    />
                    <Select
                      aria-label={t('targetWeight')}
                      className="w-24"
                      value={row.unit}
                      disabled={pending || weightUnits.length <= 1}
                      onChange={(e) => onChangeRowUnit(row.id, e.target.value as Unit)}
                    >
                      {weightUnits.map((u) => (
                        <option key={u} value={u}>
                          {unitOptionLabel(u)}
                        </option>
                      ))}
                    </Select>
                  </div>
                  {canSeeCosts && (
                    <span className="ml-auto whitespace-nowrap text-sm tabular-nums text-muted-foreground">
                      {t('estimatedCost')}:{' '}
                      <span className="text-foreground">
                        {costCents == null ? '—' : formatMoney(costCents, currency)}
                      </span>
                    </span>
                  )}
                  <div className="flex items-center gap-1">
                    {savedId === row.id && (
                      <span
                        className="inline-flex items-center gap-1 text-xs text-brand-700 dark:text-brand-300"
                        role="status"
                      >
                        <Check className="size-4" />
                      </span>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={t('remove')}
                      disabled={pending}
                      onClick={() => removePreset(row.id)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {/* Add row */}
        <div className="grid grid-cols-1 gap-2 rounded-lg border border-dashed border-border p-3 sm:grid-cols-[1fr_auto_auto_auto] sm:items-center">
          <Input
            aria-label={t('name')}
            placeholder={t('namePlaceholder')}
            value={newName}
            disabled={pending}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addPreset();
            }}
          />
          <Input
            aria-label={t('targetWeight')}
            inputMode="decimal"
            placeholder="0"
            className="w-24"
            value={newWeightText}
            disabled={pending}
            onChange={(e) => setNewWeightText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addPreset();
            }}
          />
          <Select
            aria-label={t('targetWeight')}
            className="w-24"
            value={newUnit}
            disabled={pending || weightUnits.length <= 1}
            onChange={(e) => setNewUnit(e.target.value as Unit)}
          >
            {weightUnits.map((u) => (
              <option key={u} value={u}>
                {unitOptionLabel(u)}
              </option>
            ))}
          </Select>
          <Button type="button" onClick={addPreset} disabled={pending}>
            <Plus className="size-4" />
            {t('add')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
