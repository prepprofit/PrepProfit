import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const cardVariants = cva(
  'rounded-xl border text-foreground transition',
  {
    variants: {
      variant: {
        default: 'border-border bg-surface shadow-sm',
        // Frosted surface for floating / highlighted tiles — light keeps a high
        // opacity so text stays readable (see DESIGN.md glass tokens).
        glass: 'border-glass-border bg-glass shadow-sm backdrop-blur-xl',
      },
      interactive: {
        true: 'cursor-pointer hover:-translate-y-0.5 hover:shadow-md',
        false: '',
      },
    },
    defaultVariants: {
      variant: 'default',
      interactive: false,
    },
  },
);

interface CardProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof cardVariants> {}

function Card({ className, variant, interactive, ...props }: CardProps) {
  return (
    <div
      className={cn(cardVariants({ variant, interactive, className }))}
      {...props}
    />
  );
}

function CardHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-1 p-6', className)} {...props} />;
}

function CardTitle({
  className,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3
      className={cn(
        'font-display text-base font-semibold text-foreground',
        className,
      )}
      {...props}
    />
  );
}

function CardDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p className={cn('text-sm text-muted-foreground', className)} {...props} />
  );
}

function CardContent({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-6 pt-0', className)} {...props} />;
}

export {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  cardVariants,
};
