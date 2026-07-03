import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/card';

/** Browser-chrome frame used to present coded product mocks on the landing page. */
export function MockWindow({
  title,
  right,
  className,
  bodyClassName,
  children,
}: {
  title?: string;
  right?: ReactNode;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}) {
  return (
    <Card className={cn('relative overflow-hidden rounded-2xl', className)}>
      <div className="flex items-center justify-between gap-3 border-b border-border bg-surface-2/60 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <WindowDots />
          {title ? (
            <span className="text-[11px] font-medium text-muted-foreground">
              {title}
            </span>
          ) : null}
        </div>
        {right}
      </div>
      <div className={cn('p-4', bodyClassName)}>{children}</div>
    </Card>
  );
}

function WindowDots() {
  return (
    <div aria-hidden="true" className="flex items-center gap-1.5">
      <span className="h-2.5 w-2.5 rounded-full bg-red-400/80" />
      <span className="h-2.5 w-2.5 rounded-full bg-amber-300/80" />
      <span className="h-2.5 w-2.5 rounded-full bg-brand-400/80" />
    </div>
  );
}
