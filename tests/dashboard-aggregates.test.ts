import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import type { TenantDb } from '@/lib/db/tenant';
import { invoices as invoicesTable } from '@/lib/db/schema';
import type { InvoiceStatus } from '@/lib/db/schema';
import {
  ensureCategoriesSeeded,
  listCategories,
} from '@/lib/data/transaction-categories';
import {
  createTransaction,
  softDeleteTransaction,
  sumTransactionsByMonth,
  sumTransactionsByType,
  toSafeCents,
} from '@/lib/data/transactions';
import { invoiceSummary } from '@/lib/calculations/invoice';
import { summarizeInvoicesForDashboard } from '@/lib/data/invoices';

const ORG_A = 'org_agg_a';
const ORG_B = 'org_agg_b';

let client: PGlite;
let db: TenantDb;
let incomeCat: string;
let expenseCat: string;
let bIncomeCat: string;

const txn = (
  type: 'income' | 'expense',
  occurredOn: string,
  amountCents: number,
  org = ORG_A,
) =>
  createTransaction(db, org, {
    type,
    categoryId: org === ORG_A ? (type === 'income' ? incomeCat : expenseCat) : bIncomeCat,
    recipeId: null,
    occurredOn,
    amountCents,
    note: null,
  });

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  db = test.db as unknown as TenantDb;
  await ensureCategoriesSeeded(db, ORG_A);
  await ensureCategoriesSeeded(db, ORG_B);
  const catsA = await listCategories(db, ORG_A);
  incomeCat = catsA.find((c) => c.kind === 'income')!.id;
  expenseCat = catsA.find((c) => c.kind === 'expense')!.id;
  bIncomeCat = (await listCategories(db, ORG_B)).find((c) => c.kind === 'income')!.id;
});

afterAll(async () => {
  await client.close();
});

describe('toSafeCents', () => {
  it('converts driver string/number shapes and defaults null to 0', () => {
    expect(toSafeCents('12345', 't')).toBe(12345);
    expect(toSafeCents(0, 't')).toBe(0);
    expect(toSafeCents(null, 't')).toBe(0);
    expect(toSafeCents(undefined, 't')).toBe(0);
  });

  it('throws on unsafe values instead of silently coercing', () => {
    expect(() => toSafeCents('9007199254740993', 't')).toThrow();
    expect(() => toSafeCents('not-a-number', 't')).toThrow();
  });
});

describe('sumTransactionsByMonth', () => {
  it('buckets by month, zero-fills gaps, separates types, respects year bounds, soft-delete and org', async () => {
    // Year under test: 2025.
    await txn('income', '2025-01-01', 10_000); // Jan 1 boundary in-year
    await txn('income', '2025-12-31', 5_000); // Dec 31 boundary in-year
    await txn('expense', '2025-01-15', 3_000);
    await txn('income', '2024-12-31', 99_999); // prior year — excluded
    await txn('income', '2026-01-01', 99_999); // next year — excluded
    await txn('income', '2025-03-10', 900_000_000); // large valid cents
    await txn('income', '2025-06-01', 7_777, ORG_B); // other org — excluded
    const dead = await txn('income', '2025-01-20', 50_000);
    await softDeleteTransaction(db, ORG_A, dead.id);

    const buckets = await sumTransactionsByMonth(db, ORG_A, 2025);
    expect(buckets).toHaveLength(12);
    expect(buckets.map((b) => b.month)).toEqual(
      Array.from({ length: 12 }, (_, i) => i + 1),
    );
    expect(buckets[0]).toEqual({
      month: 1,
      incomeCents: 10_000,
      expenseCents: 3_000,
      profitCents: 7_000,
    });
    expect(buckets[2]!.incomeCents).toBe(900_000_000);
    expect(buckets[11]!.incomeCents).toBe(5_000);
    // Zero-filled month with no activity.
    expect(buckets[5]).toEqual({
      month: 6,
      incomeCents: 0,
      expenseCents: 0,
      profitCents: 0,
    });
  });

  it('returns 12 zero buckets for a year with no rows', async () => {
    const buckets = await sumTransactionsByMonth(db, ORG_A, 1999);
    expect(buckets).toHaveLength(12);
    expect(buckets.every((b) => b.incomeCents === 0 && b.expenseCents === 0 && b.profitCents === 0)).toBe(true);
  });
});

describe('sumTransactionsByType (prior period)', () => {
  it('respects inclusive from/to across a year boundary (January prior = December)', async () => {
    await txn('income', '2023-12-01', 1_000);
    await txn('income', '2023-12-31', 2_000); // inclusive upper bound
    await txn('expense', '2023-12-15', 500);
    await txn('income', '2023-11-30', 99_999); // before range
    await txn('income', '2024-01-01', 99_999); // after range

    const totals = await sumTransactionsByType(db, ORG_A, {
      from: '2023-12-01',
      to: '2023-12-31',
    });
    expect(totals).toEqual({
      incomeCents: 3_000,
      expenseCents: 500,
      profitCents: 2_500,
    });
  });

  it('excludes soft-deleted and cross-org rows', async () => {
    const dead = await txn('expense', '2022-05-05', 4_000);
    await softDeleteTransaction(db, ORG_A, dead.id);
    await txn('income', '2022-05-05', 8_000, ORG_B);

    const totals = await sumTransactionsByType(db, ORG_A, {
      from: '2022-05-01',
      to: '2022-05-31',
    });
    expect(totals).toEqual({ incomeCents: 0, expenseCents: 0, profitCents: 0 });
  });

  it('returns zeros for an empty range', async () => {
    const totals = await sumTransactionsByType(db, ORG_A, {
      from: '1990-01-01',
      to: '1990-12-31',
    });
    expect(totals).toEqual({ incomeCents: 0, expenseCents: 0, profitCents: 0 });
  });
});

describe('summarizeInvoicesForDashboard', () => {
  const TODAY = '2026-07-07';
  const seedInvoice = (
    org: string,
    status: InvoiceStatus,
    totalCents: number,
    dueDate: string | null = null,
    deleted = false,
  ) =>
    db.insert(invoicesTable).values({
      organizationId: org,
      status,
      totalCents,
      dueDate,
      deletedAt: deleted ? new Date() : null,
    });

  it('matches the pure invoiceSummary() across all statuses and overdue edges', async () => {
    const rows = [
      { status: 'draft' as const, totalCents: 1_000, dueDate: null },
      { status: 'draft' as const, totalCents: 2_000, dueDate: null },
      { status: 'issued' as const, totalCents: 10_000, dueDate: '2026-07-01' }, // overdue
      { status: 'issued' as const, totalCents: 20_000, dueDate: TODAY }, // due today ≠ overdue
      { status: 'issued' as const, totalCents: 30_000, dueDate: null }, // no due date ≠ overdue
      { status: 'paid' as const, totalCents: 40_000, dueDate: '2026-01-01' },
      { status: 'void' as const, totalCents: 50_000, dueDate: '2026-01-01' }, // ignored
    ];
    for (const r of rows) await seedInvoice(ORG_A, r.status, r.totalCents, r.dueDate);
    // Excluded noise: soft-deleted draft + cross-org issued.
    await seedInvoice(ORG_A, 'draft', 9_999, null, true);
    await seedInvoice(ORG_B, 'issued', 77_777, '2026-01-01');

    const summary = await summarizeInvoicesForDashboard(db, ORG_A, TODAY);
    expect(summary).toEqual(invoiceSummary(rows, TODAY));
    expect(summary).toEqual({
      outstandingCents: 60_000,
      overdueCents: 10_000,
      draftCount: 2,
      issuedCount: 3,
      paidCount: 1,
    });
  });

  it('returns all zeros for an empty org', async () => {
    expect(await summarizeInvoicesForDashboard(db, 'org_agg_empty', TODAY)).toEqual({
      outstandingCents: 0,
      overdueCents: 0,
      draftCount: 0,
      issuedCount: 0,
      paidCount: 0,
    });
  });
});
