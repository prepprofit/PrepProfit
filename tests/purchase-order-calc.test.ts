import { describe, expect, it } from 'vitest';
import {
  purchaseOrderLineTotalCents,
  purchaseOrderTotals,
} from '@/lib/calculations/purchaseOrder';
import { supplierSnapshot } from '@/lib/documents/snapshots';
import type { Supplier } from '@/lib/db/schema';

/**
 * Pure PO math (Sprint 8a): line totals reuse the recipeCost canonical convention
 * (cost per kg/l/piece × canonical qty ÷ factor), and `supplierSnapshot` freezes a
 * supplier's contact fields without leaking anything else.
 */
describe('purchaseOrderLineTotalCents', () => {
  it('weight: cost per kg × grams / 1000', () => {
    // 500 c/kg × 2000 g / 1000 = 1000 c
    expect(
      purchaseOrderLineTotalCents({ dimension: 'weight', unitCostCents: 500, quantity: 2000 }),
    ).toBe(1000);
  });

  it('volume: cost per litre × ml / 1000', () => {
    expect(
      purchaseOrderLineTotalCents({ dimension: 'volume', unitCostCents: 400, quantity: 500 }),
    ).toBe(200);
  });

  it('count: cost per piece × pieces', () => {
    expect(
      purchaseOrderLineTotalCents({ dimension: 'count', unitCostCents: 25, quantity: 12 }),
    ).toBe(300);
  });

  it('rounds half-up to whole cents', () => {
    // 333 c/kg × 5 g / 1000 = 1.665 → 2
    expect(
      purchaseOrderLineTotalCents({ dimension: 'weight', unitCostCents: 333, quantity: 5 }),
    ).toBe(2);
  });

  it('zero quantity or zero cost → 0', () => {
    expect(
      purchaseOrderLineTotalCents({ dimension: 'weight', unitCostCents: 0, quantity: 1000 }),
    ).toBe(0);
    expect(
      purchaseOrderLineTotalCents({ dimension: 'count', unitCostCents: 999, quantity: 0 }),
    ).toBe(0);
  });
});

describe('purchaseOrderTotals', () => {
  it('sums line totals; subtotal == total (no PO-level tax in v1)', () => {
    const totals = purchaseOrderTotals([
      { dimension: 'weight', unitCostCents: 500, quantity: 2000 }, // 1000
      { dimension: 'count', unitCostCents: 25, quantity: 12 }, // 300
    ]);
    expect(totals.subtotalCents).toBe(1300);
    expect(totals.totalCents).toBe(1300);
  });

  it('empty lines → 0', () => {
    expect(purchaseOrderTotals([])).toEqual({ subtotalCents: 0, totalCents: 0 });
  });
});

describe('supplierSnapshot', () => {
  const supplier = {
    name: 'ACME Foods',
    email: 'orders@acme.test',
    phone: '+351 123',
    address: 'Rua A 1',
    taxId: 'PT123',
  } as Pick<Supplier, 'name' | 'email' | 'phone' | 'address' | 'taxId'>;

  it('freezes exactly the contact fields', () => {
    expect(supplierSnapshot(supplier)).toEqual({
      supplierName: 'ACME Foods',
      supplierEmail: 'orders@acme.test',
      supplierPhone: '+351 123',
      supplierAddress: 'Rua A 1',
      supplierTaxId: 'PT123',
    });
  });

  it('keeps nulls as null', () => {
    const snap = supplierSnapshot({
      name: 'Bare Co',
      email: null,
      phone: null,
      address: null,
      taxId: null,
    });
    expect(snap.supplierName).toBe('Bare Co');
    expect(snap.supplierEmail).toBeNull();
  });
});
