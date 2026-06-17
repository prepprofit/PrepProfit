import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import {
  ingredients,
  organizationSettings,
  recipes,
  recipeIngredients,
} from '@/lib/db/schema';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import {
  createIngredient,
  getIngredientById,
  listIngredients,
} from '@/lib/data/ingredients';
import { listRecipes } from '@/lib/data/recipes';
import { getOrgSettingsRow, upsertOrgSettings } from '@/lib/data/org-settings';
import {
  createCustomer,
  getCustomerById,
  listCustomers,
} from '@/lib/data/customers';
import {
  createDraftInvoice,
  getInvoiceWithItems,
  listInvoices,
} from '@/lib/data/invoices';
import {
  createEmployee,
  getEmployeeById,
  listEmployees,
} from '@/lib/data/employees';
import { createShift, listShiftsForEmployee } from '@/lib/data/shifts';
import {
  customers as customersTable,
  employees as employeesTable,
  invoices as invoicesTable,
  shifts as shiftsTable,
} from '@/lib/db/schema';

const ORG_A = 'org_a';
const ORG_B = 'org_b';

let client: PGlite;
let db: TenantDb;
let ingredientAId: string;
let ingredientBId: string;
let recipeAId: string;

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  db = test.db as unknown as TenantDb;

  // Seed as superuser (bypasses RLS) — distinct data per organization.
  const a = await createIngredient(db, ORG_A, {
    name: 'Flour A',
    dimension: 'weight',
    priceCents: 120,
  });
  ingredientAId = a.id;

  const b = await createIngredient(db, ORG_B, {
    name: 'Chocolate B',
    dimension: 'weight',
    priceCents: 950,
  });
  ingredientBId = b.id;

  const insertedRecipes = await db
    .insert(recipes)
    .values([
      { organizationId: ORG_A, name: 'Bread A' },
      { organizationId: ORG_B, name: 'Cake B' },
    ])
    .returning();
  const recipeA = insertedRecipes.find((r) => r.organizationId === ORG_A);
  if (!recipeA) throw new Error('seed: missing org A recipe');
  recipeAId = recipeA.id;

  // Distinct settings per organization.
  await upsertOrgSettings(db, ORG_A, {
    currency: 'EUR',
    measurementSystem: 'metric',
  });
  await upsertOrgSettings(db, ORG_B, {
    currency: 'USD',
    measurementSystem: 'imperial',
  });
});

afterAll(async () => {
  await client.close();
});

describe('application layer — scoped by organization_id', () => {
  it('org A only sees its own ingredients', async () => {
    const rows = await listIngredients(db, ORG_A);
    expect(rows.map((r) => r.name)).toEqual(['Flour A']);
  });

  it('org B only sees its own ingredients', async () => {
    const rows = await listIngredients(db, ORG_B);
    expect(rows.map((r) => r.name)).toEqual(['Chocolate B']);
  });

  it('org A CANNOT fetch an org B ingredient by id', async () => {
    const stolen = await getIngredientById(db, ORG_A, ingredientBId);
    expect(stolen).toBeNull();
  });

  it('each org only sees its own recipes', async () => {
    const recipesA = await listRecipes(db, ORG_A);
    const recipesB = await listRecipes(db, ORG_B);
    expect(recipesA.map((r) => r.name)).toEqual(['Bread A']);
    expect(recipesB.map((r) => r.name)).toEqual(['Cake B']);
  });

  it('each org only reads its own settings', async () => {
    const settingsA = await getOrgSettingsRow(db, ORG_A);
    const settingsB = await getOrgSettingsRow(db, ORG_B);
    expect(settingsA?.currency).toBe('EUR');
    expect(settingsA?.measurementSystem).toBe('metric');
    expect(settingsB?.currency).toBe('USD');
    expect(settingsB?.measurementSystem).toBe('imperial');
  });
});

describe('database layer — cross-org referential integrity', () => {
  it('allows a recipe_ingredient within one organization', async () => {
    const [row] = await db
      .insert(recipeIngredients)
      .values({
        organizationId: ORG_A,
        recipeId: recipeAId,
        ingredientId: ingredientAId,
      })
      .returning();
    expect(row?.organizationId).toBe(ORG_A);
  });

  it('rejects a recipe_ingredient that links across organizations', async () => {
    // An org A line pointing at org B's ingredient: the composite
    // (organization_id, ingredient_id) FK has no matching parent row, so the DB
    // itself rejects the cross-tenant link.
    await expect(
      db.insert(recipeIngredients).values({
        organizationId: ORG_A,
        recipeId: recipeAId,
        ingredientId: ingredientBId,
      }),
    ).rejects.toThrow();
  });
});

describe('database layer — Row-Level Security (second defense)', () => {
  // Assume the non-privileged role so the RLS policies are enforced.
  beforeAll(async () => {
    await db.execute(sql.raw('SET ROLE tenant_app;'));
  });
  afterAll(async () => {
    await db.execute(sql.raw('RESET ROLE;'));
  });

  it('with org A in context, an unfiltered SELECT only returns org A rows', async () => {
    const orgIds = await runInOrg(db, ORG_A, async (tx) => {
      const result = await tx
        .select({ organizationId: ingredients.organizationId })
        .from(ingredients);
      return result.map((r) => r.organizationId);
    });
    expect(orgIds.length).toBeGreaterThan(0);
    expect(orgIds.every((id) => id === ORG_A)).toBe(true);
  });

  it('with org B in context, an unfiltered SELECT only returns org B rows', async () => {
    const orgIds = await runInOrg(db, ORG_B, async (tx) => {
      const result = await tx
        .select({ organizationId: ingredients.organizationId })
        .from(ingredients);
      return result.map((r) => r.organizationId);
    });
    expect(orgIds.every((id) => id === ORG_B)).toBe(true);
    expect(orgIds).not.toContain(ORG_A);
  });

  it('with org A in context, settings reads only return org A', async () => {
    const currencies = await runInOrg(db, ORG_A, async (tx) => {
      const result = await tx
        .select({ currency: organizationSettings.currency })
        .from(organizationSettings);
      return result.map((r) => r.currency);
    });
    expect(currencies).toEqual(['EUR']);
  });

  it('without an organization context, RLS blocks everything (secure by default)', async () => {
    const rows = await db.select().from(ingredients);
    expect(rows).toHaveLength(0);
    const settings = await db.select().from(organizationSettings);
    expect(settings).toHaveLength(0);
  });
});

describe('Sprint 3 entities — org isolation (customers, invoices, payroll)', () => {
  let s3Client: PGlite;
  let s3Db: TenantDb;
  let invoiceBId: string;
  let employeeBId: string;
  let customerBId: string;

  beforeAll(async () => {
    const test = await createTestDb();
    s3Client = test.client;
    s3Db = test.db as unknown as TenantDb;

    // Distinct customers + a draft invoice per org.
    const custA = await createCustomer(s3Db, ORG_A, {
      name: 'Customer A',
      taxId: null,
      address: null,
      email: null,
    });
    const custB = await createCustomer(s3Db, ORG_B, {
      name: 'Customer B',
      taxId: null,
      address: null,
      email: null,
    });
    customerBId = custB.id;

    await createDraftInvoice(s3Db, ORG_A, {
      customerId: custA.id,
      notes: null,
      items: [{ description: 'A', quantity: 1, unitPriceCents: 1000, taxRate: 0 }],
    });
    const invB = await createDraftInvoice(s3Db, ORG_B, {
      customerId: custB.id,
      notes: null,
      items: [{ description: 'B', quantity: 1, unitPriceCents: 2000, taxRate: 0 }],
    });
    invoiceBId = invB.id;

    // Distinct employees + a shift per org.
    const empA = await createEmployee(s3Db, ORG_A, {
      name: 'Employee A',
      email: null,
      hourlyRateCents: 1000,
    });
    const empB = await createEmployee(s3Db, ORG_B, {
      name: 'Employee B',
      email: null,
      hourlyRateCents: 2000,
    });
    employeeBId = empB.id;

    await createShift(s3Db, ORG_A, {
      employeeId: empA.id,
      startedAtMs: Date.UTC(2026, 5, 15, 9),
      endedAtMs: Date.UTC(2026, 5, 15, 17),
      breakMinutes: 0,
      note: null,
    });
    await createShift(s3Db, ORG_B, {
      employeeId: empB.id,
      startedAtMs: Date.UTC(2026, 5, 15, 9),
      endedAtMs: Date.UTC(2026, 5, 15, 17),
      breakMinutes: 0,
      note: null,
    });
  });

  afterAll(async () => {
    await s3Client.close();
  });

  it('each org only sees its own customers; cross-org fetch is null', async () => {
    expect((await listCustomers(s3Db, ORG_A)).map((c) => c.name)).toEqual([
      'Customer A',
    ]);
    expect(await getCustomerById(s3Db, ORG_A, customerBId)).toBeNull();
  });

  it('each org only sees its own invoices; cross-org fetch is null', async () => {
    const aInvoices = await listInvoices(s3Db, ORG_A);
    expect(aInvoices.every((i) => i.customerName === 'Customer A')).toBe(true);
    expect(await getInvoiceWithItems(s3Db, ORG_A, invoiceBId)).toBeNull();
  });

  it('each org only sees its own employees; cross-org fetch is null', async () => {
    expect((await listEmployees(s3Db, ORG_A)).map((e) => e.name)).toEqual([
      'Employee A',
    ]);
    expect(await getEmployeeById(s3Db, ORG_A, employeeBId)).toBeNull();
  });

  it("org A cannot read org B's shifts (by employee)", async () => {
    // Org A asking for org B's employee's shifts gets nothing (org-scoped query).
    expect(await listShiftsForEmployee(s3Db, ORG_A, employeeBId)).toHaveLength(0);
  });

  it('RLS scopes every new table to the active org (unfiltered SELECT)', async () => {
    await s3Db.execute(sql.raw('SET ROLE tenant_app;'));
    try {
      const seen = await runInOrg(s3Db, ORG_A, async (tx) => ({
        customers: (
          await tx.select({ org: customersTable.organizationId }).from(customersTable)
        ).map((r) => r.org),
        invoices: (
          await tx.select({ org: invoicesTable.organizationId }).from(invoicesTable)
        ).map((r) => r.org),
        employees: (
          await tx.select({ org: employeesTable.organizationId }).from(employeesTable)
        ).map((r) => r.org),
        shifts: (
          await tx.select({ org: shiftsTable.organizationId }).from(shiftsTable)
        ).map((r) => r.org),
      }));
      for (const orgs of Object.values(seen)) {
        expect(orgs.length).toBeGreaterThan(0);
        expect(orgs.every((o) => o === ORG_A)).toBe(true);
      }
    } finally {
      await s3Db.execute(sql.raw('RESET ROLE;'));
    }
  });
});
