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
>(({ className, type, autoComplete = 'off', ...props }, ref) => (
  <input
    ref={ref}
    type={type}
    // Default OFF, overridable per field. Nothing in this app is a credential —
    // Clerk renders sign-in with its own components — so without this a password
    // manager reads a field like "Supplier code / SKU" as a login and offers to
    // fill or save it. A caller that genuinely wants autofill (a postal address,
    // say) passes its own value and wins: the default only applies when absent.
    autoComplete={autoComplete}
    className={cn(
      'h-10 w-full rounded-lg border border-transparent bg-surface-2 px-3.5 text-sm text-foreground transition-colors placeholder:text-muted-foreground hover:border-border/60 focus-visible:border-border/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50',
      className,
    )}
    {...props}
  />
));
Input.displayName = 'Input';

/**
 * Belt-and-braces for the managers that ignore `autoComplete="off"` — 1Password
 * and LastPass both do, on fields they decide look like a login. Spread onto the
 * inputs of dialogs that keep being mistaken for sign-in forms.
 */
export const IGNORE_PASSWORD_MANAGERS = {
  'data-1p-ignore': '',
  'data-lpignore': 'true',
} as const;

export { Input };
