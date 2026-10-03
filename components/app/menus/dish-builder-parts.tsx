'use client';

import * as React from 'react';
import { MoreVertical, X } from 'lucide-react';
import type { DishCostKind } from '@/lib/calculations/dish';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

/** Small presentational pieces of the dish editor. No state beyond their own UI. */

export function Field({
  id,
  label,
  children,
  className,
  labelClassName,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
  className?: string;
  labelClassName?: string;
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <Label htmlFor={id} className={labelClassName}>
        {label}
      </Label>
      {children}
    </div>
  );
}

export function MoneyInput({
  id,
  value,
  currency,
  onChange,
  onBlur,
  invalid,
  disabled,
  placeholder = '0.00',
  size = 'md',
  ariaLabel,
  className,
}: {
  id: string;
  value: string;
  currency: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  invalid?: boolean;
  disabled?: boolean;
  placeholder?: string;
  /** 'lg' = the primary selling price (excl. VAT); 'sm' = quiet secondary fields; 'md' = everywhere else. */
  size?: 'sm' | 'md' | 'lg';
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <div className={cn('relative', className)}>
      <Input
        id={id}
        inputMode="decimal"
        autoComplete="off"
        value={value}
        placeholder={placeholder}
        aria-invalid={invalid}
        aria-label={ariaLabel}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        className={cn(
          'text-right tabular-nums',
          size === 'lg' && 'h-16 pr-16 font-display text-3xl font-semibold',
          size === 'md' && 'h-12 pr-14 text-base',
          size === 'sm' && 'h-11 pr-11 text-base',
        )}
      />
      <span
        className={cn(
          'pointer-events-none absolute top-1/2 -translate-y-1/2 text-muted-foreground',
          size === 'lg' ? 'right-4 text-base' : size === 'md' ? 'right-3.5 text-sm' : 'right-2.5 text-xs',
        )}
      >
        {currency}
      </span>
    </div>
  );
}

/**
 * Food / Packaging for one direct ingredient — an explicit choice, never guessed.
 * Unclassified shows both options unselected with an amber prompt.
 */
export function CostKindToggle({
  value,
  onChange,
  labels,
  name,
}: {
  value: DishCostKind | null;
  onChange: (kind: DishCostKind) => void;
  labels: { group: string; food: string; packaging: string; missing: string };
  name: string;
}) {
  const options: DishCostKind[] = ['food', 'packaging'];
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div
        role="radiogroup"
        aria-label={`${labels.group} — ${name}`}
        className={cn(
          'inline-flex rounded-full border bg-surface p-0.5 text-xs font-medium',
          value === null ? 'border-amber-400 dark:border-amber-500/60' : 'border-border',
        )}
      >
        {options.map((kind) => {
          const checked = value === kind;
          return (
            <button
              key={kind}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={checked || (value === null && kind === 'food') ? 0 : -1}
              data-kind={kind}
              onClick={() => onChange(kind)}
              onKeyDown={(e) => {
                if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
                  e.preventDefault();
                  const next = kind === 'food' ? 'packaging' : 'food';
                  onChange(next);
                  (e.currentTarget.parentElement?.querySelector(`[data-kind="${next}"]`) as HTMLButtonElement | null)?.focus();
                }
              }}
              className={cn(
                'relative rounded-full px-2.5 py-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                // Invisible hit-area extension keeps the tap target comfortable on a tablet.
                'before:absolute before:-inset-y-2 before:inset-x-0',
                checked ? 'bg-primary-soft text-primary-soft-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {kind === 'food' ? labels.food : labels.packaging}
            </button>
          );
        })}
      </div>
      {value === null ? <span className="text-xs text-amber-700 dark:text-amber-300">{labels.missing}</span> : null}
    </div>
  );
}

/** One recipe / direct-ingredient row: prominent name, quantity in the line's unit, small cost, small remove. */
export function LineRow({
  name,
  meta,
  footer,
  quantity,
  quantityInvalid,
  quantityLabel,
  unitLabel,
  onQuantity,
  onQuantityBlur,
  onQuantityEnter,
  quantityRef,
  cost,
  removeLabel,
  onRemove,
}: {
  name: string;
  meta?: React.ReactNode;
  footer?: React.ReactNode;
  quantity: string;
  quantityInvalid: boolean;
  quantityLabel: string;
  unitLabel: string;
  onQuantity: (value: string) => void;
  onQuantityBlur: () => void;
  onQuantityEnter: () => void;
  quantityRef: (el: HTMLInputElement | null) => void;
  cost: string;
  removeLabel: string;
  onRemove: () => void;
}) {
  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 basis-full flex-col gap-0.5 sm:basis-0 sm:flex-1">
          <span className="truncate text-[17px] font-semibold text-foreground">{name}</span>
          {meta ? <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">{meta}</span> : null}
        </div>
        <div className="flex items-center gap-1.5">
          <Input
            ref={quantityRef}
            inputMode="decimal"
            autoComplete="off"
            value={quantity}
            aria-label={quantityLabel}
            aria-invalid={quantityInvalid}
            onChange={(e) => onQuantity(e.target.value)}
            onBlur={onQuantityBlur}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                onQuantityEnter();
              }
            }}
            className="h-11 w-28 text-right text-base tabular-nums"
          />
          <span className="w-8 text-sm text-muted-foreground">{unitLabel}</span>
        </div>
        <span className="ml-auto w-20 text-right text-sm tabular-nums text-muted-foreground">{cost}</span>
        <Button
          type="button"
          variant="ghost"
          aria-label={removeLabel}
          onClick={onRemove}
          className="size-10 shrink-0 p-0"
        >
          <X />
        </Button>
      </div>
      {footer}
    </li>
  );
}

/** Small "⋮" menu (Make a copy / Delete dish) — no dropdown-menu package in the stack. */
export function OverflowMenu({
  open,
  onOpenChange,
  label,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  children: React.ReactNode;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!open) return;
    function onDocPointer(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onOpenChange(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onOpenChange(false);
    }
    document.addEventListener('mousedown', onDocPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onOpenChange]);

  return (
    <div ref={ref} className="relative">
      <Button
        type="button"
        variant="ghost"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => onOpenChange(!open)}
        className="size-10 p-0"
      >
        <MoreVertical />
      </Button>
      {open && (
        <div role="menu" className="absolute right-0 top-full z-30 mt-1 min-w-44 rounded-xl border border-border bg-surface p-1 shadow-lg">
          {children}
        </div>
      )}
    </div>
  );
}

export function OverflowMenuItem({
  onClick,
  disabled,
  title,
  destructive,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  destructive?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={cn(
        'flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent',
        destructive ? 'text-red-700 dark:text-red-300' : 'text-foreground',
      )}
    >
      {children}
    </button>
  );
}
