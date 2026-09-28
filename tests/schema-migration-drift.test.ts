import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import { is } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb } from "./helpers/db";
import * as schema from "@/lib/db/schema";
import type { TenantDb } from "@/lib/db/tenant";
import { runInOrg } from "@/lib/db/tenant";
import { createRecipe, listRecipes } from "@/lib/data/recipes";

// Regression: production served "column recipes.display_unit does not exist" on
// /recipes because the Drizzle schema selected a column whose migration (0056)
// was not applied to the live database. Every Drizzle `select()` names all of a
// table's columns, so any schema column without a migration breaks the page.
describe("drizzle schema vs migrated database", () => {
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

  it("every column declared in schema.ts exists after applying all migrations", async () => {
    const tables = Object.values(schema).filter((t) =>
      is(t, PgTable),
    ) as unknown as PgTable[];
    expect(tables.length).toBeGreaterThan(50);

    const { rows } = await client.query<{
      table_name: string;
      column_name: string;
    }>(
      `select table_name, column_name from information_schema.columns where table_schema = 'public'`,
    );
    const actual = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));

    const missing: string[] = [];
    for (const table of tables) {
      const config = getTableConfig(table);
      for (const column of config.columns) {
        const key = `${config.name}.${column.name}`;
        if (!actual.has(key)) missing.push(key);
      }
    }

    expect(missing).toEqual([]);
  });

  it("lists recipes (all columns) including display_unit defaulting to g", async () => {
    const orgId = "org_drift";
    await createRecipe(db, orgId, { name: "Drift check" });

    const rows = await runInOrg(db, orgId, (tx) => listRecipes(tx, orgId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.displayUnit).toBe("g");
  });
});
