import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import { runInOrg } from '@/lib/db/tenant';
import type { TenantDb, TenantTx } from '@/lib/db/tenant';
import {
  ingredients as ingredientsTable,
  organizationSettings,
  sales as salesTable,
  transactions as transactionsTable,
} from '@/lib/db/schema';
import { createIngredient } from '@/lib/data/ingredients';
import { createRecipe } from '@/lib/data/recipes';
import { addRecipeIngredient } from '@/lib/data/recipe-ingredients';

/**
 * Proves the sales import Server Actions enforce the security contract (Sprint 12b):
 * RBAC (kitchen FORBIDDEN) → entitlement (manager w/o invoices UPGRADE_REQUIRED) →
 * the org VAT precheck (SALES_TAX_RATE_REQUIRED) all bail BEFORE any job is staged,
 * and the happy path stages → confirms through the 12a primitives idempotently.
 */
const h = vi.hoisted(() => ({
  db: null as unknown as TenantDb,
  withOrg: null as unknown as <T>(org: string, fn: (tx: TenantTx) => Promise<T>) => Promise<T>,
  manager: true,
  entitled: true,
  org: 'org_a',
  user: 'user_a',
}));

vi.mock('@/lib/auth', () => ({
  isManager: vi.fn(async () => h.manager),
  getOrgId: vi.fn(async () => h.org),
  getUserId: vi.fn(async () => h.user),
  getUserRole: vi.fn(async () => (h.manager ? 'manager' : 'kitchen')),
}));

vi.mock('@/lib/db', () => ({
  getDb: () => h.db,
  withOrg: (org: string, fn: (tx: TenantTx) => unknown) => h.withOrg(org, fn as never),
}));

vi.mock('@/lib/entitlements', () => ({
  requireFeature: vi.fn(async () => (h.entitled ? null : 'UPGRADE_REQUIRED')),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import {
  previewSalesImportAction,
  confirmSalesImportAction,
} from '@/app/(app)/import/sales-actions';

const HEADER =
  'date,item_kind,item_name,quantity,unit_net_price,tax_rate_percent,ingredient_qty_canonical';
const CSV = `${HEADER}\n2026-06-01,recipe,Bread,3,5.00,,`;

let client: PGlite;

beforeEach(async () => {
  const test = await createTestDb();
  client = test.client;
  h.db = test.db as unknown as TenantDb;
  h.withOrg = (org, fn) => runInOrg(h.db, org, fn);
  h.manager = true;
  h.entitled = true;
  h.org = 'org_a';
  h.user = 'user_a';

  // Seed org_a with a configured VAT rate + a Bread recipe (100g/portion, 1000g stock).
  await h.db
    .insert(organizationSettings)
    .values({ organizationId: 'org_a', defaultTaxRateBps: 2300 });
  await runInOrg(h.db, 'org_a', async (tx) => {
    const ing = await createIngredient(tx, 'org_a', {
      name: 'Flour',
      dimension: 'weight',
      priceCents: 1000,
    });
    await tx
      .update(ingredientsTable)
      .set({ stockQuantity: '1000' })
      .where(eq(ingredientsTable.id, ing.id));
    const recipe = await createRecipe(tx, 'org_a', { name: 'Bread' });
    await addRecipeIngredient(tx, 'org_a', {
      recipeId: recipe.id,
      ingredientId: ing.id,
      quantity: 100,
    });
  });
});

afterEach(async () => {
  await client.close();
  vi.clearAllMocks();
});

function previewForm(content = CSV, filename = 'sales.csv'): FormData {
  const fd = new FormData();
  fd.set('entity', 'sales');
  fd.set('format', 'csv');
  fd.set('file', new File([content], filename, { type: 'text/csv' }));
  return fd;
}

function confirmForm(jobId: string): FormData {
  const fd = new FormData();
  fd.set('jobId', jobId);
  return fd;
}

describe('sales import actions — RBAC / entitlement', () => {
  it('kitchen is FORBIDDEN on preview and confirm before any work', async () => {
    h.manager = false;
    expect(await previewSalesImportAction(null, previewForm())).toEqual({
      ok: false,
      code: 'FORBIDDEN',
    });
    expect(await confirmSalesImportAction(null, confirmForm('x'))).toEqual({
      ok: false,
      code: 'FORBIDDEN',
    });
  });

  it('a manager without the invoices feature gets UPGRADE_REQUIRED before job work', async () => {
    h.entitled = false;
    expect(await previewSalesImportAction(null, previewForm())).toEqual({
      ok: false,
      code: 'UPGRADE_REQUIRED',
    });
    expect(await confirmSalesImportAction(null, confirmForm('x'))).toEqual({
      ok: false,
      code: 'UPGRADE_REQUIRED',
    });
    // Nothing was staged.
    const jobs = await h.db.select().from(salesTable).where(eq(salesTable.organizationId, 'org_a'));
    expect(jobs).toHaveLength(0);
  });
});

describe('sales import actions — preview', () => {
  it('requires a configured org VAT rate before staging a job', async () => {
    h.org = 'org_no_tax'; // no settings row → no default rate
    const result = await previewSalesImportAction(null, previewForm());
    expect(result).toEqual({ ok: false, code: 'SALES_TAX_RATE_REQUIRED' });
  });

  it('stages a close-oriented preview for a valid file', async () => {
    const result = await previewSalesImportAction(null, previewForm());
    expect(result.ok).toBe(true);
    if (!result.ok || result.phase !== 'preview') throw new Error('expected preview');
    expect(result.preview.entity).toBe('sales');
    expect(result.preview.counts.importable).toBe(1);
    expect(result.preview.salesPreview?.closes).toHaveLength(1);
  });
});

describe('sales import actions — confirm', () => {
  it('confirms through 12a (posts one income row) and is an idempotent no-op on re-confirm', async () => {
    const preview = await previewSalesImportAction(null, previewForm());
    if (!preview.ok || preview.phase !== 'preview') throw new Error('expected preview');
    const jobId = preview.preview.jobId;

    const committed = await confirmSalesImportAction(null, confirmForm(jobId));
    expect(committed).toMatchObject({ ok: true, phase: 'committed', created: 1, alreadyCommitted: false });

    const income = await h.db
      .select()
      .from(transactionsTable)
      .where(
        and(eq(transactionsTable.organizationId, 'org_a'), eq(transactionsTable.sourceType, 'sale')),
      );
    expect(income).toHaveLength(1);

    // Re-confirm the same job → no-op, no second close / income row.
    const again = await confirmSalesImportAction(null, confirmForm(jobId));
    expect(again).toMatchObject({ ok: true, phase: 'committed', alreadyCommitted: true });
    const posted = await h.db.select().from(salesTable).where(eq(salesTable.organizationId, 'org_a'));
    expect(posted).toHaveLength(1);
  });

  it('returns IMPORT_EXPIRED for a job past its TTL, writing nothing', async () => {
    const preview = await previewSalesImportAction(null, previewForm());
    if (!preview.ok || preview.phase !== 'preview') throw new Error('expected preview');
    const jobId = preview.preview.jobId;

    // Force the job past its TTL.
    const { importJobs } = await import('@/lib/db/schema');
    await h.db
      .update(importJobs)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(importJobs.id, jobId));

    expect(await confirmSalesImportAction(null, confirmForm(jobId))).toEqual({
      ok: false,
      code: 'IMPORT_EXPIRED',
    });
    const posted = await h.db.select().from(salesTable).where(eq(salesTable.organizationId, 'org_a'));
    expect(posted).toHaveLength(0);
  });
});
