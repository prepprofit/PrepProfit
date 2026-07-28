import * as React from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Styled native <select>. We use the native element (not a Radix listbox) so it
 * works without extra dependencies, stays accessible by default, and behaves well
 * inside forms and editable grids. Pass <option> children.
 *
 * Rest state matches {@link Input}: filled, borderless; the hairline appears on
 * hover/focus only.
 */
const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, children, ...props }, ref) => (
  <div className="relative">
    <select
      ref={ref}
      className={cn(
        'h-10 w-full cursor-pointer appearance-none rounded-lg border border-transparent bg-surface-2 px-3.5 pr-9 text-sm text-foreground transition-colors hover:border-border/60 focus-visible:border-border/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      {children}
    </select>
    <ChevronDown
      className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
      aria-hidden
    />
  </div>
));
Select.displayName = 'Select';

export { Select };
