import type { BadgeProps } from '@/components/ui/badge';
import { MARGIN_THRESHOLDS } from '@/lib/calculations/margin';

/** Display helpers shared by the Menu folder list and the Dish Builder. */

/** 7050 bps → "70.5%". */
export function formatPercentBps(bps: number): string {
  return `${(bps / 100).toFixed(1)}%`;
}

/** Margin chip colour, using the app-wide traffic-light thresholds. */
export function marginVariant(marginBps: number | null): NonNullable<BadgeProps['variant']> {
  if (marginBps === null) return 'neutral';
  if (marginBps >= MARGIN_THRESHOLDS.green * 100) return 'positive';
  if (marginBps >= MARGIN_THRESHOLDS.yellow * 100) return 'warning';
  return 'negative';
}

/** A number as an editable field value, without trailing zeros ("1.5", "250"). */
export function numberToField(value: number): string {
  return String(Math.round(value * 10_000) / 10_000);
}
