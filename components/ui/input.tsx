import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Text input. At REST it is a quiet filled field with no visible border — the
 * hairline only appears on hover/focus, so a screen full of inputs reads as content
 * instead of as a spreadsheet. The `surface-2` fill keeps the field discoverable
 * (DESIGN.md §6) without drawing a box around every value.
 */
const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, type, ...props }, ref) => (
  <input
    ref={ref}
    type={type}
    className={cn(
      'h-10 w-full rounded-lg border border-transparent bg-surface-2 px-3.5 text-sm text-foreground transition-colors placeholder:text-muted-foreground hover:border-border/60 focus-visible:border-border/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50',
      className,
    )}
    {...props}
  />
));
Input.displayName = 'Input';

export { Input };
