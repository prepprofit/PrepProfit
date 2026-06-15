'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';

/**
 * A confirmation dialog built on the native HTML `<dialog>` element — no Radix.
 * `showModal()` gives us focus trapping, Escape-to-close, the top layer, and an
 * inert backdrop for free. Fully controlled: the parent owns `open` and decides
 * when to close (typically after the confirmed action resolves), so `pending`
 * can keep the buttons disabled while the work is in flight.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel,
  destructive = false,
  pending = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  destructive?: boolean;
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = React.useRef<HTMLDialogElement>(null);
  const titleId = React.useId();
  const descId = React.useId();

  // Drive the native open/closed state from the `open` prop.
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={descId}
      // Escape key emits `cancel`; route it through onCancel (unless mid-action).
      onCancel={(e) => {
        e.preventDefault();
        if (!pending) onCancel();
      }}
      // A click landing on the <dialog> itself is a backdrop click.
      onClick={(e) => {
        if (e.target === ref.current && !pending) onCancel();
      }}
      // m-auto restores modal centering (Tailwind preflight zeroes the UA margin).
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-2xl border border-border bg-surface p-0 text-foreground shadow-lg backdrop:bg-black/50 backdrop:backdrop-blur-sm"
    >
      <div className="flex flex-col gap-2 p-5">
        <h2 id={titleId} className="font-display text-lg font-semibold">
          {title}
        </h2>
        <p id={descId} className="text-sm text-muted-foreground">
          {description}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={pending}
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant={destructive ? 'destructive' : 'default'}
            onClick={onConfirm}
            disabled={pending}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
