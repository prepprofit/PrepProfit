'use client';

import { cn } from '@/lib/utils';

/**
 * The confirmation/undo pill — extracted from the pattern already proven in
 * components/app/ingredients/ingredient-grid.tsx (fixed bottom-center,
 * `bg-foreground`/`text-background`, underlined Undo, × dismiss). Callers own
 * their own `notice` state and auto-dismiss timer locally (as ingredient-grid
 * does) — this is only the presentational bar, not a global provider, so it
 * stays consistent with how the rest of the app already does transient
 * confirmations.
 */
export function Toast({
  message,
  isError = false,
  undoLabel,
  onUndo,
  undoDisabled = false,
  dismissLabel,
  onDismiss,
}: {
  message: string;
  isError?: boolean;
  /** Omit both `undoLabel`/`onUndo` when the action has no undo. */
  undoLabel?: string;
  onUndo?: () => void;
  undoDisabled?: boolean;
  dismissLabel: string;
  onDismiss: () => void;
}) {
  return (
    <div
      role={isError ? 'alert' : 'status'}
      className={cn(
        'fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-xl px-4 py-3 text-sm shadow-lg',
        isError ? 'bg-red-700 text-white' : 'bg-foreground text-background',
      )}
    >
      <span>{message}</span>
      {undoLabel && onUndo && (
        <button
          type="button"
          disabled={undoDisabled}
          onClick={onUndo}
          className="cursor-pointer font-semibold underline underline-offset-2 disabled:opacity-60"
        >
          {undoLabel}
        </button>
      )}
      <button
        type="button"
        aria-label={dismissLabel}
        onClick={onDismiss}
        className="cursor-pointer opacity-70 hover:opacity-100"
      >
        ×
      </button>
    </div>
  );
}
