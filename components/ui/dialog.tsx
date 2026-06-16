'use client';

import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cn } from '@/lib/utils';

/**
 * Radix dialog primitives themed for PrepProfit. Used exclusively for the ⌘K
 * command palette. `DialogContent` is a transparent positioning + animation
 * wrapper (top-anchored, scale+fade enter/exit) — the palette renders its own
 * stacked panels inside, so the surface/border/shadow live there, not here.
 * Radix Presence waits for animationend before unmounting.
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
        /* Position: horizontally centred, ~14 vh from top for visual balance */
        'fixed left-1/2 top-[14vh] z-50 -translate-x-1/2',
        'w-[calc(100%-2rem)] max-w-2xl text-foreground outline-none',
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
