/**
 * Sales tax — pure functions, no I/O. Money is integer cents (CLAUDE.md).
 *
 * The sales fiscal model (Sprint F5) is deliberately distinct from invoices: a
 * SINGLE org rate, EXCLUSIVE pricing, expressed in integer BASIS POINTS (bps) so
 * no float rate is ever stored. 2300 bps = 23%. Each sale line carries net / tax /
 * gross separately; the sale total is the SUM of the per-line rounded figures (the
 * sum is never re-rounded), so the printed lines always reconcile with the total —
 * the same per-line-then-sum discipline as lib/calculations/invoice.ts.
 *
 * Rounding is `Math.round` (half-up), valid because sale amounts are non-negative
 * (mirrors invoice.ts:46, just / 10000 for bps instead of / 100 for percent).
 *
 * Invoices keep their own decimal-percent model — F5 does NOT unify the two.
 */

/** The maximum tax rate, in basis points: 10000 bps = 100%. */
export const MAX_TAX_RATE_BPS = 10000;

/** Clamp a rate into the valid 0..10000 bps range (defensive; storage also caps). */
function clampBps(bps: number): number {
  if (!Number.isFinite(bps)) return 0;
  return Math.min(MAX_TAX_RATE_BPS, Math.max(0, Math.round(bps)));
}

/** Tax on a non-negative net line amount at `bps`, rounded half-up to whole cents. */
export function lineTax(netCents: number, bps: number): number {
  return Math.round((netCents * clampBps(bps)) / 10000);
}

export type SaleLineInput = {
  /** Net line amount in integer cents (quantity × net unit price, pre-rounded). */
  netCents: number;
  /** Tax rate in basis points (0..10000). */
  bps: number;
};

export type SaleLineTotals = {
  netCents: number;
  taxCents: number;
  grossCents: number;
};

/** Net / tax / gross for one sale line, the tax independently rounded. */
export function saleLineTotals({ netCents, bps }: SaleLineInput): SaleLineTotals {
  const taxCents = lineTax(netCents, bps);
  return { netCents, taxCents, grossCents: netCents + taxCents };
}

export type SaleTotals = {
  netCents: number;
  taxCents: number;
  grossCents: number;
};

/** Sale net / tax / gross = the rounded per-line figures, summed (no penny drift). */
export function saleTotals(lines: SaleLineInput[]): SaleTotals {
  return lines.reduce<SaleTotals>(
    (acc, line) => {
      const { netCents, taxCents, grossCents } = saleLineTotals(line);
      return {
        netCents: acc.netCents + netCents,
        taxCents: acc.taxCents + taxCents,
        grossCents: acc.grossCents + grossCents,
      };
    },
    { netCents: 0, taxCents: 0, grossCents: 0 },
  );
}

/** A user-entered percentage (0..100) → integer basis points, capped 0..10000. */
export function percentToBps(percent: number): number {
  return clampBps(percent * 100);
}

/** Integer basis points → a percentage for display (e.g. 2300 → 23). */
export function bpsToPercent(bps: number): number {
  return clampBps(bps) / 100;
}
