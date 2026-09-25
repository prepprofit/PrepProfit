'use client';

import * as React from 'react';
import { MoreHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';

export type FolderMenuItem = {
  label: string;
  icon: React.ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  destructive?: boolean;
};

/**
 * The small "⋯" button on a folder tile (generalized from the original
 * recipe-home.tsx implementation for reuse across sections). Closes on an
 * outside click, Escape, or a choice. Positioned by the caller (a
 * `<div className="relative">` wrapping this + a `FolderTile` sibling).
 */
export function FolderMenu({
  label,
  items,
  disabled,
}: {
  label: string;
  items: FolderMenuItem[];
  disabled: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="absolute right-1 top-1/2 -translate-y-1/2">
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex size-7 cursor-pointer items-center justify-center rounded-lg text-muted-foreground/70 transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
      >
        <MoreHorizontal className="size-4" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-20 mt-1 flex w-48 flex-col rounded-xl border border-border bg-surface p-1 shadow-lg"
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              className={cn(
                'flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-surface-2 disabled:pointer-events-none disabled:opacity-40',
                item.destructive ? 'text-red-700 dark:text-red-300' : 'text-foreground',
              )}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
