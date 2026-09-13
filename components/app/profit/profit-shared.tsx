'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import type { Verdict } from '@/lib/calculations/profit-hour';
import { centsToAmountInput } from '@/lib/format/money';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';

/** Shared pieces of the Profit section (Hour Engine) client components. */

export type VerdictOrIncomplete = Verdict | 'incomplete';

const VERDICT_VARIANT: Record<VerdictOrIncomplete, NonNullable<BadgeProps['variant']>> = {
  hero: 'positive',
  solid: 'accent',
  fragile: 'warning',
  losing: 'negative',
  incomplete: 'neutral',
};

export function VerdictBadge({ verdict }: { verdict: VerdictOrIncomplete }) {
  const t = useTranslations('profit.verdict');
  return <Badge variant={VERDICT_VARIANT[verdict]}>{t(verdict)}</Badge>;
}

/** Text colour for a €/hour figure, by verdict. */
export const VERDICT_TEXT: Record<VerdictOrIncomplete, string> = {
  hero: 'text-brand-700 dark:text-brand-300',
  solid: 'text-foreground',
  fragile: 'text-amber-700 dark:text-amber-300',
  losing: 'text-red-700 dark:text-red-300',
  incomplete: 'text-muted-foreground',
};

export function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Cents → editable amount; 0 shows as an empty field so placeholders read "0". */
export function centsToField(cents: number | null | undefined): string {
  return cents ? centsToAmountInput(cents) : '';
}

/** A typed decimal ("1,5" or "1.5") → number; empty or invalid → null. */
export function parseDecimal(input: string): number | null {
  const trimmed = input.trim().replace(',', '.');
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** Minutes → "1 h 30 min" / "4.5 min" for display. */
export function useFormatMinutes(): (minutes: number) => string {
  const t = useTranslations('profit.calc');
  return React.useCallback(
    (minutes: number) => {
      if (minutes >= 60) {
        const h = Math.floor(minutes / 60);
        const m = Math.round(minutes - h * 60);
        return t('hoursMinutes', { hours: h, minutes: m });
      }
      const rounded = minutes < 10 ? Math.round(minutes * 10) / 10 : Math.round(minutes);
      return t('minutes', { value: rounded });
    },
    [t],
  );
}
