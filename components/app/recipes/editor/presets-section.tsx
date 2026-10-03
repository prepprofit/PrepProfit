'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, Plus, X } from 'lucide-react';
import { InfoPopover } from '@/components/app/recipes/workspace/info-popover';
import type { PresetProblem, PresetRow } from '@/lib/recipes/editor-model';
import { cn } from '@/lib/utils';

const fieldClass =
  'h-11 w-full rounded-lg border border-border bg-surface px-3 text-base text-foreground transition-colors placeholder:text-muted-foreground hover:border-muted-foreground/40 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/**
 * "Kitchen presets", collapsed by default: optional named target weights (e.g.
 * "18 cm cake — 450 g", "Individual portion — 44.5 g") that Kitchen Scale offers
 * for this recipe. Saved with the recipe; blank rows are simply ignored.
 */
export function PresetsSection({
  rows,
  onRowsChange,
  open,
  onOpenChange,
  problem,
}: {
  rows: PresetRow[];
  onRowsChange: (rows: PresetRow[]) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  problem: { key: string; problem: PresetProblem } | null;
}) {
  const t = useTranslations('recipes.editor.presets');
  const panelId = React.useId();
  const nameRefs = React.useRef(new Map<string, HTMLInputElement>());
  const focusKey = React.useRef<string | null>(null);
  const filled = rows.filter((r) => r.name.trim() !== '' || r.weightText.trim() !== '').length;

  React.useEffect(() => {
    const key = focusKey.current;
    if (!key) return;
    focusKey.current = null;
    nameRefs.current.get(key)?.focus();
  });

  const update = (key: string, patch: Partial<PresetRow>) => {
    onRowsChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };

  const add = () => {
    const key = `new-${crypto.randomUUID()}`;
    focusKey.current = key;
    onRowsChange([...rows, { key, name: '', weightText: '' }]);
    onOpenChange(true);
  };

  return (
    <section aria-labelledby={`${panelId}-title`} className="flex flex-col">
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => onOpenChange(!open)}
          className="-mx-2 flex min-h-11 flex-1 items-center gap-2 rounded-lg px-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span id={`${panelId}-title`} className="text-base font-semibold text-foreground">
            {t('title')}
          </span>
          <span className="text-sm text-muted-foreground">{filled > 0 ? t('count', { count: filled }) : t('optional')}</span>
          <ChevronDown className={cn('ml-auto size-4 text-muted-foreground transition-transform', open && 'rotate-180')} aria-hidden />
        </button>
        <InfoPopover label={t('infoLabel')}>{t('info')}</InfoPopover>
      </div>

      {open ? (
        <div id={panelId} className="flex flex-col gap-2 pt-3">
          {rows.length > 0 ? (
            <div className="hidden grid-cols-[1fr_9rem_2.75rem] gap-2 px-0.5 text-xs text-muted-foreground sm:grid" aria-hidden>
              <span>{t('name')}</span>
              <span>{t('weight')}</span>
              <span />
            </div>
          ) : null}
          <ul className="flex flex-col gap-2">
            {rows.map((row) => {
              const rowProblem = problem?.key === row.key ? problem.problem : null;
              const label = row.name.trim() || t('untitled');
              return (
                <li key={row.key} className="flex flex-col gap-1">
                  <div className="grid grid-cols-[1fr_7.5rem_2.75rem] items-center gap-2 sm:grid-cols-[1fr_9rem_2.75rem]">
                    <input
                      ref={(el) => {
                        if (el) nameRefs.current.set(row.key, el);
                        else nameRefs.current.delete(row.key);
                      }}
                      value={row.name}
                      maxLength={80}
                      placeholder={t('namePlaceholder')}
                      aria-label={t('name')}
                      aria-invalid={rowProblem === 'nameRequired' || rowProblem === 'duplicate'}
                      autoComplete="off"
                      onChange={(e) => update(row.key, { name: e.target.value })}
                      className={cn(fieldClass, (rowProblem === 'nameRequired' || rowProblem === 'duplicate') && 'border-red-500')}
                    />
                    <div className="relative">
                      <input
                        value={row.weightText}
                        inputMode="decimal"
                        placeholder={t('weightPlaceholder')}
                        aria-label={t('weightFor', { name: label })}
                        aria-invalid={rowProblem === 'weightRequired'}
                        autoComplete="off"
                        onChange={(e) => update(row.key, { weightText: e.target.value })}
                        className={cn(fieldClass, 'pr-8 text-right tabular-nums', rowProblem === 'weightRequired' && 'border-red-500')}
                      />
                      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">g</span>
                    </div>
                    <button
                      type="button"
                      aria-label={t('remove', { name: label })}
                      onClick={() => onRowsChange(rows.filter((r) => r.key !== row.key))}
                      className="inline-flex size-11 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:bg-red-50 hover:text-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:hover:bg-red-500/15 dark:hover:text-red-300"
                    >
                      <X className="size-4" aria-hidden />
                    </button>
                  </div>
                  {rowProblem ? (
                    <p role="alert" className="text-xs text-red-700 dark:text-red-300">
                      {t(`errors.${rowProblem}`)}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            onClick={add}
            className="inline-flex min-h-10 w-fit items-center gap-1.5 rounded-full px-2 text-sm font-medium text-accent-700 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-accent-300"
          >
            <Plus className="size-4" aria-hidden />
            {t('add')}
          </button>
        </div>
      ) : null}
    </section>
  );
}
