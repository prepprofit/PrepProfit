'use client';

import * as React from 'react';
import { Info } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * A small, accessible "ⓘ" trigger for routine explanatory text that doesn't need to
 * stay permanently on screen (Sprint: ingredient editor decluttering). Click/tap OR
 * keyboard (Enter/Space) toggles it — never hover-only, so it works on tablets.
 * Dismissible via Escape, an outside click/tap, or activating the trigger again.
 * Actual errors and information required to complete an action are NOT routed
 * through this — only supplementary explanation.
 */
export function InfoPopover({
  label,
  children,
  className,
}: {
  /** Accessible name for the trigger button (e.g. "More information"). */
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLSpanElement>(null);
  const id = React.useId();

  React.useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <span ref={rootRef} className={cn('relative inline-flex', className)}>
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        className="flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
      >
        <Info className="size-3.5" aria-hidden />
      </button>
      {open && (
        <span
          id={id}
          role="note"
          className="absolute left-0 top-full z-10 mt-1.5 w-64 rounded-lg border border-border bg-surface px-3 py-2 text-xs font-normal text-muted-foreground shadow-lg"
        >
          {children}
        </span>
      )}
    </span>
  );
}
