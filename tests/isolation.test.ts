import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import {
  ingredients,
  organizationSettings,
  recipes,
  recipeIngredients,
  recipePresets,
  recipeComponents,
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
  auditLog as auditLogTable,
  customers as customersTable,
  employees as employeesTable,
  invoices as invoicesTable,
  shifts as shiftsTable,
} from '@/lib/db/schema';
import { writeAuditEvent } from '@/lib/data/audit';

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
    businessName: null,
    businessAddress: null,
    businessTaxId: null,
    businessEmail: null,
    businessLogoUrl: null,
    defaultTaxRateBps: null,
    stockControlStartDate: null,
    weeklyCfoReportEmailEnabled: false,
  });
  await upsertOrgSettings(db, ORG_B, {
    currency: 'USD',
    measurementSystem: 'imperial',
    businessName: null,
    businessAddress: null,
    businessTaxId: null,
    businessEmail: null,
    businessLogoUrl: null,
    defaultTaxRateBps: null,
    stockControlStartDate: null,
    weeklyCfoReportEmailEnabled: false,
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

describe('database layer — RLS WITH CHECK rejects cross-org WRITES', () => {
  // Reads being scoped is only half the guarantee; these prove the WITH CHECK /
  // USING clauses also reject INSERT/UPDATE/DELETE that try to cross tenants.
  beforeAll(async () => {
    await db.execute(sql.raw('SET ROLE tenant_app;'));
  });
  afterAll(async () => {
    await db.execute(sql.raw('RESET ROLE;'));
  });

  it('rejects an INSERT carrying another org id (WITH CHECK)', async () => {
    await expect(
      runInOrg(db, ORG_A, (tx) =>
        tx.insert(ingredients).values({
          organizationId: ORG_B,
          name: 'Smuggled',
          dimension: 'weight',
          priceCents: 100,
        }),
      ),
    ).rejects.toThrow();
  });

  it('allows an INSERT carrying the active org id', async () => {
    const rows = await runInOrg(db, ORG_A, (tx) =>
      tx
        .insert(ingredients)
        .values({
          organizationId: ORG_A,
          name: 'Legit A',
          dimension: 'weight',
          priceCents: 100,
        })
        .returning({ id: ingredients.id }),
    );
    expect(rows).toHaveLength(1);
  });

  it('rejects re-tagging a row to another org via UPDATE (WITH CHECK)', async () => {
    await expect(
      runInOrg(db, ORG_A, (tx) =>
        tx
          .update(ingredients)
          .set({ organizationId: ORG_B })
          .where(eq(ingredients.id, ingredientAId)),
      ),
    ).rejects.toThrow();
  });

  it("a DELETE cannot reach another org's row (USING hides it → 0 rows)", async () => {
    const deleted = await runInOrg(db, ORG_A, (tx) =>
      tx
        .delete(ingredients)
        .where(eq(ingredients.id, ingredientBId))
        .returning({ id: ingredients.id }),
    );
    expect(deleted).toHaveLength(0);
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

    // One audit event per org (seeded as superuser, like the rest).
    const actor = (org: string) => ({
      userId: `user_${org}`,
      role: 'manager' as const,
      requestId: `req_${org}`,
    });
    await writeAuditEvent(s3Db, ORG_A, actor(ORG_A), {
      action: 'employee.create',
      entityType: 'employee',
      entityId: empA.id,
    });
    await writeAuditEvent(s3Db, ORG_B, actor(ORG_B), {
      action: 'employee.create',
      entityType: 'employee',
      entityId: empB.id,
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
        auditLog: (
          await tx.select({ org: auditLogTable.organizationId }).from(auditLogTable)
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

describe('recipe_presets — org isolation + cross-org integrity (Recipe-editor parity)', () => {
  let pClient: PGlite;
  let pDb: TenantDb;
  let recipeA: string;
  let recipeB: string;
  let presetAId: string;

  beforeAll(async () => {
    const test = await createTestDb();
    pClient = test.client;
    pDb = test.db as unknown as TenantDb;

    // Seed a recipe + preset per org as superuser (bypasses RLS).
    const [rA] = await pDb
      .insert(recipes)
      .values({ organizationId: ORG_A, name: 'Preset recipe A' })
      .returning();
    const [rB] = await pDb
      .insert(recipes)
      .values({ organizationId: ORG_B, name: 'Preset recipe B' })
      .returning();
    recipeA = rA!.id;
    recipeB = rB!.id;

    const [pA] = await pDb
      .insert(recipePresets)
      .values({
        organizationId: ORG_A,
        recipeId: recipeA,
        name: 'A preset',
        targetWeightGrams: 1000,
      })
      .returning();
    presetAId = pA!.id;
    await pDb.insert(recipePresets).values({
      organizationId: ORG_B,
      recipeId: recipeB,
      name: 'B preset',
      targetWeightGrams: 2000,
    });
  });

  afterAll(async () => {
    await pClient.close();
  });

  it('rejects a preset that links to another org\'s recipe (composite FK)', async () => {
    // An org A preset pointing at org B's recipe has no matching composite parent
    // row, so the DB itself rejects the cross-tenant link.
    await expect(
      pDb.insert(recipePresets).values({
        organizationId: ORG_A,
        recipeId: recipeB,
        name: 'Smuggled link',
        targetWeightGrams: 100,
      }),
    ).rejects.toThrow();
  });

  describe('with RLS enforced (non-privileged role)', () => {
    beforeAll(async () => {
      await pDb.execute(sql.raw('SET ROLE tenant_app;'));
    });
    afterAll(async () => {
      await pDb.execute(sql.raw('RESET ROLE;'));
    });

    it('SELECT only returns the active org\'s presets', async () => {
      const orgs = await runInOrg(pDb, ORG_A, async (tx) =>
        (
          await tx
            .select({ org: recipePresets.organizationId })
            .from(recipePresets)
        ).map((r) => r.org),
      );
      expect(orgs.length).toBeGreaterThan(0);
      expect(orgs.every((o) => o === ORG_A)).toBe(true);
    });

    it('rejects an INSERT carrying another org id (WITH CHECK)', async () => {
      await expect(
        runInOrg(pDb, ORG_A, (tx) =>
          tx.insert(recipePresets).values({
            organizationId: ORG_B,
            recipeId: recipeB,
            name: 'Smuggled',
            targetWeightGrams: 100,
          }),
        ),
      ).rejects.toThrow();
    });

    it('rejects re-tagging a preset to another org via UPDATE (WITH CHECK)', async () => {
      await expect(
        runInOrg(pDb, ORG_A, (tx) =>
          tx
            .update(recipePresets)
            .set({ organizationId: ORG_B })
            .where(eq(recipePresets.id, presetAId)),
        ),
      ).rejects.toThrow();
    });

    it("a DELETE cannot reach another org's preset (USING hides it → 0 rows)", async () => {
      const deleted = await runInOrg(pDb, ORG_A, (tx) =>
        tx
          .delete(recipePresets)
          .where(eq(recipePresets.organizationId, ORG_B))
          .returning({ id: recipePresets.id }),
      );
      expect(deleted).toHaveLength(0);
    });
  });
});

describe('recipe_components — org isolation + cross-org integrity (sub-recipes)', () => {
  let cClient: PGlite;
  let cDb: TenantDb;
  let parentA: string;
  let childA: string;
  let parentB: string;
  let childB: string;
  let lineAId: string;

  beforeAll(async () => {
    const test = await createTestDb();
    cClient = test.client;
    cDb = test.db as unknown as TenantDb;

    // Seed two recipes per org as superuser (bypasses RLS); children carry the
    // positive finished yield weight required of a component recipe.
    const inserted = await cDb
      .insert(recipes)
      .values([
        { organizationId: ORG_A, name: 'Parent A' },
        { organizationId: ORG_A, name: 'Child A', yieldWeightGrams: 500 },
        { organizationId: ORG_B, name: 'Parent B' },
        { organizationId: ORG_B, name: 'Child B', yieldWeightGrams: 800 },
      ])
      .returning();
    const byName = (n: string) => {
      const row = inserted.find((r) => r.name === n);
      if (!row) throw new Error(`seed: missing recipe ${n}`);
      return row.id;
    };
    parentA = byName('Parent A');
    childA = byName('Child A');
    parentB = byName('Parent B');
    childB = byName('Child B');

    const [lineA] = await cDb
      .insert(recipeComponents)
      .values({
        organizationId: ORG_A,
        recipeId: parentA,
        componentRecipeId: childA,
        quantityGrams: 250,
      })
      .returning();
    lineAId = lineA!.id;
    await cDb.insert(recipeComponents).values({
      organizationId: ORG_B,
      recipeId: parentB,
      componentRecipeId: childB,
      quantityGrams: 100,
    });
  });

  afterAll(async () => {
    await cClient.close();
  });

  it("rejects a component line linking to another org's recipe (composite FK)", async () => {
    await expect(
      cDb.insert(recipeComponents).values({
        organizationId: ORG_A,
        recipeId: parentA,
        componentRecipeId: childB,
        quantityGrams: 100,
      }),
    ).rejects.toThrow();
  });

  it('rejects a self-referencing component line (CHECK)', async () => {
    await expect(
      cDb.insert(recipeComponents).values({
        organizationId: ORG_A,
        recipeId: parentA,
        componentRecipeId: parentA,
        quantityGrams: 100,
      }),
    ).rejects.toThrow();
  });

  it('rejects a non-positive quantity (CHECK)', async () => {
    await expect(
      cDb.insert(recipeComponents).values({
        organizationId: ORG_A,
        recipeId: childA,
        componentRecipeId: parentA,
        quantityGrams: 0,
      }),
    ).rejects.toThrow();
  });

  it('rejects a duplicate (parent, component) line (UNIQUE)', async () => {
    await expect(
      cDb.insert(recipeComponents).values({
        organizationId: ORG_A,
        recipeId: parentA,
        componentRecipeId: childA,
        quantityGrams: 999,
      }),
    ).rejects.toThrow();
  });

  it('blocks purging a recipe still referenced as a component (ON DELETE restrict)', async () => {
    await expect(
      cDb.delete(recipes).where(eq(recipes.id, childA)),
    ).rejects.toThrow();
  });

  it('purging a parent cascades its outgoing component lines (ON DELETE cascade)', async () => {
    const [tempParent] = await cDb
      .insert(recipes)
      .values({ organizationId: ORG_A, name: 'Temp parent A' })
      .returning();
    const [tempLine] = await cDb
      .insert(recipeComponents)
      .values({
        organizationId: ORG_A,
        recipeId: tempParent!.id,
        componentRecipeId: childA,
        quantityGrams: 10,
      })
      .returning();
    await cDb.delete(recipes).where(eq(recipes.id, tempParent!.id));
    const survivors = await cDb
      .select({ id: recipeComponents.id })
      .from(recipeComponents)
      .where(eq(recipeComponents.id, tempLine!.id));
    expect(survivors).toHaveLength(0);
  });

  describe('with RLS enforced (non-privileged role)', () => {
    beforeAll(async () => {
      await cDb.execute(sql.raw('SET ROLE tenant_app;'));
    });
    afterAll(async () => {
      await cDb.execute(sql.raw('RESET ROLE;'));
    });

    it("SELECT only returns the active org's component lines", async () => {
      const orgs = await runInOrg(cDb, ORG_A, async (tx) =>
        (
          await tx
            .select({ org: recipeComponents.organizationId })
            .from(recipeComponents)
        ).map((r) => r.org),
      );
      expect(orgs.length).toBeGreaterThan(0);
      expect(orgs.every((o) => o === ORG_A)).toBe(true);
    });

    it('rejects an INSERT carrying another org id (WITH CHECK)', async () => {
      await expect(
        runInOrg(cDb, ORG_A, (tx) =>
          tx.insert(recipeComponents).values({
            organizationId: ORG_B,
            recipeId: parentB,
            componentRecipeId: childB,
            quantityGrams: 50,
          }),
        ),
      ).rejects.toThrow();
    });

    it('rejects re-tagging a component line to another org via UPDATE (WITH CHECK)', async () => {
      await expect(
        runInOrg(cDb, ORG_A, (tx) =>
          tx
            .update(recipeComponents)
            .set({ organizationId: ORG_B })
            .where(eq(recipeComponents.id, lineAId)),
        ),
      ).rejects.toThrow();
    });

    it("a DELETE cannot reach another org's component line (USING hides it → 0 rows)", async () => {
      const deleted = await runInOrg(cDb, ORG_A, (tx) =>
        tx
          .delete(recipeComponents)
          .where(eq(recipeComponents.organizationId, ORG_B))
          .returning({ id: recipeComponents.id }),
      );
      expect(deleted).toHaveLength(0);
    });
  });
});
