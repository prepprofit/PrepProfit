import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import { ingredients, recipes } from '@/lib/db/schema';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import {
  createIngredient,
  getIngredientById,
  listIngredients,
} from '@/lib/data/ingredients';
import { listRecipes } from '@/lib/data/recipes';

const ORG_A = 'org_a';
const ORG_B = 'org_b';

let client: PGlite;
let db: TenantDb;
let ingredientBId: string;

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  db = test.db as unknown as TenantDb;

  // Seed como superusuário (ignora RLS) — dados distintos por organização.
  await createIngredient(db, ORG_A, {
    name: 'Farinha A',
    unit: 'kg',
    priceType: 'per_kg',
    priceCents: 120,
  });

  const b = await createIngredient(db, ORG_B, {
    name: 'Chocolate B',
    unit: 'kg',
    priceType: 'per_kg',
    priceCents: 950,
  });
  ingredientBId = b.id;

  await db.insert(recipes).values([
    { organizationId: ORG_A, name: 'Pão A' },
    { organizationId: ORG_B, name: 'Bolo B' },
  ]);
});

afterAll(async () => {
  await client.close();
});

describe('camada de aplicação — escopo por organization_id', () => {
  it('org A só enxerga os próprios ingredientes', async () => {
    const rows = await listIngredients(db, ORG_A);
    expect(rows.map((r) => r.name)).toEqual(['Farinha A']);
  });

  it('org B só enxerga os próprios ingredientes', async () => {
    const rows = await listIngredients(db, ORG_B);
    expect(rows.map((r) => r.name)).toEqual(['Chocolate B']);
  });

  it('org A NÃO consegue buscar um ingrediente da org B pelo id', async () => {
    const stolen = await getIngredientById(db, ORG_A, ingredientBId);
    expect(stolen).toBeNull();
  });

  it('cada org vê apenas as próprias receitas', async () => {
    const recipesA = await listRecipes(db, ORG_A);
    const recipesB = await listRecipes(db, ORG_B);
    expect(recipesA.map((r) => r.name)).toEqual(['Pão A']);
    expect(recipesB.map((r) => r.name)).toEqual(['Bolo B']);
  });
});

describe('camada de banco — Row-Level Security (segunda defesa)', () => {
  // Assume o papel sem privilégio para que as policies de RLS sejam aplicadas.
  beforeAll(async () => {
    await db.execute(sql.raw('SET ROLE tenant_app;'));
  });
  afterAll(async () => {
    await db.execute(sql.raw('RESET ROLE;'));
  });

  it('com a org A no contexto, um SELECT sem filtro só retorna linhas da org A', async () => {
    const orgIds = await runInOrg(db, ORG_A, async (tx) => {
      const result = await tx
        .select({ organizationId: ingredients.organizationId })
        .from(ingredients);
      return result.map((r) => r.organizationId);
    });
    expect(orgIds.length).toBeGreaterThan(0);
    expect(orgIds.every((id) => id === ORG_A)).toBe(true);
  });

  it('com a org B no contexto, um SELECT sem filtro só retorna linhas da org B', async () => {
    const orgIds = await runInOrg(db, ORG_B, async (tx) => {
      const result = await tx
        .select({ organizationId: ingredients.organizationId })
        .from(ingredients);
      return result.map((r) => r.organizationId);
    });
    expect(orgIds.every((id) => id === ORG_B)).toBe(true);
    expect(orgIds).not.toContain(ORG_A);
  });

  it('sem contexto de organização, RLS bloqueia tudo (seguro por padrão)', async () => {
    const rows = await db.select().from(ingredients);
    expect(rows).toHaveLength(0);
  });
});
