import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import { auditLog, transactions } from '@/lib/db/schema';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import {
  createTransaction,
  getTransactionAnyState,
  listTrashedTransactions,
  postSaleTransaction,
  purgeTransaction,
  restoreTransaction,
  softDeleteTransaction,
  updateTransaction,
  voidSaleTransaction,
} from '@/lib/data/transactions';
import {
  ensureCategoriesSeeded,
  getCategoryIdBySlug,
} from '@/lib/data/transaction-categories';
import { purgeExpired } from '@/lib/data/trash';

/**
 * Sprint F5 — the sale↔transaction contract, driven with SYNTHETIC sale ids (no
 * `sales` table yet). Runs against a real in-memory Postgres (PGlite) under the
 * non-privileged `tenant_app` role so RLS + the CHECK / partial-unique constraints
 * are actually enforced. The action layer (`@/lib/auth`, `@/lib/db`) is mocked so
 * the protected-row guard runs end-to-end against THIS db.
 */
const ORG = 'org_f5';

const h = vi.hoisted(() => ({
  db: null as unknown as TenantDb,
  org: 'org_f5',
  manager: true,
  userId: 'user_1',
}));

vi.mock('@/lib/auth', () => ({
  isManager: vi.fn(async () => h.manager),
  getOrgId: vi.fn(async () => h.org),
  getUserId: vi.fn(async () => h.userId),
  getUserRole: vi.fn(async () => (h.manager ? 'manager' : 'kitchen')),
}));

vi.mock('@/lib/db', () => ({
  withOrg: (org: string, fn: (tx: never) => unknown) =>
    runInOrg(h.db, org, fn as never),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

// Import the actions AFTER the mocks are registered.
import {
  deleteTransactionAction,
  updateTransactionAction,
} from '@/app/(app)/transactions/actions';
import {
  purgeTransactionAction,
  restoreTransactionAction,
} from '@/app/(app)/trash/actions';

let client: PGlite;
let db: TenantDb;
let incomeCategoryId: string;

const validInput = (categoryId: string) => ({
  type: 'income' as const,
  categoryId,
  recipeId: null,
  occurredOn: '2026-06-01',
  amountCents: 5000,
  note: null,
});

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  db = test.db as unknown as TenantDb;
  h.db = db;
  await db.execute(sql.raw('SET ROLE tenant_app;'));

  await runInOrg(db, ORG, async (tx) => {
    await ensureCategoriesSeeded(tx, ORG);
  });
  incomeCategoryId = (await runInOrg(db, ORG, (tx) =>
    getCategoryIdBySlug(tx, ORG, 'other_income'),
  ))!;
});

afterAll(async () => {
  await db.execute(sql.raw('RESET ROLE;'));
  await client.close();
});

beforeEach(() => {
  h.org = ORG;
  h.manager = true;
  h.userId = 'user_1';
  vi.clearAllMocks();
});

/** Insert a sale-sourced income row for `saleId` and return its id. */
async function postSale(saleId: string, grossCents = 12300, on = '2026-06-10') {
  const result = await runInOrg(db, ORG, (tx) =>
    postSaleTransaction(tx, ORG, { saleId, grossCents, occurredOn: on }),
  );
  if (!result.ok) throw new Error(`postSale failed: ${result.reason}`);
  return result.transaction.id;
}

describe('postSaleTransaction — fixed invariants + dedup', () => {
  it('inserts ONE income row with the fixed invariants and the daily_sales category', async () => {
    const result = await runInOrg(db, ORG, (tx) =>
      postSaleTransaction(tx, ORG, {
        saleId: 'sale_invariants',
        grossCents: 9999,
        occurredOn: '2026-06-02',
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = result.transaction;
    expect(row.type).toBe('income');
    expect(row.amountCents).toBe(9999);
    expect(row.recipeId).toBeNull();
    expect(row.sourceType).toBe('sale');
    expect(row.sourceId).toBe('sale_invariants');

    const dailySalesId = await runInOrg(db, ORG, (tx) =>
      getCategoryIdBySlug(tx, ORG, 'daily_sales'),
    );
    expect(row.categoryId).toBe(dailySalesId);
  });

  it('a second post with the SAME payload is deduped (still one row)', async () => {
    await postSale('sale_dedup', 5000, '2026-06-03');
    const again = await runInOrg(db, ORG, (tx) =>
      postSaleTransaction(tx, ORG, {
        saleId: 'sale_dedup',
        grossCents: 5000,
        occurredOn: '2026-06-03',
      }),
    );
    expect(again.ok && again.deduped).toBe(true);

    const rows = await runInOrg(db, ORG, (tx) =>
      tx
        .select()
        .from(transactions)
        .where(
          and(eq(transactions.organizationId, ORG), eq(transactions.sourceId, 'sale_dedup')),
        ),
    );
    expect(rows).toHaveLength(1);
  });

  it('the SAME saleId with a DIFFERENT payload is a conflict and never overwrites', async () => {
    await postSale('sale_conflict', 5000, '2026-06-04');
    const conflict = await runInOrg(db, ORG, (tx) =>
      postSaleTransaction(tx, ORG, {
        saleId: 'sale_conflict',
        grossCents: 7000, // different amount
        occurredOn: '2026-06-04',
      }),
    );
    expect(conflict).toEqual({ ok: false, reason: 'idempotency_conflict' });

    const [row] = await runInOrg(db, ORG, (tx) =>
      tx
        .select()
        .from(transactions)
        .where(
          and(eq(transactions.organizationId, ORG), eq(transactions.sourceId, 'sale_conflict')),
        ),
    );
    expect(row!.amountCents).toBe(5000); // original preserved
  });

  it('two posts of the same saleId yield exactly one row', async () => {
    await Promise.all([
      runInOrg(db, ORG, (tx) =>
        postSaleTransaction(tx, ORG, {
          saleId: 'sale_race',
          grossCents: 4200,
          occurredOn: '2026-06-05',
        }),
      ),
      runInOrg(db, ORG, (tx) =>
        postSaleTransaction(tx, ORG, {
          saleId: 'sale_race',
          grossCents: 4200,
          occurredOn: '2026-06-05',
        }),
      ),
    ]);
    const rows = await runInOrg(db, ORG, (tx) =>
      tx
        .select()
        .from(transactions)
        .where(
          and(eq(transactions.organizationId, ORG), eq(transactions.sourceId, 'sale_race')),
        ),
    );
    expect(rows).toHaveLength(1);
  });
});

describe('source-pair CHECK constraint', () => {
  it('rejects a half-populated source (type set, id null)', async () => {
    await expect(
      runInOrg(db, ORG, (tx) =>
        tx.insert(transactions).values({
          organizationId: ORG,
          type: 'income',
          categoryId: incomeCategoryId,
          occurredOn: '2026-06-06',
          amountCents: 100,
          sourceType: 'sale',
          sourceId: null,
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('protected backstop — data layer mutators', () => {
  it('a normal row is mutable; a sale row is not', async () => {
    // Normal row: created, then updated/soft-deleted/restored/purged succeed.
    const normalId = await runInOrg(db, ORG, async (tx) => {
      const row = await createTransaction(tx, ORG, validInput(incomeCategoryId));
      return row.id;
    });
    const updated = await runInOrg(db, ORG, (tx) =>
      updateTransaction(tx, ORG, normalId, { ...validInput(incomeCategoryId), amountCents: 6000 }),
    );
    expect(updated?.amountCents).toBe(6000);
    expect(await runInOrg(db, ORG, (tx) => softDeleteTransaction(tx, ORG, normalId))).not.toBeNull();
    expect(await runInOrg(db, ORG, (tx) => restoreTransaction(tx, ORG, normalId))).not.toBeNull();

    // Sale row: every generic mutator is a no-op (backstop matches nothing).
    const saleId = await postSale('sale_backstop');
    expect(
      await runInOrg(db, ORG, (tx) =>
        updateTransaction(tx, ORG, saleId, validInput(incomeCategoryId)),
      ),
    ).toBeNull();
    expect(await runInOrg(db, ORG, (tx) => softDeleteTransaction(tx, ORG, saleId))).toBeNull();
    // (it is active, so restore is a no-op too)
    expect(await runInOrg(db, ORG, (tx) => restoreTransaction(tx, ORG, saleId))).toBeNull();
    await runInOrg(db, ORG, (tx) => purgeTransaction(tx, ORG, saleId));
    expect(await runInOrg(db, ORG, (tx) => getTransactionAnyState(tx, ORG, saleId))).not.toBeNull();
  });
});

describe('protected guard — actions (PROTECTED vs NOT_FOUND, no audit on refusal)', () => {
  async function auditCountFor(entityId: string): Promise<number> {
    const rows = await runInOrg(db, ORG, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.organizationId, ORG), eq(auditLog.entityId, entityId))),
    );
    return rows.length;
  }

  it('update/delete actions: sale → PROTECTED_TRANSACTION, missing → NOT_FOUND, normal → ok', async () => {
    const saleId = await postSale('sale_actions_1');
    expect(await updateTransactionAction(saleId, validInput(incomeCategoryId))).toEqual({
      ok: false,
      code: 'PROTECTED_TRANSACTION',
    });
    expect(await deleteTransactionAction(saleId)).toEqual({
      ok: false,
      code: 'PROTECTED_TRANSACTION',
    });
    expect(await auditCountFor(saleId)).toBe(0); // no audit on refusal

    expect(await updateTransactionAction('does_not_exist', validInput(incomeCategoryId))).toEqual({
      ok: false,
      code: 'NOT_FOUND',
    });

    const normalId = await runInOrg(db, ORG, async (tx) =>
      (await createTransaction(tx, ORG, validInput(incomeCategoryId))).id,
    );
    expect(await updateTransactionAction(normalId, { ...validInput(incomeCategoryId), amountCents: 7777 })).toEqual({
      ok: true,
      data: undefined,
    });
    expect(await deleteTransactionAction(normalId)).toEqual({ ok: true, data: undefined });
  });

  it('trash restore/purge actions: sale → PROTECTED, normal trashed → ok', async () => {
    const saleId = await postSale('sale_actions_2');
    expect(await restoreTransactionAction(saleId)).toEqual({
      ok: false,
      code: 'PROTECTED_TRANSACTION',
    });
    expect(await purgeTransactionAction(saleId)).toEqual({
      ok: false,
      code: 'PROTECTED_TRANSACTION',
    });
    expect(await auditCountFor(saleId)).toBe(0);

    // Normal trashed row restores then purges fine.
    const normalId = await runInOrg(db, ORG, async (tx) => {
      const row = await createTransaction(tx, ORG, validInput(incomeCategoryId));
      await softDeleteTransaction(tx, ORG, row.id);
      return row.id;
    });
    expect(await restoreTransactionAction(normalId)).toEqual({ ok: true, data: undefined });
    await runInOrg(db, ORG, (tx) => softDeleteTransaction(tx, ORG, normalId));
    expect(await purgeTransactionAction(normalId)).toEqual({ ok: true, data: undefined });
  });
});

describe('voidSaleTransaction + trash/cron exclusion', () => {
  it('soft-deletes the sale row, is idempotent, and stays out of the trash listing', async () => {
    const saleId = await postSale('sale_void');
    const first = await runInOrg(db, ORG, (tx) => voidSaleTransaction(tx, ORG, 'sale_void'));
    expect(first).not.toBeNull();
    expect(first!.deletedAt).not.toBeNull();

    // Idempotent: a second void is a no-op (no row matched).
    const second = await runInOrg(db, ORG, (tx) => voidSaleTransaction(tx, ORG, 'sale_void'));
    expect(second).toBeNull();

    // A voided sale is NOT user-trash.
    const trashed = await runInOrg(db, ORG, (tx) => listTrashedTransactions(tx, ORG));
    expect(trashed.map((r) => r.id)).not.toContain(saleId);
  });

  it('purgeExpired skips a voided sale but purges a normal expired transaction', async () => {
    const saleId = await postSale('sale_purge');
    await runInOrg(db, ORG, (tx) => voidSaleTransaction(tx, ORG, 'sale_purge'));

    const normalId = await runInOrg(db, ORG, async (tx) => {
      const row = await createTransaction(tx, ORG, validInput(incomeCategoryId));
      await softDeleteTransaction(tx, ORG, row.id);
      return row.id;
    });

    const cutoff = new Date(Date.now() + 24 * 60 * 60 * 1000); // future → both expired
    const result = await runInOrg(db, ORG, (tx) => purgeExpired(tx, ORG, cutoff));
    expect(result.transactions).toBeGreaterThanOrEqual(1);

    expect(await runInOrg(db, ORG, (tx) => getTransactionAnyState(tx, ORG, saleId))).not.toBeNull();
    expect(await runInOrg(db, ORG, (tx) => getTransactionAnyState(tx, ORG, normalId))).toBeNull();
  });
});
