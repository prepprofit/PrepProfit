import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { rlsStatements } from '@/lib/db/rls';

/**
 * Creates a real in-memory Postgres (PGlite/WASM), applies the SAME production
 * migrations (drizzle/) and the RLS policies. Lets us test multi-tenant
 * isolation without an external database (runs in CI without secrets).
 */
export async function createTestDb() {
  const client = new PGlite();
  const db = drizzle(client, { schema });

  await migrate(db, { migrationsFolder: './drizzle' });

  for (const statement of rlsStatements) {
    await db.execute(sql.raw(statement));
  }

  // Non-privileged role to actually exercise RLS — PGlite's default superuser
  // bypasses RLS (including FORCE), just like a superuser in Postgres.
  await db.execute(sql.raw('CREATE ROLE tenant_app NOLOGIN;'));
  await db.execute(
    sql.raw(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO tenant_app;',
    ),
  );

  return { client, db };
}
