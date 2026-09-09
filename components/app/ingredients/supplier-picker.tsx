'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Check, ChevronDown, Plus, Search } from 'lucide-react';
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { cn } from '@/lib/utils';

/**
 * Searchable supplier picker for the ingredient supplier dialog.
 *
 * Replaces an `<input list>` + `<datalist>`. A datalist shows NOTHING until the
 * manager types and only ever offers what matches the typed prefix, so a supplier
 * that exists looks absent — the data was always right, the widget was wrong.
 * Here the org's full list is visible the moment the picker opens.
 *
 * Free text is still first-class: `findOrCreateSupplierByName` creates on save, so
 * a name that matches nothing is offered as "use this name" rather than blocked.
 * There is deliberately no separate create action.
 *
 * The panel expands IN FLOW rather than floating: the dialog body is a scroll
 * container, and an absolutely positioned list would be clipped by it.
 */
export function SupplierPicker({
  id,
  value,
  options,
  disabled,
  invalid,
  describedBy,
  onChange,
}: {
  id: string;
  /** The chosen name — free text, not necessarily one of `options`. */
  value: string;
  /** The org's active supplier names. */
  options: string[];
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
  onChange: (name: string) => void;
}) {
  const t = useTranslations('suppliers.ingredientEditor');
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const listId = React.useId();

  const typed = query.trim();
  const exactMatch = options.some((o) => o.toLowerCase() === typed.toLowerCase());

  const choose = (name: string) => {
    onChange(name);
    setQuery('');
    setOpen(false);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <button
        id={id}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-describedby={describedBy}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex h-10 w-full items-center justify-between gap-2 rounded-lg border border-transparent bg-surface-2 px-3.5 text-left text-sm text-foreground transition-colors hover:border-border/60 focus-visible:border-border/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50',
          invalid && 'border-red-400 dark:border-red-500/60',
        )}
      >
        <span className={cn('truncate', value === '' && 'text-muted-foreground')}>
          {value === '' ? t('supplierPlaceholder') : value}
        </span>
        <ChevronDown
          className={cn(
            'size-4 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>

      {open && (
        <div
          className="overflow-hidden rounded-lg border border-border bg-surface"
          // Escape closes the picker, not the whole dialog — the native <dialog>
          // would otherwise swallow the key and discard the form.
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
            }
          }}
        >
          <Command className="gap-0">
            <div className="flex items-center gap-2 border-b border-border px-3">
              <Search className="size-4 shrink-0 text-muted-foreground" />
              <CommandInput
                autoFocus
                value={query}
                onValueChange={setQuery}
                placeholder={t('supplierSearchPlaceholder')}
                className="h-10 text-sm"
              />
            </div>
            <CommandList id={listId} className="max-h-56">
              {options.length > 0 && (
                <CommandGroup>
                  {options.map((name) => (
                    <CommandItem
                      key={name}
                      value={name}
                      onSelect={() => choose(name)}
                      className="justify-between"
                    >
                      <span className="truncate">{name}</span>
                      {name === value && <Check className="size-4 shrink-0" />}
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
              {typed !== '' && !exactMatch && (
                <CommandGroup>
                  <CommandItem
                    // Prefixed so a supplier literally named like the query can't
                    // collide with this row's cmdk value.
                    value={`__create__${typed}`}
                    onSelect={() => choose(typed)}
                    className="text-accent-700 dark:text-accent-300"
                  >
                    <Plus className="size-4 shrink-0" />
                    <span className="truncate">{t('supplierCreate', { name: typed })}</span>
                  </CommandItem>
                </CommandGroup>
              )}
              {options.length === 0 && typed === '' && (
                <p className="px-3 py-3 text-sm text-muted-foreground">
                  {t('supplierEmpty')}
                </p>
              )}
            </CommandList>
          </Command>
        </div>
      )}
    </div>
  );
}
