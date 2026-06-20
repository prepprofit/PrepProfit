'use client';

import { useTranslations } from 'next-intl';
import { formatQuantity, type MeasurementSystem } from '@/lib/units';
import type { ImportRecipePayload } from '@/lib/import/types';

/**
 * Shared recipe-import preview pieces (Sprint 4.6, extracted in 4.7): the
 * per-ingredient RESOLUTION PANEL and the read-only RECIPE GRID. Reused verbatim by
 * BOTH the spreadsheet import workbench (`import-workbench.tsx`) and the AI photo
 * extraction workbench, so a fuzzy match is resolved the SAME way regardless of
 * origin (a fuzzy name defaults to "create new"; a link is always an explicit choice).
 */

/** Sentinel choice value meaning "stage a new ingredient" (vs an ingredient id). */
export const CREATE_NEW = '__new__';

/** Default each FUZZY name to "create new" — fuzzy matches are never auto-linked. */
export function initFuzzyChoices(
  payload: ImportRecipePayload | undefined,
): Record<string, string> {
  if (!payload) return {};
  const init: Record<string, string> = {};
  for (const [name, res] of Object.entries(payload.resolutions)) {
    if (res.kind === 'fuzzy') init[name] = CREATE_NEW;
  }
  return init;
}

/** Build the confirm `resolutions` payload from the fuzzy link choices. */
export function buildResolutions(
  choices: Record<string, string>,
): { name: string; action: 'link' | 'create'; ingredientId?: string }[] {
  return Object.entries(choices).map(([name, value]) =>
    value === CREATE_NEW
      ? { name, action: 'create' }
      : { name, action: 'link', ingredientId: value },
  );
}

/**
 * Per-distinct-ingredient resolution. EXACT names show their auto-link (read-only),
 * NEW names show "will be created (needs pricing)", and FUZZY names offer a radio
 * group of the suggested matches plus "create new" (the default) — the only place a
 * suggestion can be linked, and only by explicit choice.
 */
export function RecipeResolutionPanel({
  payload,
  choices,
  onChange,
}: {
  payload: ImportRecipePayload;
  choices: Record<string, string>;
  onChange: (name: string, value: string) => void;
}) {
  const t = useTranslations('import.recipes');
  const entries = Object.entries(payload.resolutions);
  const exactCount = entries.filter(([, r]) => r.kind === 'exact').length;
  const newCount = entries.filter(([, r]) => r.kind === 'new').length;
  const fuzzy = entries.filter(([, r]) => r.kind === 'fuzzy');

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm font-medium text-foreground">{t('resolve.title')}</p>
      <div className="flex flex-wrap gap-2 text-xs">
        {exactCount > 0 && (
          <Stat tone="good" label={t('resolve.linked', { count: exactCount })} />
        )}
        {newCount > 0 && (
          <Stat tone="muted" label={t('resolve.willCreate', { count: newCount })} />
        )}
        {fuzzy.length > 0 && (
          <Stat tone="bad" label={t('resolve.review', { count: fuzzy.length })} />
        )}
      </div>

      {fuzzy.length > 0 && (
        <ul className="flex flex-col gap-3">
          {fuzzy.map(([name, res]) => {
            if (res.kind !== 'fuzzy') return null;
            const selected = choices[name] ?? CREATE_NEW;
            return (
              <li
                key={name}
                className="flex flex-col gap-2 rounded-lg border border-border bg-surface-2/40 p-3"
              >
                <p className="text-sm font-medium text-foreground">
                  {t('resolve.forName', { name })}
                </p>
                <div className="flex flex-col gap-1.5">
                  {res.suggestions.map((s) => (
                    <label
                      key={s.ingredientId}
                      className="flex cursor-pointer items-center gap-2 text-sm text-foreground"
                    >
                      <input
                        type="radio"
                        name={`resolve-${name}`}
                        value={s.ingredientId}
                        checked={selected === s.ingredientId}
                        onChange={() => onChange(name, s.ingredientId)}
                        className="size-4 accent-accent-600"
                      />
                      <span>{s.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {t('resolve.match', { percent: Math.round(s.score * 100) })}
                      </span>
                    </label>
                  ))}
                  <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
                    <input
                      type="radio"
                      name={`resolve-${name}`}
                      value={CREATE_NEW}
                      checked={selected === CREATE_NEW}
                      onChange={() => onChange(name, CREATE_NEW)}
                      className="size-4 accent-accent-600"
                    />
                    <span>{t('resolve.createNew')}</span>
                  </label>
                </div>
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
