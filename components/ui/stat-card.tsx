import { ArrowDown, ArrowUp, Minus, type LucideIcon } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

type DeltaTone = 'positive' | 'negative' | 'neutral';

export interface StatCardProps {
  label: string;
  value: string;
  /** Direction is independent of tone: e.g. food-cost % going *down* is positive. */
  delta?: { label: string; tone?: DeltaTone; direction?: 'up' | 'down' };
  caption?: string;
  icon?: LucideIcon;
  className?: string;
}

const deltaIcon = { up: ArrowUp, down: ArrowDown } as const;

export function StatCard({
  label,
  value,
  delta,
  caption,
  icon: Icon,
  className,
}: StatCardProps) {
  const DeltaIcon = delta?.direction ? deltaIcon[delta.direction] : Minus;

  return (
    <Card className={cn('flex flex-col gap-3 p-5', className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-muted-foreground">
          {label}
        </span>
        {Icon && (
          <span className="flex size-8 items-center justify-center rounded-lg bg-surface-2 text-accent-500">
            <Icon className="size-4" />
          </span>
        )}
      </div>

      <p className="font-display text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
        {value}
      </p>

      {(delta || caption) && (
        <div className="flex items-center gap-2">
          {delta && (
            <Badge variant={delta.tone ?? 'positive'}>
              <DeltaIcon className="size-3" aria-hidden />
              {delta.label}
            </Badge>
          )}
          {caption && (
            <span className="truncate text-xs text-muted-foreground">
              {caption}
            </span>
          )}
        </div>
      )}
    </Card>
  );
}
