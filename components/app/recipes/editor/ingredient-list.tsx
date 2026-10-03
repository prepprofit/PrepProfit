'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { GripVertical, X } from 'lucide-react';
import type { WeightDisplayUnit } from '@/lib/format/weight';
import {
  applyLineAmount,
  canonicalQuantity,
  lineQuantityText,
  lineUnitLabel,
  moveLine,
  parseAmount,
  type DraftLine,
  type LineUom,
} from '@/lib/recipes/editor-model';
import { cn } from '@/lib/utils';

/**
 * The editor's ingredient rows: drag handle · ingredient name · quantity · remove.
 * Weight rows follow the shared g/kg switch; ml, pieces and other typed units keep
 * their own compact label and are never reinterpreted as grams. Reorder by dragging
 * the handle (mouse, pen or touch) or, from the focused handle, with the arrow keys.
 */
export function IngredientRows({
  lines,
  displayUnit,
  lineUom,
  invalidKey,
  onLinesChange,
  registerQuantity,
  onQuantityEnter,
  onRemoved,
  announce,
}: {
  lines: DraftLine[];
  displayUnit: WeightDisplayUnit;
  lineUom: Record<string, LineUom>;
  /** A row the last save attempt flagged (e.g. a sub-recipe without a weight). */
  invalidKey: string | null;
  onLinesChange: (lines: DraftLine[]) => void;
  registerQuantity: (key: string, el: HTMLInputElement | null) => void;
  onQuantityEnter: () => void;
  /** Called after a row is removed with the key of the row that should take focus (null = none left). */
  onRemoved: (nextKey: string | null) => void;
  announce: (message: string) => void;
}) {
  const t = useTranslations('recipes.editor.ingredients');
  const [draggingKey, setDraggingKey] = React.useState<string | null>(null);
  const handleRefs = React.useRef(new Map<string, HTMLButtonElement>());
  const focusAfterMove = React.useRef<string | null>(null);
  const helpId = React.useId();

  React.useEffect(() => {
    const key = focusAfterMove.current;
    if (!key) return;
    focusAfterMove.current = null;
    handleRefs.current.get(key)?.focus();
  });

  const move = (from: number, to: number) => {
    const next = moveLine(lines, from, to);
    if (next === lines) return;
    onLinesChange(next);
    const moved = next[to]!;
    announce(t('moved', { name: moved.name, position: to + 1, total: next.length }));
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!draggingKey) return;
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-line-key]');
    const overKey = over?.dataset.lineKey;
    if (!overKey || overKey === draggingKey) return;
    const next = moveLine(
      lines,
      lines.findIndex((l) => l.key === draggingKey),
      lines.findIndex((l) => l.key === overKey),
    );
    if (next !== lines) onLinesChange(next);
  };

  const update = (key: string, next: DraftLine) => {
    onLinesChange(lines.map((l) => (l.key === key ? next : l)));
  };

  return (
    <>
      <ul className="flex flex-col">
        {lines.map((line, index) => {
          const uom = line.kind === 'ingredient' ? lineUom[line.ingredientId] : undefined;
          const prepActions = uom?.prepActions ?? [];
          const flagged = invalidKey === line.key;
          return (
            <li
              key={line.key}
              data-line-key={line.key}
              className={cn(
                'flex items-center gap-2 border-b border-border/70 py-3 last:border-b-0 sm:gap-3',
                draggingKey === line.key && 'rounded-lg bg-accent-50 ring-1 ring-accent-300 dark:bg-accent-500/10',
              )}
            >
              <button
                type="button"
                ref={(el) => {
                  if (el) handleRefs.current.set(line.key, el);
                  else handleRefs.current.delete(line.key);
                }}
                aria-label={t('reorder', { name: line.name })}
                aria-describedby={helpId}
                className="-ml-2 inline-flex h-11 w-8 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-muted-foreground/70 hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  setDraggingKey(line.key);
                }}
                onPointerMove={onPointerMove}
                onPointerUp={() => setDraggingKey(null)}
                onPointerCancel={() => setDraggingKey(null)}
                onKeyDown={(e) => {
                  const to =
                    e.key === 'ArrowUp'
                      ? index - 1
                      : e.key === 'ArrowDown'
                        ? index + 1
                        : e.key === 'Home'
                          ? 0
                          : e.key === 'End'
                            ? lines.length - 1
                            : null;
                  if (to === null) return;
                  e.preventDefault();
                  focusAfterMove.current = line.key;
                  move(index, to);
                }}
              >
                <GripVertical className="size-4" aria-hidden />
              </button>

              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="break-words text-[19px] font-medium leading-snug text-foreground sm:text-[21px]">
                  {line.name}
                </span>
                {line.kind === 'component' || line.note || prepActions.length > 0 ? (
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    {line.kind === 'component' ? (
                      <span className="rounded bg-surface-2 px-1.5 py-0.5">{t('subRecipe')}</span>
                    ) : null}
                    {line.kind === 'ingredient' && prepActions.length > 0 ? (
                      <select
                        value={line.prepActionId ?? ''}
                        aria-label={t('prep', { name: line.name })}
                        onChange={(e) =>
                          update(line.key, {
                            ...line,
                            prepActionId: e.target.value === '' ? null : e.target.value,
                          })
                        }
                        className="h-7 rounded-md border border-border bg-surface px-1.5 text-xs text-foreground"
                      >
                        <option value="">{t('noPrep')}</option>
                        {prepActions.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    ) : null}
                    {line.note ? <span className="truncate">{line.note}</span> : null}
                  </span>
                ) : null}
                {flagged ? (
                  <span className="text-xs font-medium text-red-700 dark:text-red-300">{t('needsWeight')}</span>
                ) : null}
              </div>

              <QuantityInput
                line={line}
                displayUnit={displayUnit}
                flagged={flagged}
                inputRef={(el) => registerQuantity(line.key, el)}
                ariaLabel={t('quantity', { name: line.name })}
                invalidLabel={t('quantityInvalid')}
                onAmount={(amount) => {
                  const next = applyLineAmount(line, amount, displayUnit, uom);
                  if (next) update(line.key, next);
                  return next !== null;
                }}
                onEnter={onQuantityEnter}
              />
              <span className="w-8 shrink-0 text-sm text-muted-foreground" aria-hidden>
                {lineUnitLabel(line, displayUnit)}
              </span>

              <button
                type="button"
                aria-label={t('remove', { name: line.name })}
                onClick={() => {
                  const next = lines.filter((l) => l.key !== line.key);
                  onLinesChange(next);
                  onRemoved((next[index] ?? next[index - 1])?.key ?? null);
                }}
                className="-mr-2 inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:bg-red-50 hover:text-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:hover:bg-red-500/15 dark:hover:text-red-300"
              >
                <X className="size-4" aria-hidden />
              </button>
            </li>
          );
        })}
      </ul>
      <p id={helpId} className="sr-only">
        {t('reorderHelp')}
      </p>
    </>
  );
}

/**
 * Keeps exactly what the cook types ("0,", "1.5", "") while focused and reports a
 * number only when the text is a valid amount; shows the formatted quantity in the
 * current unit otherwise, so a g/kg switch re-renders it without touching the value.
 */
function QuantityInput({
  line,
  displayUnit,
  flagged,
  inputRef,
  ariaLabel,
  invalidLabel,
  onAmount,
  onEnter,
}: {
  line: DraftLine;
  displayUnit: WeightDisplayUnit;
  flagged: boolean;
  inputRef: (el: HTMLInputElement | null) => void;
  ariaLabel: string;
  invalidLabel: string;
  onAmount: (amount: number) => boolean;
  onEnter: () => void;
}) {
  const shown = canonicalQuantity(line) > 0 ? lineQuantityText(line, displayUnit) : '';
  const [text, setText] = React.useState(shown);
  const [focused, setFocused] = React.useState(false);
  const [invalid, setInvalid] = React.useState(false);

  React.useEffect(() => {
    if (!focused) {
      setText(shown);
      setInvalid(false);
    }
  }, [shown, focused]);

  return (
    <input
      ref={inputRef}
      value={text}
      inputMode="decimal"
      autoComplete="off"
      placeholder="0"
      aria-label={ariaLabel}
      aria-invalid={invalid || flagged}
      title={invalid ? invalidLabel : undefined}
      onFocus={(e) => {
        setFocused(true);
        e.currentTarget.select();
      }}
      onBlur={() => {
        setFocused(false);
        setText(shown);
        setInvalid(false);
      }}
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw);
        if (raw.trim() === '') {
          setInvalid(false);
          return;
        }
        const amount = parseAmount(raw);
        setInvalid(amount === null || !onAmount(amount));
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onEnter();
        }
      }}
      className={cn(
        'h-11 w-24 shrink-0 rounded-lg border border-border bg-surface px-3 text-right text-lg tabular-nums text-foreground transition-colors placeholder:text-muted-foreground/50 hover:border-muted-foreground/40 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-28',
        (invalid || flagged) && 'border-red-500 focus-visible:ring-red-500',
      )}
    />
  );
}
