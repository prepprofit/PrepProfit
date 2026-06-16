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
  /**
   * Highlights the tile as the primary KPI: a solid accent (orange) surface with
   * a tinted glow, matching the "hero" card in the dashboard reference. Purely
   * cosmetic — the data and layout are unchanged.
   */
  featured?: boolean;
  className?: string;
}

const deltaIcon = { up: ArrowUp, down: ArrowDown } as const;

export function StatCard({
  label,
  value,
  delta,
  caption,
  icon: Icon,
  featured = false,
  className,
}: StatCardProps) {
  const DeltaIcon = delta?.direction ? deltaIcon[delta.direction] : Minus;

  return (
    <Card
      className={cn(
        'flex flex-col gap-3 p-5',
        featured &&
          'border-transparent bg-gradient-to-br from-accent-500 to-accent-600 text-white shadow-lg shadow-accent-500/30',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span
          className={cn(
            'text-sm font-medium',
            featured ? 'text-white/90' : 'text-muted-foreground',
          )}
        >
          {label}
        </span>
        {Icon && (
          <span
            className={cn(
              'flex size-8 items-center justify-center rounded-lg',
              featured
                ? 'bg-white/15 text-white'
                : 'bg-surface-2 text-accent-500',
            )}
          >
            <Icon className="size-4" />
          </span>
        )}
      </div>

      <p
        className={cn(
          'font-display text-2xl font-semibold tracking-tight tabular-nums sm:text-3xl',
          featured ? 'text-white' : 'text-foreground',
        )}
      >
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
            <span
              className={cn(
                'truncate text-xs',
                featured ? 'text-white/75' : 'text-muted-foreground',
              )}
            >
              {caption}
            </span>
          )}
        </div>
      )}
    </Card>
  );
}
