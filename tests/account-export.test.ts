import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import {
  ingredients,
  ingredientAllergens,
  auditLog,
  organizationSettings,
} from '@/lib/db/schema';
import { allocatePoNumber } from '@/lib/data/po-counters';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import {
  buildOrgDataExport,
  countExportRows,
} from '@/lib/data/account-export';
import {
  requestAccountDeletion,
  cancelAccountDeletion,
  getOrgSettingsRow,
  readAccountDeletionState,
} from '@/lib/data/org-settings';

/**
 * GDPR data lifecycle (Sprint 5e). Proves the acceptance criterion HARD: a data
 * export returns ONLY the active org's rows (never another tenant's), the deletion
 * request/cancel lifecycle records state without erasing anything, and the export
 * ROUTE enforces RBAC (403) + rate limit (429) and audits after success.
 */
const ORG_A = 'org_a';
const ORG_B = 'org_b';
const ORG_C = 'org_c';

const h = vi.hoisted(() => ({
  db: null as unknown,
  manager: true,
  orgId: 'org_a',
  userId: 'user_1',
}));

vi.mock('@/lib/auth', () => ({
  isManager: vi.fn(async () => h.manager),
  getOrgId: vi.fn(async () => h.orgId),
  getUserId: vi.fn(async () => h.userId),
  getUserRole: vi.fn(async () => (h.manager ? 'manager' : 'kitchen')),
}));

vi.mock('@/lib/db', () => ({
  getDb: () => h.db,
  withOrg: async (org: string, fn: (tx: unknown) => unknown) => {
    const { runInOrg: rio } = await import('@/lib/db/tenant');
    return rio(h.db as TenantDb, org, fn as never);
  },
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

// Import the route + actions AFTER the mocks are registered.
import { GET } from '@/app/api/account/export/route';
import {
  requestAccountDeletionAction,
  cancelAccountDeletionAction,
} from '@/app/(app)/settings/account-actions';

let client: PGlite;
let db: TenantDb;

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  db = test.db as unknown as TenantDb;
  h.db = db;
  await db.execute(sql.raw('SET ROLE tenant_app;'));

  // Seed two orgs with distinct ingredients so isolation is observable.
  await runInOrg(db, ORG_A, async (tx) => {
    await tx.insert(ingredients).values([
      { organizationId: ORG_A, name: 'Butter A', dimension: 'weight', priceCents: 400 },
      { organizationId: ORG_A, name: 'Sugar A', dimension: 'weight', priceCents: 90 },
    ]);
    await tx
      .insert(organizationSettings)
      .values({ organizationId: ORG_A, currency: 'EUR' })
      .onConflictDoNothing();
  });
  await runInOrg(db, ORG_B, async (tx) => {
    await tx.insert(ingredients).values({
      organizationId: ORG_B,
      name: 'Flour B',
      dimension: 'weight',
      priceCents: 120,
    });
  });
});

afterAll(async () => {
  await db.execute(sql.raw('RESET ROLE;'));
  await client.close();
});

beforeEach(() => {
  h.manager = true;
  h.orgId = ORG_A;
  h.userId = 'user_1';
  vi.clearAllMocks();
});

describe('buildOrgDataExport', () => {
  it('returns only the active org rows, never another tenant', async () => {
    const bundle = await runInOrg(db, ORG_A, (tx) =>
      buildOrgDataExport(tx, ORG_A),
    );

    const names = (bundle.data.ingredients as { name: string }[]).map(
      (r) => r.name,
    );
    expect(names.sort()).toEqual(['Butter A', 'Sugar A']);
    expect(names).not.toContain('Flour B');
    expect(bundle.organizationId).toBe(ORG_A);
    expect(bundle.schemaVersion).toBe(14);
    expect(countExportRows(bundle)).toBeGreaterThanOrEqual(2);

    // Sprint 10: the menu tables are part of the bundle (empty arrays are fine).
    expect(bundle.data).toHaveProperty('menus');
    expect(bundle.data).toHaveProperty('menuItems');

    // Sprint 12c: the storage-area + physical-count tables are part of the bundle.
    expect(bundle.data).toHaveProperty('storageAreas');
    expect(bundle.data).toHaveProperty('stockCounts');
    expect(bundle.data).toHaveProperty('stockCountItems');

    // Sprint 12a: the daily-close sales tables are part of the bundle.
    expect(bundle.data).toHaveProperty('sales');
    expect(bundle.data).toHaveProperty('saleItems');

    // Sprint 8a: the purchase-order + outbox tables are part of the bundle.
    expect(bundle.data).toHaveProperty('purchaseOrders');
    expect(bundle.data).toHaveProperty('purchaseOrderItems');
    expect(bundle.data).toHaveProperty('emailOutbox');

    // Sprint 8b: the goods-receipt tables are part of the bundle.
    expect(bundle.data).toHaveProperty('receipts');
    expect(bundle.data).toHaveProperty('receiptItems');

    // Sprint 11b: the production snapshot tables are part of the bundle.
    expect(bundle.data).toHaveProperty('productionRecipeSnapshots');
    expect(bundle.data).toHaveProperty('productionConsumptions');

    // Sprint 9: the allergen tables are part of the bundle (empty arrays are fine).
    expect(bundle.data).toHaveProperty('ingredientAllergens');
    expect(bundle.data).toHaveProperty('recipeAllergenOverrides');

    // Sprint 7: the supplier tables are part of the bundle.
    expect(bundle.data).toHaveProperty('suppliers');
    expect(bundle.data).toHaveProperty('ingredientSuppliers');

    // F5 columns flow through the `select()` bundle automatically.
    const settings = bundle.data.organizationSettings as Record<string, unknown>[];
    expect(settings[0]).toHaveProperty('defaultTaxRateBps');
    expect(settings[0]).toHaveProperty('stockControlStartDate');
  });

  it('includes the org poCounters row and never another tenant (F6)', async () => {
    // Allocate a real PO number for each org so both have a counter row.
    await runInOrg(db, ORG_A, (tx) => allocatePoNumber(tx, ORG_A));
    await runInOrg(db, ORG_B, (tx) => allocatePoNumber(tx, ORG_B));

    const a = await runInOrg(db, ORG_A, (tx) => buildOrgDataExport(tx, ORG_A));
    const aCounters = a.data.poCounters as { organizationId: string }[];
    expect(aCounters).toHaveLength(1);
    expect(aCounters[0]!.organizationId).toBe(ORG_A);

    const b = await runInOrg(db, ORG_B, (tx) => buildOrgDataExport(tx, ORG_B));
    const bCounters = b.data.poCounters as { organizationId: string }[];
    expect(bCounters.map((r) => r.organizationId)).toEqual([ORG_B]);
  });

  it('includes a real ingredientAllergens row, never another tenant (Sprint 9)', async () => {
    // Tag one of org A's ingredients, then assert the row is in A's export only.
    await runInOrg(db, ORG_A, async (tx) => {
      const [ing] = await tx
        .select({ id: ingredients.id })
        .from(ingredients)
        .where(eq(ingredients.organizationId, ORG_A))
        .limit(1);
      await tx.insert(ingredientAllergens).values({
        organizationId: ORG_A,
        ingredientId: ing!.id,
        allergen: 'milk',
        presence: 'contains',
      });
    });

    const a = await runInOrg(db, ORG_A, (tx) => buildOrgDataExport(tx, ORG_A));
    const aRows = a.data.ingredientAllergens as { organizationId: string }[];
    expect(aRows.length).toBeGreaterThanOrEqual(1);
    expect(aRows.every((r) => r.organizationId === ORG_A)).toBe(true);

    const b = await runInOrg(db, ORG_B, (tx) => buildOrgDataExport(tx, ORG_B));
    expect((b.data.ingredientAllergens as unknown[]).length).toBe(0);
  });

  it('includes a real supplier row, never another tenant (Sprint 7)', async () => {
    const { createSupplier } = await import('@/lib/data/suppliers');
    await runInOrg(db, ORG_A, (tx) =>
      createSupplier(tx, ORG_A, {
        name: 'ACME Foods',
        email: null,
        phone: null,
        address: null,
        taxId: null,
        notes: null,
      }),
    );

    const a = await runInOrg(db, ORG_A, (tx) => buildOrgDataExport(tx, ORG_A));
    const aRows = a.data.suppliers as { organizationId: string; name: string }[];
    expect(aRows.some((r) => r.name === 'ACME Foods')).toBe(true);
    expect(aRows.every((r) => r.organizationId === ORG_A)).toBe(true);

    const b = await runInOrg(db, ORG_B, (tx) => buildOrgDataExport(tx, ORG_B));
    expect(
      (b.data.suppliers as { name: string }[]).some((r) => r.name === 'ACME Foods'),
    ).toBe(false);
  });

  it("org B's export never sees org A's data", async () => {
    const bundle = await runInOrg(db, ORG_B, (tx) =>
      buildOrgDataExport(tx, ORG_B),
    );
    const names = (bundle.data.ingredients as { name: string }[]).map(
      (r) => r.name,
    );
    expect(names).toEqual(['Flour B']);
  });
});

describe('account deletion request lifecycle', () => {
  it('records then clears a request without deleting data', async () => {
    await runInOrg(db, ORG_A, (tx) =>
      requestAccountDeletion(tx, ORG_A, { userId: 'user_1', reason: 'leaving' }),
    );
    let state = readAccountDeletionState(
      await runInOrg(db, ORG_A, (tx) => getOrgSettingsRow(tx, ORG_A)),
    );
    expect(state.requestedAt).not.toBeNull();
    expect(state.requestedBy).toBe('user_1');
    expect(state.reason).toBe('leaving');

    // Data is untouched by a request.
    const stillThere = await runInOrg(db, ORG_A, (tx) =>
      tx
        .select()
        .from(ingredients)
        .where(eq(ingredients.organizationId, ORG_A)),
    );
    expect(stillThere.length).toBe(2);

    await runInOrg(db, ORG_A, (tx) => cancelAccountDeletion(tx, ORG_A));
    state = readAccountDeletionState(
      await runInOrg(db, ORG_A, (tx) => getOrgSettingsRow(tx, ORG_A)),
    );
    expect(state.requestedAt).toBeNull();
    expect(state.reason).toBeNull();
  });
});

describe('GET /api/account/export route', () => {
  it('kitchen is Forbidden (403) before any data access', async () => {
    h.manager = false;
    const res = await GET();
    expect(res.status).toBe(403);
  });

  it('manager downloads a bundle, audited, scoped to the active org', async () => {
    h.orgId = ORG_A;
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      organizationId: string;
      data: { ingredients: { name: string }[] };
    };
    expect(body.organizationId).toBe(ORG_A);
    const names = body.data.ingredients.map((r) => r.name);
    expect(names).not.toContain('Flour B');

    // An `account.export` audit row was written in org A.
    const audits = await runInOrg(db, ORG_A, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.organizationId, ORG_A),
            eq(auditLog.action, 'account.export'),
          ),
        ),
    );
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it('rate-limits after the bucket is exhausted (429)', async () => {
    // Bucket `accountExport` is 3/min per org+user; the 4th call in the window trips.
    h.orgId = ORG_C;
    h.userId = 'user_z';
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await GET()).status);
    }
    expect(statuses[3]).toBe(429);
  });
});

function reasonForm(reason?: string): FormData {
  const fd = new FormData();
  if (reason !== undefined) fd.set('reason', reason);
  return fd;
}

describe('deletion request actions — RBAC + audit', () => {
  it('kitchen is FORBIDDEN on request and cancel', async () => {
    h.manager = false;
    expect(await requestAccountDeletionAction(null, reasonForm('x'))).toEqual({
      ok: false,
      code: 'FORBIDDEN',
    });
    expect(await cancelAccountDeletionAction(null, reasonForm())).toEqual({
      ok: false,
      code: 'FORBIDDEN',
    });
  });

  it('manager request records state + a PII-free audit row, cancel clears it', async () => {
    h.orgId = ORG_B;
    const res = await requestAccountDeletionAction(null, reasonForm('too pricey'));
    expect(res.ok).toBe(true);

    const state = readAccountDeletionState(
      await runInOrg(db, ORG_B, (tx) => getOrgSettingsRow(tx, ORG_B)),
    );
    expect(state.requestedAt).not.toBeNull();

    const audits = await runInOrg(db, ORG_B, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.organizationId, ORG_B),
            eq(auditLog.action, 'account.deletionRequest'),
          ),
        ),
    );
    expect(audits.length).toBe(1);
    // metadata records only whether a reason was given, never its text.
    expect(audits[0]!.metadata).toEqual({ hasReason: true });

    const cancelled = await cancelAccountDeletionAction(null, reasonForm());
    expect(cancelled.ok).toBe(true);
    const after = readAccountDeletionState(
      await runInOrg(db, ORG_B, (tx) => getOrgSettingsRow(tx, ORG_B)),
    );
    expect(after.requestedAt).toBeNull();
  });
});
