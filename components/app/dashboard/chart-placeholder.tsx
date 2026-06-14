import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/**
 * Placeholder for a dashboard chart. Charts (and the chart library) land in
 * Sprint 2 — this renders the bento tile + a skeleton so the layout is final
 * now and only the inner viz is swapped later. Deterministic bar heights keep
 * it SSR-stable; the pulse is gated behind `motion-safe`.
 */
export function ChartPlaceholder({
  title,
  description,
  note,
  bars = 9,
  className,
}: {
  title: string;
  description?: string;
  note: string;
  bars?: number;
  className?: string;
}) {
  const highlight = Math.floor(bars / 2);

  return (
    <Card className={cn('flex flex-col', className)}>
      <CardHeader className="flex-row items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <CardTitle className="text-base">{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </div>
        <Badge variant="neutral">{note}</Badge>
      </CardHeader>
      <CardContent className="flex h-44 items-end gap-2">
        {Array.from({ length: bars }).map((_, i) => (
          <div
            key={i}
            className={cn(
              'flex-1 rounded-t-md motion-safe:animate-pulse',
              i === highlight ? 'bg-accent-500/60' : 'bg-surface-2',
            )}
            style={{ height: `${30 + ((i * 37) % 65)}%` }}
            aria-hidden
          />
        ))}
      </CardContent>
    </Card>
  );
}
