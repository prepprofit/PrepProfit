'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronUp,
  FileText,
  GripVertical,
  Plus,
  Trash2,
} from 'lucide-react';
import type { Ingredient, Recipe, RecipeFolder } from '@/lib/db/schema';
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
import {
  costPerKgCents,
  lineCostCents,
  recipeCost,
} from '@/lib/calculations/recipeCost';
import {
  type MarginLight,
  marginPercent,
  suggestedPriceCents,
  trafficLight,
} from '@/lib/calculations/margin';
import {
  centsToAmountInput,
  formatMoney,
  parseMoneyToCents,
} from '@/lib/format/money';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  addRecipeComponentAction,
  addRecipeIngredientAction,
  deleteRecipeAction,
  removeRecipeComponentAction,
  removeRecipeIngredientAction,
  reorderRecipeComponentsAction,
  reorderRecipeIngredientsAction,
  updateRecipeAction,
  updateRecipeComponentAction,
  updateRecipeIngredientAction,
} from '@/app/(app)/recipes/actions';
import { moveRecipeToFolderAction } from '@/app/(app)/recipes/folder-actions';
import { useActionError } from '@/lib/i18n/use-action-error';
import {
  RecipePresets,
  type EditorPreset,
} from '@/components/app/recipes/recipe-presets';

/** Target gross margin used for the suggested price. */
const TARGET_MARGIN = 70;

const LIGHT_VARIANT: Record<MarginLight, 'positive' | 'warning' | 'negative'> = {
  green: 'positive',
  yellow: 'warning',
  red: 'negative',
};

/**
 * Editor shapes (Sprint F4): money is OPTIONAL. For kitchen the server ships the
 * recipe with no cost/selling-price keys and lines whose ingredient has no
 * `priceCents`; the cost/pricing UI below is not rendered, so the values are never
 * read. For managers every money field is present.
 */
type EditorRecipe = Omit<
  Recipe,
  'laborCostCents' | 'energyCostCents' | 'packagingCostCents' | 'sellingPriceCents'
> & {
  laborCostCents?: number;
  energyCostCents?: number;
  packagingCostCents?: number;
  sellingPriceCents?: number | null;
};

type EditorLineBase = {
  id: string;
  ingredientId: string;
  quantity: number;
  sortOrder: number;
  ingredient: { name: string; dimension: Ingredient['dimension']; priceCents?: number };
};

type IngredientOption = {
  id: string;
  name: string;
  dimension: Ingredient['dimension'];
  priceCents?: number;
};

type Line = EditorLineBase & { unit: Unit; valueText: string };

/**
 * A sub-recipe component line as the editor sees it. OPERATIONAL for both roles
 * (name + finished grams); `unitCostCentsPerGram` is MANAGER-ONLY metadata
 * (component batch total ÷ finished weight) so the line cost and the live batch
 * cost stay linear in the quantity — kitchen payloads never carry the key.
 * `null` (manager) = the component tree is unresolvable → cost tiles show "—".
 */
export type EditorComponentLine = {
  id: string;
  componentRecipeId: string;
  name: string;
  quantityGrams: number;
  sortOrder: number;
  unitCostCentsPerGram?: number | null;
};

/**
 * A picker candidate. Operational fields for both roles; `unitCostCentsPerGram`
 * is MANAGER-ONLY (absent from kitchen payloads) so a newly added line costs
 * live without a round-trip.
 */
export type ComponentPickerOption = {
  id: string;
  name: string;
  yieldWeightGrams: number | null;
  selectable: boolean;
  disabledReason: 'no_yield' | 'cycle' | null;
  unitCostCentsPerGram?: number | null;
};

type ComponentLine = EditorComponentLine & { valueText: string };

function numberToText(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

function unitOptionLabel(unit: Unit): string {
  return unitLabel(unit) === '' ? 'pcs' : unitLabel(unit);
}

export function RecipeEditor({
  canSeeCosts,
  recipe,
  initialLines,
  initialComponents,
  componentPicker,
  initialPresets,
  ingredients,
  folders,
  currency,
  measurementSystem,
}: {
  /** Manager only: render the cost column, cost/pricing cards and cost-sheet link. */
  canSeeCosts: boolean;
  recipe: EditorRecipe;
  initialLines: EditorLineBase[];
  initialComponents: EditorComponentLine[];
  componentPicker: ComponentPickerOption[];
  initialPresets: EditorPreset[];
  ingredients: IngredientOption[];
  folders: RecipeFolder[];
  currency: string;
  measurementSystem: MeasurementSystem;
}) {
  const t = useTranslations('recipes');
  const tDim = useTranslations('dimensions');
  const tCard = useTranslations('recipes.card');
  const tSummary = useTranslations('recipes.summary');
  const tFolders = useTranslations('recipes.folders');
  const tCommon = useTranslations('common');
  const actionError = useActionError();
  const router = useRouter();

  const makeLine = React.useCallback(
    (l: EditorLineBase): Line => {
      const unit = pickDisplayUnit(
        l.quantity,
        l.ingredient.dimension,
        measurementSystem,
      );
      return { ...l, unit, valueText: numberToText(fromCanonical(l.quantity, unit)) };
    },
    [measurementSystem],
  );

  // Batch yield weight is stored canonically (grams) but edited in the org's
  // weight units. Pick the friendliest unit for the stored value; an unset weight
  // (NULL) starts blank with the system's smallest weight unit selected.
  const initialWeightUnit = pickDisplayUnit(
    recipe.yieldWeightGrams ?? 0,
    'weight',
    measurementSystem,
  );
  const [yieldWeightUnit, setYieldWeightUnit] =
    React.useState<Unit>(initialWeightUnit);

  const [form, setForm] = React.useState({
    name: recipe.name,
    yieldPortions: String(recipe.yieldPortions),
    yieldPercentage: String(recipe.yieldPercentage),
    yieldWeightText:
      recipe.yieldWeightGrams != null
        ? numberToText(fromCanonical(recipe.yieldWeightGrams, initialWeightUnit))
        : '',
    // Money is only loaded/edited by managers; kitchen never holds these values.
    laborText: canSeeCosts ? centsToAmountInput(recipe.laborCostCents ?? 0) : '',
    energyText: canSeeCosts ? centsToAmountInput(recipe.energyCostCents ?? 0) : '',
    packagingText: canSeeCosts
      ? centsToAmountInput(recipe.packagingCostCents ?? 0)
      : '',
    sellingText:
      canSeeCosts && recipe.sellingPriceCents != null
        ? centsToAmountInput(recipe.sellingPriceCents)
        : '',
    notes: recipe.notes ?? '',
  });
  const [lines, setLines] = React.useState<Line[]>(() =>
    initialLines.map(makeLine),
  );
  // Sub-recipe component lines — quantities are grams of finished output.
  const [components, setComponents] = React.useState<ComponentLine[]>(() =>
    initialComponents.map((c) => ({ ...c, valueText: numberToText(c.quantityGrams) })),
  );
  const [newComponentId, setNewComponentId] = React.useState('');
  const [newComponentGramsText, setNewComponentGramsText] = React.useState('');
  // Canonical preset list — owned here and passed down to RecipePresets.
  const [presets, setPresets] = React.useState<EditorPreset[]>(initialPresets);
  const [newIngredientId, setNewIngredientId] = React.useState('');
  const [newValueText, setNewValueText] = React.useState('');
  const [newUnit, setNewUnit] = React.useState<Unit>('g');
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);
  const [savedLineId, setSavedLineId] = React.useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [folderId, setFolderId] = React.useState<string | null>(recipe.folderId);
  const [pending, startTransition] = React.useTransition();

  // Briefly flag a line as "saved" after its quantity auto-saves on blur/Enter.
  const savedLineTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashSavedLine = React.useCallback((lineId: string) => {
    setSavedLineId(lineId);
    if (savedLineTimer.current) clearTimeout(savedLineTimer.current);
    savedLineTimer.current = setTimeout(() => setSavedLineId(null), 1500);
  }, []);
  React.useEffect(
    () => () => {
      if (savedLineTimer.current) clearTimeout(savedLineTimer.current);
    },
    [],
  );

  // Filing the recipe is applied immediately (consistent with the list's move
  // control); on failure we revert the select to its previous value.
  const onChangeFolder = (value: string) => {
    const next = value === '' ? null : value;
    const previous = folderId;
    setFolderId(next);
    setError(null);
    startTransition(async () => {
      const result = await moveRecipeToFolderAction(recipe.id, {
        folderId: next,
      });
      if (!result.ok) {
        setFolderId(previous);
        setError(actionError(result.code));
      }
    });
  };

  const setField = (patch: Partial<typeof form>) => {
    setForm((prev) => ({ ...prev, ...patch }));
    setSaved(false);
  };

  // Changing the weight unit re-expresses the current entry in the new unit (the
  // canonical grams stay the same), mirroring the per-line unit switch.
  const onChangeWeightUnit = (unit: Unit) => {
    const text = form.yieldWeightText.trim();
    const canonical = text === '' ? null : toCanonical(Number(text) || 0, yieldWeightUnit);
    setYieldWeightUnit(unit);
    setField({
      yieldWeightText:
        canonical == null ? '' : numberToText(fromCanonical(canonical, unit)),
    });
  };

  // --- live cost & margin (managers only — kitchen sees no money) ---
  // A component with unresolvable cost metadata makes the live cost UNTRUE →
  // hide the money tiles ("—") rather than render a partial sum.
  const componentCostUnresolved =
    canSeeCosts && components.some((c) => c.unitCostCentsPerGram == null);
  const cost =
    canSeeCosts && !componentCostUnresolved
      ? recipeCost({
          yieldPortions: Number(form.yieldPortions) || 0,
          yieldPercentage: Number(form.yieldPercentage) || 0,
          laborCostCents: parseMoneyToCents(form.laborText),
          energyCostCents: parseMoneyToCents(form.energyText),
          packagingCostCents: parseMoneyToCents(form.packagingText),
          lines: lines.map((l) => ({
            dimension: l.ingredient.dimension,
            priceCents: l.ingredient.priceCents ?? 0,
            quantity: l.quantity,
          })),
          // Component raw cost is linear in the finished grams used.
          componentMaterialCostsCents: components.map(
            (c) => (c.unitCostCentsPerGram ?? 0) * c.quantityGrams,
          ),
        })
      : null;
  const sellingCents = parseMoneyToCents(form.sellingText);
  const hasPrice = canSeeCosts && form.sellingText.trim() !== '' && sellingCents > 0;
  const margin = cost ? marginPercent(cost.costPerPortionCents, sellingCents) : 0;
  const light = trafficLight(margin);
  const suggested = cost
    ? suggestedPriceCents(cost.costPerPortionCents, TARGET_MARGIN)
    : 0;

  // Live batch yield weight in canonical grams (null when blank/non-positive) — the
  // summary strip's weight tile (both roles) and, for managers, the cost/kg tile
  // read from this. Cost/kg needs a positive weight AND a manager cost, else null.
  const yieldWeightGramsLive = (() => {
    const text = form.yieldWeightText.trim();
    const n = Number(text);
    return text === '' || !(n > 0)
      ? null
      : Math.round(toCanonical(n, yieldWeightUnit) * 100) / 100;
  })();
  const perKgCents = cost
    ? costPerKgCents(cost.totalCostCents, yieldWeightGramsLive)
    : null;

  const availableIngredients = ingredients.filter(
    (i) => !lines.some((l) => l.ingredientId === i.id),
  );

  // --- recipe header ---
  const onSave = () => {
    const name = form.name.trim();
    if (name === '') {
      setError(t('errors.nameRequired'));
      return;
    }
    setError(null);
    // Blank, zero or non-positive weight → null ("not set"), keeping cost/kg and
    // presets honest rather than tripping the positive-number validation.
    const weightText = form.yieldWeightText.trim();
    const weightNum = Number(weightText);
    const yieldWeightGrams =
      weightText === '' || !(weightNum > 0)
        ? null
        : Math.round(toCanonical(weightNum, yieldWeightUnit) * 100) / 100;
    const base = {
      name,
      yieldPortions: Math.max(1, Math.round(Number(form.yieldPortions) || 1)),
      yieldPercentage: Math.min(
        100,
        Math.max(1, Math.round(Number(form.yieldPercentage) || 100)),
      ),
      yieldWeightGrams,
      notes: form.notes.trim() === '' ? null : form.notes.trim(),
    };
    // Kitchen sends operational fields only — never a cost or selling price.
    const input = canSeeCosts
      ? {
          ...base,
          laborCostCents: parseMoneyToCents(form.laborText),
          energyCostCents: parseMoneyToCents(form.energyText),
          packagingCostCents: parseMoneyToCents(form.packagingText),
          sellingPriceCents:
            form.sellingText.trim() === ''
              ? null
              : parseMoneyToCents(form.sellingText),
        }
      : base;
    startTransition(async () => {
      const result = await updateRecipeAction(recipe.id, input);
      if (result.ok) {
        setSaved(true);
      } else {
        setError(actionError(result.code));
      }
    });
  };

  const confirmDelete = () => {
    setError(null);
    startTransition(async () => {
      const result = await deleteRecipeAction(recipe.id);
      if (result.ok) {
        router.push('/recipes');
      } else {
        setError(actionError(result.code));
        setConfirmOpen(false);
      }
    });
  };

  // --- lines ---
  const setLineValue = (lineId: string, valueText: string) => {
    setLines((prev) =>
      prev.map((l) =>
        l.id === lineId
          ? {
              ...l,
              valueText,
              quantity: toCanonical(Number(valueText) || 0, l.unit),
            }
          : l,
      ),
    );
  };

  const setLineUnit = (lineId: string, unit: Unit) => {
    setLines((prev) =>
      prev.map((l) =>
        l.id === lineId
          ? { ...l, unit, valueText: numberToText(fromCanonical(l.quantity, unit)) }
          : l,
      ),
    );
  };

  const persistLine = (lineId: string) => {
    const line = lines.find((l) => l.id === lineId);
    if (!line) return;
    setError(null);
    startTransition(async () => {
      const result = await updateRecipeIngredientAction(recipe.id, lineId, {
        quantity: line.quantity,
      });
      if (result.ok) {
        flashSavedLine(lineId);
      } else setError(actionError(result.code));
    });
  };

  const removeLine = (lineId: string) => {
    setError(null);
    startTransition(async () => {
      const result = await removeRecipeIngredientAction(recipe.id, lineId);
      if (result.ok) {
        setLines((prev) => prev.filter((l) => l.id !== lineId));
      } else {
        setError(actionError(result.code));
      }
    });
  };

  // --- reorder lines ---
  // Both roles may reorder (presentation metadata, no money). Optimistic: apply the
  // new order locally, persist as one atomic batch, and on failure restore the
  // snapshot + surface the error. Export stays gated while the write is in flight.
  const dragIndex = React.useRef<number | null>(null);

  const commitReorder = (next: Line[]) => {
    const previous = lines;
    setLines(next);
    setError(null);
    startTransition(async () => {
      const result = await reorderRecipeIngredientsAction(recipe.id, {
        orderedLineIds: next.map((l) => l.id),
      });
      if (!result.ok) {
        setLines(previous);
        setError(actionError(result.code));
      }
    });
  };

  const moveLine = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= lines.length) return;
    const next = lines.slice();
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved!);
    commitReorder(next);
  };

  const onDropOnRow = (index: number) => {
    const from = dragIndex.current;
    dragIndex.current = null;
    if (from === null || from === index) return;
    const next = lines.slice();
    const [moved] = next.splice(from, 1);
    next.splice(index, 0, moved!);
    commitReorder(next);
  };

  const onSelectNewIngredient = (id: string) => {
    setNewIngredientId(id);
    const ing = ingredients.find((i) => i.id === id);
    if (ing) {
      const units = displayUnitsFor(ing.dimension, measurementSystem);
      setNewUnit(units[0] ?? 'g');
    }
  };

  // --- sub-recipe component lines (operational; manager also sees line cost) ---
  const setComponentValue = (lineId: string, valueText: string) => {
    setComponents((prev) =>
      prev.map((c) =>
        c.id === lineId
          ? { ...c, valueText, quantityGrams: Number(valueText) || 0 }
          : c,
      ),
    );
  };

  const persistComponent = (lineId: string) => {
    const line = components.find((c) => c.id === lineId);
    if (!line || !(line.quantityGrams > 0)) return;
    setError(null);
    startTransition(async () => {
      const result = await updateRecipeComponentAction(recipe.id, lineId, {
        quantityGrams: line.quantityGrams,
      });
      if (result.ok) flashSavedLine(lineId);
      else setError(actionError(result.code));
    });
  };

  const removeComponent = (lineId: string) => {
    setError(null);
    startTransition(async () => {
      const result = await removeRecipeComponentAction(recipe.id, lineId);
      if (result.ok) setComponents((prev) => prev.filter((c) => c.id !== lineId));
      else setError(actionError(result.code));
    });
  };

  const componentDragIndex = React.useRef<number | null>(null);
  const commitComponentReorder = (next: ComponentLine[]) => {
    const previous = components;
    setComponents(next);
    setError(null);
    startTransition(async () => {
      const result = await reorderRecipeComponentsAction(recipe.id, {
        orderedLineIds: next.map((c) => c.id),
      });
      if (!result.ok) {
        setComponents(previous);
        setError(actionError(result.code));
      }
    });
  };

  const moveComponent = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= components.length) return;
    const next = components.slice();
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved!);
    commitComponentReorder(next);
  };

  const availableComponentOptions = componentPicker.filter(
    (option) => !components.some((c) => c.componentRecipeId === option.id),
  );

  const addComponent = () => {
    const option = componentPicker.find((o) => o.id === newComponentId);
    const quantityGrams = Number(newComponentGramsText) || 0;
    if (!option || !(quantityGrams > 0)) return;
    setError(null);
    startTransition(async () => {
      const result = await addRecipeComponentAction(recipe.id, {
        componentRecipeId: option.id,
        quantityGrams,
        sortOrder: components.length,
      });
      if (result.ok) {
        // The server owns cost metadata — refresh to pull the resolved line
        // cost; optimistically show the operational line meanwhile.
        setComponents((prev) => [
          ...prev,
          {
            id: result.data.id,
            componentRecipeId: option.id,
            name: option.name,
            quantityGrams,
            sortOrder: prev.length,
            unitCostCentsPerGram: canSeeCosts
              ? (option.unitCostCentsPerGram ?? null)
              : undefined,
            valueText: numberToText(quantityGrams),
          },
        ]);
        setNewComponentId('');
        setNewComponentGramsText('');
      } else {
        setError(actionError(result.code));
      }
    });
  };

  const addLine = () => {
    const ing = ingredients.find((i) => i.id === newIngredientId);
    if (!ing) {
      setError(t('errors.pickIngredient'));
      return;
    }
    const quantity = toCanonical(Number(newValueText) || 0, newUnit);
    setError(null);
    startTransition(async () => {
      const result = await addRecipeIngredientAction(recipe.id, {
        ingredientId: ing.id,
        quantity,
        sortOrder: lines.length,
      });
      if (result.ok) {
        setLines((prev) => [
          ...prev,
          makeLine({
            id: result.data.id,
            ingredientId: ing.id,
            quantity,
            sortOrder: prev.length,
            ingredient: {
              name: ing.name,
              dimension: ing.dimension,
              priceCents: ing.priceCents,
            },
          } satisfies EditorLineBase),
        ]);
        setNewIngredientId('');
        setNewValueText('');
      } else {
        setError(actionError(result.code));
      }
    });
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <Link
          href="/recipes"
          className="inline-flex size-9 items-center justify-center rounded-full border border-border bg-surface text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground"
          aria-label={t('actions.back')}
        >
          <ArrowLeft className="size-4" />
        </Link>
        <Input
          aria-label={t('fields.name')}
          className="h-11 max-w-md flex-1 text-lg font-medium"
          value={form.name}
          disabled={pending}
          onChange={(e) => setField({ name: e.target.value })}
        />
        <div className="ml-auto flex items-center gap-2">
          {saved && (
            <span className="inline-flex items-center gap-1 text-sm text-brand-700 dark:text-brand-300">
              <Check className="size-4" />
              {t('saved')}
            </span>
          )}
          {canSeeCosts && (
            <Button asChild type="button" variant="outline">
              <Link href={`/recipes/${recipe.id}/card/print`}>
                <FileText className="size-4" />
                {tCard('action')}
              </Link>
            </Button>
          )}
          <Button type="button" onClick={onSave} disabled={pending}>
            {t('actions.save')}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => setConfirmOpen(true)}
            disabled={pending}
            aria-label={t('actions.delete')}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
        >
          {error}
        </div>
      )}

      {/* Batch summary strip — compact operational tiles. Weight shows for both
          roles; live batch cost and cost/kg are FINANCIAL, managers only (D2). */}
      <div
        className={`grid grid-cols-2 gap-3 ${cost ? 'sm:grid-cols-3' : 'sm:grid-cols-1'}`}
      >
        <Tile
          label={tSummary('weight')}
          value={
            yieldWeightGramsLive == null
              ? '—'
              : formatQuantity(yieldWeightGramsLive, 'weight', measurementSystem)
          }
        />
        {cost && (
          <>
            <Tile
              label={tSummary('batchCost')}
              value={formatMoney(cost.totalCostCents, currency)}
            />
            <Tile
              label={tSummary('costPerKg')}
              value={perKgCents == null ? '—' : formatMoney(perKgCents, currency)}
            />
          </>
        )}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3 lg:items-start">
        {/* Left column: ingredients + instructions (fills the column instead of
            leaving blank space when the recipe has few ingredients). */}
        <div className="flex flex-col gap-6 lg:col-span-2">
        <Card>
          <CardHeader>
            <CardTitle>{t('ingredients.title')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    {/* Reorder controls (drag grip + move up/down). */}
                    <th className="w-20 pb-2">
                      <span className="sr-only">{t('ingredients.reorder')}</span>
                    </th>
                    <th className="pb-2">{t('ingredients.name')}</th>
                    <th className="pb-2">{t('ingredients.quantity')}</th>
                    {canSeeCosts && (
                      <th className="pb-2 text-right">{t('ingredients.cost')}</th>
                    )}
                    <th className="pb-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {lines.length === 0 && (
                    <tr>
                      <td
                        colSpan={canSeeCosts ? 5 : 4}
                        className="py-6 text-center text-sm text-muted-foreground"
                      >
                        {t('ingredients.empty')}
                      </td>
                    </tr>
                  )}
                  {lines.map((line, idx) => {
                    const units = displayUnitsFor(
                      line.ingredient.dimension,
                      measurementSystem,
                    );
                    const lineCost = canSeeCosts
                      ? Math.round(
                          lineCostCents({
                            dimension: line.ingredient.dimension,
                            priceCents: line.ingredient.priceCents ?? 0,
                            quantity: line.quantity,
                          }),
                        )
                      : 0;
                    return (
                      <tr
                        key={line.id}
                        className="border-b border-border last:border-0"
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={() => onDropOnRow(idx)}
                      >
                        <td className="py-2 pr-2">
                          <div className="flex items-center gap-0.5">
                            <span
                              draggable={!pending}
                              onDragStart={() => {
                                dragIndex.current = idx;
                              }}
                              onDragEnd={() => {
                                dragIndex.current = null;
                              }}
                              aria-hidden
                              className="cursor-grab text-muted-foreground hover:text-foreground active:cursor-grabbing"
                            >
                              <GripVertical className="size-4" />
                            </span>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="size-7 p-0"
                              aria-label={t('ingredients.moveUp')}
                              disabled={pending || idx === 0}
                              onClick={() => moveLine(idx, -1)}
                            >
                              <ChevronUp className="size-4" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="size-7 p-0"
                              aria-label={t('ingredients.moveDown')}
                              disabled={pending || idx === lines.length - 1}
                              onClick={() => moveLine(idx, 1)}
                            >
                              <ChevronDown className="size-4" />
                            </Button>
                          </div>
                        </td>
                        <td className="whitespace-nowrap py-2 pr-2">
                          <span className="font-medium text-foreground">
                            {line.ingredient.name}
                          </span>
                          <span className="ml-2 text-xs text-muted-foreground">
                            {tDim(line.ingredient.dimension)}
                          </span>
                        </td>
                        <td className="py-2 pr-2">
                          <div className="flex items-center gap-1.5">
                            <Input
                              aria-label={t('ingredients.quantity')}
                              inputMode="decimal"
                              className="w-24"
                              value={line.valueText}
                              disabled={pending}
                              onChange={(e) =>
                                setLineValue(line.id, e.target.value)
                              }
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') e.currentTarget.blur();
                              }}
                              onBlur={() => persistLine(line.id)}
                            />
                            <Select
                              aria-label={t('ingredients.unit')}
                              className="w-24"
                              value={line.unit}
                              disabled={pending || units.length <= 1}
                              onChange={(e) =>
                                setLineUnit(line.id, e.target.value as Unit)
                              }
                            >
                              {units.map((u) => (
                                <option key={u} value={u}>
                                  {unitOptionLabel(u)}
                                </option>
                              ))}
                            </Select>
                          </div>
                        </td>
                        {canSeeCosts && (
                          <td className="py-2 pr-2 text-right tabular-nums">
                            {formatMoney(lineCost, currency)}
                          </td>
                        )}
                        <td className="py-2 text-right">
                          <div className="flex items-center justify-end gap-1">
                            {savedLineId === line.id && (
                              <span
                                className="inline-flex items-center gap-1 text-xs text-brand-700 dark:text-brand-300"
                                role="status"
                              >
                                <Check className="size-4" />
                                {t('saved')}
                              </span>
                            )}
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              aria-label={t('ingredients.remove')}
                              disabled={pending}
                              onClick={() => removeLine(line.id)}
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Add line */}
            <div className="grid grid-cols-1 gap-2 rounded-lg border border-dashed border-border p-3 sm:grid-cols-[1fr_auto_auto_auto] sm:items-center">
              <Select
                aria-label={t('ingredients.add')}
                value={newIngredientId}
                disabled={pending || availableIngredients.length === 0}
                onChange={(e) => onSelectNewIngredient(e.target.value)}
              >
                <option value="">
                  {availableIngredients.length === 0
                    ? t('ingredients.allAdded')
                    : t('ingredients.select')}
                </option>
                {availableIngredients.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </Select>
              <Input
                aria-label={t('ingredients.quantity')}
                inputMode="decimal"
                placeholder="0"
                className="w-24"
                value={newValueText}
                disabled={pending || newIngredientId === ''}
                onChange={(e) => setNewValueText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newIngredientId !== '') addLine();
                }}
              />
              <Select
                aria-label={t('ingredients.unit')}
                className="w-24"
                value={newUnit}
                disabled={pending || newIngredientId === ''}
                onChange={(e) => setNewUnit(e.target.value as Unit)}
              >
                {(newIngredientId
                  ? displayUnitsFor(
                      ingredients.find((i) => i.id === newIngredientId)
                        ?.dimension ?? 'weight',
                      measurementSystem,
                    )
                  : []
                ).map((u) => (
                  <option key={u} value={u}>
                    {unitOptionLabel(u)}
                  </option>
                ))}
              </Select>
              <Button
                type="button"
                onClick={addLine}
                disabled={pending || newIngredientId === ''}
              >
                <Plus className="size-4" />
                {t('ingredients.add')}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Sub-recipes — recipes used as finished components (grams of finished
            output). Operational for both roles; only managers see line costs. */}
        <Card>
          <CardHeader>
            <CardTitle>{t('components.title')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    <th className="w-20 pb-2">
                      <span className="sr-only">{t('components.reorder')}</span>
                    </th>
                    <th className="pb-2">{t('components.name')}</th>
                    <th className="pb-2">{t('components.quantity')}</th>
                    {canSeeCosts && (
                      <th className="pb-2 text-right">{t('components.cost')}</th>
                    )}
                    <th className="pb-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {components.length === 0 && (
                    <tr>
                      <td
                        colSpan={canSeeCosts ? 5 : 4}
                        className="py-6 text-center text-sm text-muted-foreground"
                      >
                        {t('components.empty')}
                      </td>
                    </tr>
                  )}
                  {components.map((line, idx) => (
                    <tr
                      key={line.id}
                      className="border-b border-border last:border-0"
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={() => {
                        const from = componentDragIndex.current;
                        componentDragIndex.current = null;
                        if (from === null || from === idx) return;
                        const next = components.slice();
                        const [moved] = next.splice(from, 1);
                        next.splice(idx, 0, moved!);
                        commitComponentReorder(next);
                      }}
                    >
                      <td className="py-2 pr-2">
                        <div className="flex items-center gap-0.5">
                          <span
                            draggable={!pending}
                            onDragStart={() => {
                              componentDragIndex.current = idx;
                            }}
                            onDragEnd={() => {
                              componentDragIndex.current = null;
                            }}
                            aria-hidden
                            className="cursor-grab text-muted-foreground hover:text-foreground active:cursor-grabbing"
                          >
                            <GripVertical className="size-4" />
                          </span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="size-7 p-0"
                            aria-label={t('components.moveUp')}
                            disabled={pending || idx === 0}
                            onClick={() => moveComponent(idx, -1)}
                          >
                            <ChevronUp className="size-4" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="size-7 p-0"
                            aria-label={t('components.moveDown')}
                            disabled={pending || idx === components.length - 1}
                            onClick={() => moveComponent(idx, 1)}
                          >
                            <ChevronDown className="size-4" />
                          </Button>
                        </div>
                      </td>
                      <td className="whitespace-nowrap py-2 pr-2">
                        <Link
                          href={`/recipes/${line.componentRecipeId}`}
                          className="font-medium text-foreground hover:underline"
                        >
                          {line.name}
                        </Link>
                      </td>
                      <td className="py-2 pr-2">
                        <div className="flex items-center gap-1.5">
                          <Input
                            aria-label={t('components.quantity')}
                            inputMode="decimal"
                            className="w-24"
                            value={line.valueText}
                            disabled={pending}
                            onChange={(e) =>
                              setComponentValue(line.id, e.target.value)
                            }
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') e.currentTarget.blur();
                            }}
                            onBlur={() => persistComponent(line.id)}
                          />
                          <span className="text-xs text-muted-foreground">g</span>
                        </div>
                      </td>
                      {canSeeCosts && (
                        <td className="py-2 pr-2 text-right tabular-nums">
                          {line.unitCostCentsPerGram == null
                            ? '—'
                            : formatMoney(
                                Math.round(
                                  line.unitCostCentsPerGram * line.quantityGrams,
                                ),
                                currency,
                              )}
                        </td>
                      )}
                      <td className="py-2 text-right">
                        <div className="flex items-center justify-end gap-1">
                          {savedLineId === line.id && (
                            <span
                              className="inline-flex items-center gap-1 text-xs text-brand-700 dark:text-brand-300"
                              role="status"
                            >
                              <Check className="size-4" />
                              {t('saved')}
                            </span>
                          )}
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            aria-label={t('components.remove')}
                            disabled={pending}
                            onClick={() => removeComponent(line.id)}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Add component */}
            <div className="grid grid-cols-1 gap-2 rounded-lg border border-dashed border-border p-3 sm:grid-cols-[1fr_auto_auto] sm:items-center">
              <Select
                aria-label={t('components.add')}
                value={newComponentId}
                disabled={pending || availableComponentOptions.length === 0}
                onChange={(e) => setNewComponentId(e.target.value)}
              >
                <option value="">
                  {availableComponentOptions.length === 0
                    ? t('components.noneAvailable')
                    : t('components.select')}
                </option>
                {availableComponentOptions.map((option) => (
                  <option
                    key={option.id}
                    value={option.id}
                    disabled={!option.selectable}
                  >
                    {option.name}
                    {option.disabledReason === 'no_yield'
                      ? ` — ${t('components.needsYield')}`
                      : option.disabledReason === 'cycle'
                        ? ` — ${t('components.wouldCycle')}`
                        : ''}
                  </option>
                ))}
              </Select>
              <Input
                aria-label={t('components.quantity')}
                inputMode="decimal"
                placeholder="0 g"
                className="w-28"
                value={newComponentGramsText}
                disabled={pending || newComponentId === ''}
                onChange={(e) => setNewComponentGramsText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newComponentId !== '') addComponent();
                }}
              />
              <Button
                type="button"
                onClick={addComponent}
                disabled={
                  pending ||
                  newComponentId === '' ||
                  !(Number(newComponentGramsText) > 0)
                }
              >
                <Plus className="size-4" />
                {t('components.addAction')}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Instructions / notes — under the ingredients (it's where the chef
            reads/writes how to make the recipe). */}
        <Card>
          <CardHeader>
            <CardTitle>{t('fields.instructionsNotes')}</CardTitle>
          </CardHeader>
          <CardContent>
            <Textarea
              value={form.notes}
              disabled={pending}
              placeholder={t('placeholders.notes')}
              onChange={(e) => setField({ notes: e.target.value })}
            />
          </CardContent>
        </Card>
        </div>

        {/* Right column */}
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>{t('parameters.title')}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <Field label={t('fields.folder')}>
                <Select
                  value={folderId ?? ''}
                  disabled={pending}
                  onChange={(e) => onChangeFolder(e.target.value)}
                >
                  <option value="">{tFolders('noFolder')}</option>
                  {folders.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('fields.yieldPortions')}>
                <Input
                  type="number"
                  min={1}
                  inputMode="numeric"
                  value={form.yieldPortions}
                  disabled={pending}
                  onChange={(e) => setField({ yieldPortions: e.target.value })}
                />
              </Field>
              <Field label={t('fields.yieldPercentage')}>
                <Input
                  type="number"
                  min={1}
                  max={100}
                  inputMode="numeric"
                  value={form.yieldPercentage}
                  disabled={pending}
                  onChange={(e) => setField({ yieldPercentage: e.target.value })}
                />
              </Field>
              {/* Batch yield weight — OPERATIONAL physical data, both roles edit it.
                  Stored canonically (g); entered in the org's weight units. */}
              <Field label={t('fields.yieldWeight')}>
                <div className="flex items-center gap-1.5">
                  <Input
                    inputMode="decimal"
                    placeholder={t('placeholders.yieldWeight')}
                    value={form.yieldWeightText}
                    disabled={pending}
                    onChange={(e) => setField({ yieldWeightText: e.target.value })}
                  />
                  <Select
                    aria-label={t('fields.yieldWeightUnit')}
                    className="w-24"
                    value={yieldWeightUnit}
                    disabled={pending}
                    onChange={(e) => onChangeWeightUnit(e.target.value as Unit)}
                  >
                    {displayUnitsFor('weight', measurementSystem).map((u) => (
                      <option key={u} value={u}>
                        {unitOptionLabel(u)}
                      </option>
                    ))}
                  </Select>
                </div>
              </Field>
              {/* Hidden costs are financial — managers only (Sprint F4). */}
              {canSeeCosts && (
                <>
                  <Field label={`${t('fields.labor')} · ${currency}`}>
                    <Input
                      inputMode="decimal"
                      value={form.laborText}
                      disabled={pending}
                      onChange={(e) => setField({ laborText: e.target.value })}
                    />
                  </Field>
                  <Field label={`${t('fields.energy')} · ${currency}`}>
                    <Input
                      inputMode="decimal"
                      value={form.energyText}
                      disabled={pending}
                      onChange={(e) => setField({ energyText: e.target.value })}
                    />
                  </Field>
                  <Field label={`${t('fields.packaging')} · ${currency}`}>
                    <Input
                      inputMode="decimal"
                      value={form.packagingText}
                      disabled={pending}
                      onChange={(e) => setField({ packagingText: e.target.value })}
                    />
                  </Field>
                </>
              )}
            </CardContent>
          </Card>

          {/* Kitchen presets — OPERATIONAL config, both roles manage name + weight; the
              per-preset cost preview is derived manager-side only from the live batch
              total + yield weight (never loaded from the server). */}
          <RecipePresets
            recipeId={recipe.id}
            presets={presets}
            onPresetsChange={setPresets}
            measurementSystem={measurementSystem}
            canSeeCosts={canSeeCosts}
            currency={currency}
            batchTotalCents={cost ? cost.totalCostCents : null}
            yieldWeightGrams={yieldWeightGramsLive}
          />
        </div>
      </div>

      {/* Cost breakdown + pricing are financial — managers only (Sprint F4).
          Two columns side by side. */}
      {cost && (
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>{t('cost.title')}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-sm">
              <Row label={t('cost.ingredients')} value={formatMoney(cost.ingredientCostCents, currency)} />
              <Row label={t('cost.hidden')} value={formatMoney(cost.hiddenCostCents, currency)} />
              <Row label={t('cost.total')} value={formatMoney(cost.totalCostCents, currency)} />
              <div className="my-1 border-t border-border" />
              <Row
                label={t('cost.perPortion')}
                value={formatMoney(cost.costPerPortionCents, currency)}
                strong
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('pricing.title')}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-sm">
              <Field label={`${t('pricing.sellingPrice')} · ${currency}`}>
                <Input
                  inputMode="decimal"
                  placeholder="0.00"
                  value={form.sellingText}
                  disabled={pending}
                  onChange={(e) => setField({ sellingText: e.target.value })}
                />
              </Field>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">{t('pricing.margin')}</span>
                {hasPrice ? (
                  <Badge variant={LIGHT_VARIANT[light]}>{margin}%</Badge>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    {t('pricing.noPrice')}
                  </span>
                )}
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">
                  {t('pricing.suggested', { margin: TARGET_MARGIN })}
                </span>
                <span className="flex items-center gap-2">
                  <span className="tabular-nums">
                    {formatMoney(suggested, currency)}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={pending || suggested <= 0}
                    onClick={() =>
                      setField({ sellingText: centsToAmountInput(suggested) })
                    }
                  >
                    {t('pricing.apply')}
                  </Button>
                </span>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        title={t('deleteConfirm.title')}
        description={t('deleteConfirm.body', { name: recipe.name })}
        confirmLabel={tCommon('moveToTrash')}
        cancelLabel={tCommon('cancel')}
        pending={pending}
        onConfirm={confirmDelete}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}

/** Compact dashboard-style metric tile for the batch summary strip. */
function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-3">
      <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 font-display text-lg font-semibold tabular-nums text-foreground">
        {value}
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-foreground">{label}</span>
      {children}
    </label>
  );
}

function Row({
  label,
  value,
  strong,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={
          strong
            ? 'font-display text-base font-semibold text-foreground tabular-nums'
            : 'tabular-nums text-foreground'
        }
      >
        {value}
      </span>
    </div>
  );
}
