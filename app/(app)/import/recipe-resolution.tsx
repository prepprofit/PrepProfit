'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Check, Pencil, Plus, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { formatQuantity, type MeasurementSystem } from '@/lib/units';
import { normalizeIngredientName } from '@/lib/import/resolveIngredient';
import type { IngredientOption } from '@/lib/data/ingredients';
import type { ImportDimension, ImportRecipePayload } from '@/lib/import/types';

/**
 * Shared recipe-import preview pieces (Sprint 4.6; inline ingredient match added in
 * 4.7): the per-ingredient RESOLUTION PANEL and the read-only RECIPE GRID. Reused
 * verbatim by BOTH the spreadsheet import workbench (`import-workbench.tsx`) and the
 * AI photo extraction workbench, so a name is resolved the SAME way regardless of
 * origin.
 *
 * Sprint 4.7: every NON-exact name (`fuzzy` or `new`) starts UNRESOLVED and must be
 * resolved by the manager — link it to ANY active ingredient via an inline search
 * (suggestions seeded on top, then the full list) or explicitly create a new one.
 * Nothing is auto-created silently. The Confirm button stays blocked until there are
 * zero unresolved names and zero dimension-incompatible links; the server re-checks
 * both (`buildResolvedChoices` + `findResolutionDimensionMismatches`).
 */

/** Sentinel choice value meaning "stage a new ingredient" (vs an ingredient id). */
export const CREATE_NEW = '__new__';

/** Sentinel choice value meaning "the manager has not decided yet" (blocks Confirm). */
export const UNRESOLVED = '__unresolved__';

/** Per-name choice map: normalized name → `UNRESOLVED` | `CREATE_NEW` | ingredientId. */
export type ResolutionChoices = Record<string, string>;

/**
 * Seed every NON-exact name (`fuzzy` and `new`) to `UNRESOLVED` so the manager must
 * make an explicit choice. `exact` names are auto-linked server-side and never enter
 * the editable map.
 */
export function initResolutionChoices(
  payload: ImportRecipePayload | undefined,
): ResolutionChoices {
  if (!payload) return {};
  const init: ResolutionChoices = {};
  for (const [name, res] of Object.entries(payload.resolutions)) {
    if (res.kind === 'fuzzy' || res.kind === 'new') init[name] = UNRESOLVED;
  }
  return init;
}

/**
 * Build the confirm `resolutions` payload from the choice map. `UNRESOLVED` entries
 * are dropped (the UI blocks Confirm while any remain; the server defaults an absent
 * name to create as a backstop).
 */
export function buildResolutions(
  choices: ResolutionChoices,
): { name: string; action: 'link' | 'create'; ingredientId?: string }[] {
  return Object.entries(choices)
    .filter(([, value]) => value !== UNRESOLVED)
    .map(([name, value]) =>
      value === CREATE_NEW
        ? { name, action: 'create' as const }
        : { name, action: 'link' as const, ingredientId: value },
    );
}

/** Map each NON-exact name to the distinct dimensions of the lines that use it. */
function lineDimensionsByName(payload: ImportRecipePayload): Map<string, Set<ImportDimension>> {
  const byName = new Map<string, Set<ImportDimension>>();
  for (const recipe of payload.recipes) {
    for (const line of recipe.lines) {
      let dims = byName.get(line.normalizedName);
      if (!dims) {
        dims = new Set();
        byName.set(line.normalizedName, dims);
      }
      dims.add(line.dimension);
    }
  }
  return byName;
}

/** True when an ingredient's dimension cannot serve every line dimension of a name. */
function dimensionIncompatible(
  ingredientDimension: ImportDimension,
  lineDims: Set<ImportDimension> | undefined,
): boolean {
  if (!lineDims) return false;
  for (const d of lineDims) if (d !== ingredientDimension) return true;
  return false;
}

/** Count NON-exact names still `UNRESOLVED` (the Confirm-blocking metric). */
export function countUnresolved(
  payload: ImportRecipePayload | undefined,
  choices: ResolutionChoices,
): number {
  if (!payload) return 0;
  let n = 0;
  for (const [name, res] of Object.entries(payload.resolutions)) {
    if (res.kind === 'exact') continue;
    if ((choices[name] ?? UNRESOLVED) === UNRESOLVED) n += 1;
  }
  return n;
}

/**
 * Count link choices whose chosen ingredient measures in a dimension that conflicts
 * with the recipe line(s) — mirrors the server's `findResolutionDimensionMismatches`
 * so the UI blocks exactly what confirm would reject.
 */
export function countDimensionMismatches(
  payload: ImportRecipePayload | undefined,
  choices: ResolutionChoices,
  options: IngredientOption[],
): number {
  if (!payload) return 0;
  const dimById = new Map(options.map((o) => [o.id, o.dimension]));
  const lineDims = lineDimensionsByName(payload);
  let n = 0;
  for (const [name, res] of Object.entries(payload.resolutions)) {
    if (res.kind === 'exact') continue;
    const value = choices[name];
    if (!value || value === UNRESOLVED || value === CREATE_NEW) continue;
    const ingDim = dimById.get(value);
    if (ingDim === undefined) continue;
    if (dimensionIncompatible(ingDim, lineDims.get(name))) n += 1;
  }
  return n;
}

/** Filter+rank ingredient options by a normalized substring query (startsWith first). */
function searchOptions(
  indexed: { option: IngredientOption; norm: string }[],
  query: string,
  limit: number,
): IngredientOption[] {
  const q = normalizeIngredientName(query);
  if (q === '') return indexed.slice(0, limit).map((i) => i.option);
  const scored: { option: IngredientOption; starts: number; idx: number }[] = [];
  for (const { option, norm } of indexed) {
    const idx = norm.indexOf(q);
    if (idx === -1) continue;
    scored.push({ option, starts: idx === 0 ? 0 : 1, idx });
  }
  scored.sort(
    (a, b) => a.starts - b.starts || a.idx - b.idx || a.option.name.localeCompare(b.option.name),
  );
  return scored.slice(0, limit).map((s) => s.option);
}

const SEARCH_RESULT_LIMIT = 60;

/* -------------------------------------------------------------------------- */
/* Inline ingredient search dialog                                            */
/* -------------------------------------------------------------------------- */

function IngredientSearchDialog({
  open,
  onOpenChange,
  displayName,
  lineDims,
  suggestions,
  options,
  optionDimById,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  displayName: string;
  lineDims: Set<ImportDimension> | undefined;
  suggestions: { ingredientId: string; name: string; score: number }[];
  options: IngredientOption[];
  optionDimById: Map<string, ImportDimension>;
  onSelect: (value: string) => void;
}) {
  const t = useTranslations('import.recipes.resolve');
  const tDim = useTranslations('import.recipes.resolve.dimensions');
  const [query, setQuery] = useState('');

  // Normalize every option name once for this dialog instance.
  const indexed = useMemo(
    () => options.map((option) => ({ option, norm: normalizeIngredientName(option.name) })),
    [options],
  );
  const suggestionIds = useMemo(
    () => new Set(suggestions.map((s) => s.ingredientId)),
    [suggestions],
  );
  const results = useMemo(
    () => searchOptions(indexed, query, SEARCH_RESULT_LIMIT).filter((o) => !suggestionIds.has(o.id)),
    [indexed, query, suggestionIds],
  );

  function choose(value: string) {
    onSelect(value);
    onOpenChange(false);
    setQuery('');
  }

  function renderOption(
    option: { id: string; name: string; dimension: ImportDimension },
    score?: number,
  ) {
    const incompatible = dimensionIncompatible(option.dimension, lineDims);
    return (
      <CommandItem
        key={option.id}
        value={option.id}
        disabled={incompatible}
        onSelect={() => choose(option.id)}
        className="justify-between"
      >
        <span className="flex items-center gap-2">
          <span className="text-foreground">{option.name}</span>
          {typeof score === 'number' && (
            <span className="text-xs text-muted-foreground">
              {t('match', { percent: Math.round(score * 100) })}
            </span>
          )}
        </span>
        <span
          className={
            incompatible
              ? 'inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400'
              : 'text-xs text-muted-foreground'
          }
        >
          {incompatible && <AlertTriangle className="size-3" />}
          {incompatible ? t('dimensionMismatch') : tDim(option.dimension)}
        </span>
      </CommandItem>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <div className="flex flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-xl">
          <DialogTitle className="border-b border-border px-4 pt-3 text-sm font-medium text-foreground">
            {t('searchTitle', { name: displayName })}
          </DialogTitle>
          <div className="flex items-center gap-2 border-b border-border px-4">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <Command shouldFilter={false} className="gap-0">
              <CommandInput
                autoFocus
                value={query}
                onValueChange={setQuery}
                placeholder={t('searchPlaceholder')}
              />
              <CommandList>
                {suggestions.length > 0 && (
                  <CommandGroup heading={t('suggestions')}>
                    {suggestions.map((s) =>
                      renderOption(
                        { id: s.ingredientId, name: s.name, dimension: optionDimById.get(s.ingredientId) ?? 'count' },
                        s.score,
                      ),
                    )}
                  </CommandGroup>
                )}
                {results.length > 0 && (
                  <CommandGroup heading={t('allIngredients')}>
                    {results.map((o) => renderOption(o))}
                  </CommandGroup>
                )}
                {suggestions.length === 0 && results.length === 0 && (
                  <p className="px-3 py-3 text-sm text-muted-foreground">{t('noResults')}</p>
                )}
                <CommandGroup>
                  <CommandItem
                    value="__create__"
                    onSelect={() => choose(CREATE_NEW)}
                    className="text-accent-700 dark:text-accent-300"
                  >
                    <Plus className="size-4" />
                    {t('createNamed', { name: displayName })}
                  </CommandItem>
                </CommandGroup>
              </CommandList>
            </Command>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/* Resolution panel                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Per-distinct-ingredient resolution. EXACT names are auto-linked (counted only).
 * Each NON-exact name shows its current state and an inline search to link it to any
 * active ingredient or create a new one — fuzzy suggestions are seeded at the top of
 * that search. A bulk action resolves all remaining names to "create new".
 */
export function RecipeResolutionPanel({
  payload,
  choices,
  onChange,
  ingredientOptions,
}: {
  payload: ImportRecipePayload;
  choices: ResolutionChoices;
  onChange: (name: string, value: string) => void;
  ingredientOptions: IngredientOption[];
}) {
  const t = useTranslations('import.recipes.resolve');
  const tDim = useTranslations('import.recipes.resolve.dimensions');
  const [openName, setOpenName] = useState<string | null>(null);

  const entries = Object.entries(payload.resolutions);
  const editable = entries.filter(([, r]) => r.kind !== 'exact');
  const exactCount = entries.length - editable.length;

  const optionsById = useMemo(
    () => new Map(ingredientOptions.map((o) => [o.id, o])),
    [ingredientOptions],
  );
  const optionDimById = useMemo(
    () => new Map(ingredientOptions.map((o) => [o.id, o.dimension])),
    [ingredientOptions],
  );
  const lineDims = useMemo(() => lineDimensionsByName(payload), [payload]);
  const rawNameByNorm = useMemo(() => {
    const m = new Map<string, string>();
    for (const recipe of payload.recipes) {
      for (const line of recipe.lines) {
        if (!m.has(line.normalizedName)) m.set(line.normalizedName, line.ingredientName);
      }
    }
    return m;
  }, [payload]);

  const unresolved = countUnresolved(payload, choices);
  const linkedCount =
    exactCount + editable.filter(([n]) => choices[n] && choices[n] !== UNRESOLVED && choices[n] !== CREATE_NEW).length;
  const createCount = editable.filter(([n]) => choices[n] === CREATE_NEW).length;

  function resolveAllNew() {
    for (const [name] of editable) {
      if ((choices[name] ?? UNRESOLVED) === UNRESOLVED) onChange(name, CREATE_NEW);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm font-medium text-foreground">{t('title')}</p>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        {linkedCount > 0 && <Stat tone="good" label={t('linked', { count: linkedCount })} />}
        {createCount > 0 && <Stat tone="muted" label={t('willCreate', { count: createCount })} />}
        {unresolved > 0 && <Stat tone="bad" label={t('unresolved', { count: unresolved })} />}
        {unresolved > 0 && (
          <Button variant="outline" size="sm" onClick={resolveAllNew}>
            <Plus className="size-3.5" />
            {t('createAllNew', { count: unresolved })}
          </Button>
        )}
      </div>

      {editable.length > 0 && (
        <ul className="flex flex-col gap-2">
          {editable.map(([name, res]) => {
            const value = choices[name] ?? UNRESOLVED;
            const displayName = rawNameByNorm.get(name) ?? name;
            const suggestions = res.kind === 'fuzzy' ? res.suggestions : [];

            const linked = value !== UNRESOLVED && value !== CREATE_NEW ? optionsById.get(value) : undefined;
            const isMismatch = linked ? dimensionIncompatible(linked.dimension, lineDims.get(name)) : false;
            const state: 'unresolved' | 'create' | 'linked' =
              value === UNRESOLVED ? 'unresolved' : value === CREATE_NEW ? 'create' : 'linked';

            return (
              <li
                key={name}
                className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 ${
                  state === 'unresolved' || isMismatch
                    ? 'border-amber-400/70 bg-amber-50/40 dark:bg-amber-500/5'
                    : 'border-border bg-surface-2/40'
                }`}
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate text-sm font-medium text-foreground">{displayName}</span>
                  {state === 'unresolved' && (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-300">
                      <AlertTriangle className="size-3" />
                      {t('stateUnresolved')}
                    </span>
                  )}
                  {state === 'create' && (
                    <span className="text-xs text-muted-foreground">
                      {t('willCreateNamed', { name: displayName })}
                    </span>
                  )}
                  {state === 'linked' &&
                    (isMismatch ? (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-300">
                        <AlertTriangle className="size-3" />
                        {t('dimensionMismatch')} · {linked ? tDim(linked.dimension) : ''}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-300">
                        <Check className="size-3" />
                        {t('linkedTo', { name: linked?.name ?? '' })}
                      </span>
                    ))}
                </div>

                <Button
                  variant={state === 'unresolved' || isMismatch ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setOpenName(name)}
                >
                  {state === 'unresolved' ? (
                    <>
                      <Search className="size-3.5" />
                      {t('edit')}
                    </>
                  ) : (
                    <>
                      <Pencil className="size-3.5" />
                      {t('change')}
                    </>
                  )}
                </Button>

                <IngredientSearchDialog
                  open={openName === name}
                  onOpenChange={(o) => setOpenName(o ? name : null)}
                  displayName={displayName}
                  lineDims={lineDims.get(name)}
                  suggestions={suggestions}
                  options={ingredientOptions}
                  optionDimById={optionDimById}
                  onSelect={(v) => onChange(name, v)}
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** The staged recipes with their grouped ingredient lines (read-only preview). */
export function RecipeGrid({
  payload,
  measurementSystem,
}: {
  payload: ImportRecipePayload;
  measurementSystem: MeasurementSystem;
}) {
  const t = useTranslations('import.recipes');
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm font-medium text-foreground">{t('grid.title')}</p>
      <div className="flex flex-col gap-3">
        {payload.recipes.map((recipe, i) => (
          <div key={i} className="rounded-lg border border-border">
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border bg-surface-2/50 px-3 py-2">
              <span className="text-sm font-medium text-foreground">{recipe.name}</span>
              <span className="text-xs text-muted-foreground">
                {t('grid.yield', {
                  portions: recipe.yieldPortions,
                  percent: recipe.yieldPercentage,
                })}
              </span>
            </div>
            {recipe.lines.length > 0 ? (
              <ul className="divide-y divide-border">
                {recipe.lines.map((line, j) => (
                  <li
                    key={j}
                    className="flex items-center justify-between gap-3 px-3 py-1.5 text-sm"
                  >
                    <span className="text-foreground">{line.ingredientName}</span>
                    <span className="tabular-nums text-muted-foreground">
                      {formatQuantity(line.quantityCanonical, line.dimension, measurementSystem)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-3 py-2 text-xs text-muted-foreground">{t('grid.noLines')}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export function Stat({ tone, label }: { tone: 'good' | 'bad' | 'muted'; label: string }) {
  const toneClass =
    tone === 'good'
      ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300'
      : tone === 'bad'
        ? 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300'
        : 'bg-surface-2 text-muted-foreground';
  return (
    <span className={`rounded-full px-3 py-1 text-xs font-medium ${toneClass}`}>
      {label}
    </span>
  );
}
