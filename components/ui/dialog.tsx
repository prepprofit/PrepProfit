'use client';

import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cn } from '@/lib/utils';

/**
 * Radix dialog primitives themed for PrepProfit. Used exclusively for the ⌘K
 * command palette. Content is top-anchored (20 vh) with a scale+fade enter/exit
 * animation; Radix Presence waits for animationend before unmounting.
 */
const Dialog = DialogPrimitive.Root;
const DialogPortal = DialogPrimitive.Portal;
const DialogTitle = DialogPrimitive.Title;
const DialogDescription = DialogPrimitive.Description;

const DialogOverlay = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      'fixed inset-0 z-50 bg-slate-950/50 backdrop-blur-sm',
      'data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out',
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        /* Position: horizontally centred, 20 vh from top for visual balance */
        'fixed left-1/2 top-[20vh] z-50 -translate-x-1/2',
        'w-[calc(100%-2rem)] max-w-2xl',
        /* Surface */
        'overflow-hidden rounded-2xl border border-border bg-surface text-foreground',
        /* Shadow: deep layered + subtle top highlight */
        'shadow-[0_20px_60px_-12px_rgba(0,0,0,0.28),0_4px_16px_-4px_rgba(0,0,0,0.12),inset_0_1px_0_rgba(255,255,255,0.06)]',
        'dark:shadow-[0_20px_60px_-12px_rgba(0,0,0,0.65),0_4px_16px_-4px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.04)]',
        'outline-none',
        /* Enter/exit animation — Radix Presence awaits animationend */
        'data-[state=open]:animate-palette-in data-[state=closed]:animate-palette-out',
        className,
      )}
      {...props}
    >
      {children}
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogTitle,
  DialogDescription,
};
