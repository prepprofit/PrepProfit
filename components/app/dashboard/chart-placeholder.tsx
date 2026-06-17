import { BarChart3 } from 'lucide-react';
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
 * A dashboard chart tile that has no data yet. Charts (and the chart library)
 * land in Sprint 2 once the `transactions` table exists, so this shows an honest
 * empty state — NOT a decorative skeleton that implies real figures. The bento
 * layout is final now; only the inner viz is swapped in later.
 */
export function ChartPlaceholder({
  title,
  description,
  note,
  emptyLabel,
  className,
}: {
  title: string;
  description?: string;
  note: string;
  emptyLabel: string;
  className?: string;
}) {
  return (
    <Card className={cn('flex flex-col', className)}>
      <CardHeader className="flex-row items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <CardTitle>{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </div>
        <Badge variant="neutral">{note}</Badge>
      </CardHeader>
      <CardContent className="flex h-44 flex-col items-center justify-center gap-2 text-center">
        <span className="flex size-10 items-center justify-center rounded-xl bg-surface-2 text-muted-foreground">
          <BarChart3 className="size-5" aria-hidden />
        </span>
        <p className="text-sm text-muted-foreground">{emptyLabel}</p>
      </CardContent>
    </Card>
  );
}
