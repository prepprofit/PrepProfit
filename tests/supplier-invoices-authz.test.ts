import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import { runInOrg } from '@/lib/db/tenant';
import type { TenantDb } from '@/lib/db/tenant';
import { supplierInvoiceImports } from '@/lib/db/schema';
import { createIngredient, getIngredientById } from '@/lib/data/ingredients';
import { mapInvoiceExtractionToDraft } from '@/lib/ai/invoice-draft';
import type { SupplierInvoiceExtraction } from '@/lib/ai/invoice-extraction';
import { createInvoiceImport, getInvoiceImport } from '@/lib/data/supplier-invoice-imports';

/**
 * Sprint 2 RBAC: Supplier Invoice Reader review actions are MANAGER-ONLY. Every action
 * returns FORBIDDEN for kitchen BEFORE any data access — a kitchen apply never records
 * a price observation (approved cost and pending both stay untouched).
 */
const ORG = 'org_inv_authz';

const h = vi.hoisted(() => ({
  db: null as unknown as TenantDb,
  org: 'org_inv_authz',
  manager: true,
}));

vi.mock('@/lib/auth', () => ({
  getOrgId: vi.fn(async () => h.org),
  isManager: vi.fn(async () => h.manager),
  getUserId: vi.fn(async () => 'user_1'),
  getUserRole: vi.fn(async () => (h.manager ? 'manager' : 'kitchen')),
}));

vi.mock('@/lib/db', async () => {
  const { runInOrg: realRunInOrg } = await import('@/lib/db/tenant');
  return {
    withOrg: (org: string, fn: (tx: never) => unknown) =>
      realRunInOrg(h.db, org, fn as never),
  };
});

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import {
  updateInvoiceLineAction,
  applyInvoiceImportAction,
  voidInvoiceImportAction,
} from '@/app/(app)/suppliers/invoices/actions';

let client: PGlite;

function extraction(): SupplierInvoiceExtraction {
  return {
    supplier: { name: 'ACME', confidence: 0.9 },
    invoice: { number: 'INV-9', date: '2026-07-01', currency: 'EUR' },
    lines: [
      {
        rawText: 'Butter 5kg',
        itemName: 'Butter',
        quantityValue: 1,
        quantityUnit: 'case',
        packSizeValue: 5,
        packSizeUnit: 'kg',
        unitPriceCents: 970,
        lineTotalCents: 970,
        confidence: 0.95,
      },
    ],
    qualityFlags: [],
  };
}

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  h.db = test.db as unknown as TenantDb;
  await h.db.execute(sql.raw('SET ROLE tenant_app;'));
});

afterAll(async () => {
  await h.db.execute(sql.raw('RESET ROLE;'));
  await client.close();
});

describe('review actions are manager-only (FORBIDDEN before data)', () => {
  it('kitchen cannot apply an import — approved cost and pending stay untouched', async () => {
    // Manager sets up a ready import.
    h.manager = true;
    const ingId = await runInOrg(h.db, ORG, (tx) =>
      createIngredient(tx, ORG, { name: 'Butter', dimension: 'weight', priceCents: 500 }),
    ).then((i) => i.id);
    const draft = mapInvoiceExtractionToDraft(extraction());
    const importId = await runInOrg(h.db, ORG, (tx) =>
      createInvoiceImport(tx, ORG, { actorUserId: 'user_1', aiAttemptId: null, draft }),
    ).then((r) => r.importId);

    // Kitchen is denied.
    h.manager = false;
    const applied = await applyInvoiceImportAction(importId);
    expect(applied.ok).toBe(false);
    if (!applied.ok) expect(applied.code).toBe('FORBIDDEN');

    expect((await updateInvoiceLineAction(importId, 'x', {})).ok).toBe(false);
    expect((await voidInvoiceImportAction(importId)).ok).toBe(false);

    // Nothing changed: approved cost intact, no pending raised, import still draft.
    const ing = await runInOrg(h.db, ORG, (tx) => getIngredientById(tx, ORG, ingId));
    expect(ing!.priceCents).toBe(500);
    expect(ing!.pendingPriceCents).toBeNull();

    const [header] = await runInOrg(h.db, ORG, (tx) =>
      tx
        .select({ status: supplierInvoiceImports.status })
        .from(supplierInvoiceImports)
        .where(eq(supplierInvoiceImports.id, importId)),
    );
    expect(header!.status).toBe('draft');
  });

  it('manager can apply the same import', async () => {
    h.manager = true;
    const draft = mapInvoiceExtractionToDraft(extraction());
    const importId = await runInOrg(h.db, ORG, (tx) =>
      createInvoiceImport(tx, ORG, { actorUserId: 'user_1', aiAttemptId: null, draft }),
    ).then((r) => r.importId);

    const res = await applyInvoiceImportAction(importId);
    expect(res.ok).toBe(true);

    const view = await runInOrg(h.db, ORG, (tx) => getInvoiceImport(tx, ORG, importId));
    expect(view!.header.status).toBe('applied');
  });
});
