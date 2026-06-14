import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
  {
    variants: {
      variant: {
        // profit / positive — emerald is reserved for "good number" (DESIGN.md §4)
        positive:
          'bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300',
        warning:
          'bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
        negative:
          'bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300',
        neutral: 'bg-surface-2 text-muted-foreground',
        accent:
          'bg-accent-50 text-accent-700 dark:bg-accent-500/15 dark:text-accent-300',
      },
    },
    defaultVariants: {
      variant: 'neutral',
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant, className }))} {...props} />
  );
}

export { Badge, badgeVariants };
