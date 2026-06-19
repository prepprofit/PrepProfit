import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, and, eq } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import { runInOrg } from '@/lib/db/tenant';
import type { TenantDb } from '@/lib/db/tenant';
import { importJobs, ingredients, transactions } from '@/lib/db/schema';
import {
  createImportJob,
  lockImportJob,
  markImportJobCommitted,
} from '@/lib/data/import-jobs';
import {
  planIngredientImport,
  planTransactionImport,
  applyIngredientRecords,
  applyTransactionRecords,
} from '@/lib/data/import';
import { createIngredient } from '@/lib/data/ingredients';
import { parseCsv } from '@/lib/import/csv';
import { parseIngredients, parseTransactions } from '@/lib/import/parse';

const ORG_A = 'org_a';
const ORG_B = 'org_b';

let client: PGlite;
let db: TenantDb;

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  db = test.db as unknown as TenantDb;
});

afterAll(async () => {
  await client.close();
});

describe('import jobs — org isolation', () => {
  it('a job is invisible to (and unlockable by) another org', async () => {
    const job = await runInOrg(db, ORG_A, (tx) =>
      createImportJob(tx, ORG_A, {
        actorUserId: 'user_a',
        entity: 'ingredients',
        format: 'csv',
        sourceFilename: 'x.csv',
        rowCount: 0,
        normalizedRows: [],
        issues: [],
        idempotencyKey: null,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    );

    const fromB = await runInOrg(db, ORG_B, (tx) => lockImportJob(tx, ORG_B, job.id));
    expect(fromB).toBeNull();

    const fromA = await runInOrg(db, ORG_A, (tx) => lockImportJob(tx, ORG_A, job.id));
    expect(fromA?.id).toBe(job.id);
  });

  it('RLS hides another org’s job from an unfiltered read', async () => {
    await db.execute(sql.raw('SET ROLE tenant_app;'));
    try {
      const seen = await runInOrg(db, ORG_A, (tx) =>
        tx.select({ org: importJobs.organizationId }).from(importJobs),
      );
      expect(seen.every((r) => r.org === ORG_A)).toBe(true);
    } finally {
      await db.execute(sql.raw('RESET ROLE;'));
    }
  });
});

describe('planIngredientImport', () => {
  it('skips a name that already exists and a repeat within the file', async () => {
    await createIngredient(db, ORG_A, {
      name: 'Flour',
      dimension: 'weight',
      priceCents: 100,
    });

    const parsed = parseIngredients(
      parseCsv(
        'name,dimension,price\nFlour,weight,1.20\nSugar,weight,0.90\nsugar,weight,0.95',
      ),
    );
    if (!parsed.ok) throw new Error(parsed.error);

    const plan = await runInOrg(db, ORG_A, (tx) =>
      planIngredientImport(tx, ORG_A, parsed.rows),
    );
    // Flour = existing duplicate, second "sugar" = in-file duplicate → 1 importable.
    expect(plan.counts).toMatchObject({ importable: 1, skipped: 2, invalid: 0 });
    expect(
      plan.issues.filter((i) => i.code === 'DUPLICATE').map((i) => i.line),
    ).toEqual([2, 4]);
  });
});

describe('planTransactionImport', () => {
  it('resolves a seeded category name and flags an unknown one', async () => {
    const parsed = parseTransactions(
      parseCsv(
        'date,type,category,amount\n2026-06-15,income,Food sales,10.00\n2026-06-16,expense,Nope,5.00',
      ),
    );
    if (!parsed.ok) throw new Error(parsed.error);

    const plan = await runInOrg(db, ORG_A, (tx) =>
      planTransactionImport(tx, ORG_A, parsed.rows),
    );
    expect(plan.counts).toMatchObject({ importable: 1, skipped: 1 });
    expect(plan.issues.some((i) => i.code === 'UNKNOWN_CATEGORY')).toBe(true);
    expect(plan.records[0]).toMatchObject({
      categoryName: 'Food sales',
      amountCents: 1000,
      recipeId: null,
    });
  });
});

describe('apply services insert into the active org only', () => {
  it('applies ingredient + transaction records and marks the job committed', async () => {
    const parsedIng = parseIngredients(
      parseCsv('name,dimension,price\nButter,weight,4.50'),
    );
    if (!parsedIng.ok) throw new Error(parsedIng.error);
    const parsedTxn = parseTransactions(
      parseCsv('date,type,category,amount\n2026-06-20,income,Catering & events,99.00'),
    );
    if (!parsedTxn.ok) throw new Error(parsedTxn.error);

    const created = await runInOrg(db, ORG_B, async (tx) => {
      const ingPlan = await planIngredientImport(tx, ORG_B, parsedIng.rows);
      const txnPlan = await planTransactionImport(tx, ORG_B, parsedTxn.rows);
      const job = await createImportJob(tx, ORG_B, {
        actorUserId: 'user_b',
        entity: 'ingredients',
        format: 'csv',
        sourceFilename: 'i.csv',
        rowCount: ingPlan.records.length,
        normalizedRows: ingPlan.records,
        issues: ingPlan.issues,
        idempotencyKey: null,
        expiresAt: new Date(Date.now() + 60_000),
      });
      const a = await applyIngredientRecords(tx, ORG_B, ingPlan.records);
      const b = await applyTransactionRecords(tx, ORG_B, txnPlan.records);
      await markImportJobCommitted(tx, ORG_B, job.id);
      return { a, b };
    });
    expect(created).toEqual({ a: 1, b: 1 });

    const butter = await db
      .select()
      .from(ingredients)
      .where(and(eq(ingredients.organizationId, ORG_B), eq(ingredients.name, 'Butter')));
    expect(butter).toHaveLength(1);

    const txnRows = await db
      .select()
      .from(transactions)
      .where(eq(transactions.organizationId, ORG_B));
    expect(txnRows.some((t) => t.amountCents === 9900)).toBe(true);
  });
});
