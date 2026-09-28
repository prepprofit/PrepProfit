import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import type { ImportAllowance } from '@/lib/data/ai-usage';
import { cn } from '@/lib/utils';

/**
 * One compact line stating an AI import method's monthly allowance, shown beside that
 * method BEFORE the user starts processing ("Photo imports: 2 of 500 used this month ·
 * Resets Aug 1, 2026"). DISPLAY only — the upload route stays the cap authority, so this
 * never gates anything itself.
 *
 * The three non-normal states are told apart on purpose: an unknown allowance
 * (`allowance === null`) is never rendered as zero usage or unlimited; an exhausted one
 * says so plainly with the reset date; and "all remaining slots are in flight" is not
 * the same as "used up".
 */
export function ImportAllowanceLine({
  method,
  allowance,
  className,
}: {
  method: 'photo' | 'invoice';
  allowance: ImportAllowance | null;
  className?: string;
}) {
  const t = useTranslations('import.allowance');
  const format = useFormatter();
  const label = t(`method.${method}`);

  if (allowance === null) {
    return (
      <p className={cn('text-xs text-muted-foreground', className)} role="status">
        {t('unavailable', { label })}
      </p>
    );
  }

  const { used, limit, availableNow } = allowance;
  // Reset instants are UTC month starts — format in UTC so the date never shifts.
  const date = format.dateTime(new Date(allowance.resetAt), { dateStyle: 'long', timeZone: 'UTC' });

  if (limit <= 0) {
    return (
      <p className={cn('text-xs text-muted-foreground', className)} role="status">
        {t('notIncluded', { label })}
      </p>
    );
  }

  if (used >= limit) {
    return (
      <p className={cn('text-xs text-destructive', className)} role="alert">
        {t('exhausted', { label, used, limit, date })}{' '}
        <Link href="/billing" className="font-medium underline underline-offset-2">
          {t('managePlan')}
        </Link>
      </p>
    );
  }

  if (availableNow <= 0) {
    return (
      <p className={cn('text-xs text-amber-800 dark:text-amber-300', className)} role="status">
        {t('inFlight', { label, used, limit })}
      </p>
    );
  }

  return (
    <p className={cn('text-xs text-muted-foreground', className)}>
      {t('line', { label, used, limit })} · {t('resets', { date })}
    </p>
  );
}
