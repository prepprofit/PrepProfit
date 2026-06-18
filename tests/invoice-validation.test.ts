import { describe, expect, it } from 'vitest';
import { invoiceDraftSchema } from '@/lib/validation/invoices';

/**
 * The per-field caps each fit a Postgres int4, but their product/sum (the stored
 * subtotal/tax/total cents) can overflow. The schema computes the totals and
 * rejects up front with INVALID_INPUT, instead of a 500 at insert time.
 */
describe('invoiceDraftSchema — total overflow guard', () => {
  it('accepts a normal invoice', () => {
    const result = invoiceDraftSchema.safeParse({
      customerId: 'cust_1',
      items: [
        { description: 'Catering', quantity: 2, unitPriceCents: 10000, taxRate: 23 },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invoice whose computed total overflows int4', () => {
    // quantity × unitPrice = 1e6 × 1e9 = 1e15 cents, far beyond int4 (≈2.1e9),
    // even though each individual field is within its own cap.
    const result = invoiceDraftSchema.safeParse({
      customerId: 'cust_1',
      items: [
        {
          description: 'Huge',
          quantity: 1_000_000,
          unitPriceCents: 1_000_000_000,
          taxRate: 0,
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});
