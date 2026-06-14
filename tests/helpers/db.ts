import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { rlsStatements } from '@/lib/db/rls';

/**
 * Cria um Postgres real em memória (PGlite/WASM), aplica as MESMAS migrations
 * de produção (drizzle/) e as policies de RLS. Permite testar o isolamento
 * multi-tenant sem depender de um banco externo (roda em CI sem segredos).
 */
export async function createTestDb() {
  const client = new PGlite();
  const db = drizzle(client, { schema });

  await migrate(db, { migrationsFolder: './drizzle' });

  for (const statement of rlsStatements) {
    await db.execute(sql.raw(statement));
  }

  // Papel sem privilégios para exercitar RLS de verdade — o superusuário padrão
  // do PGlite ignora RLS (inclusive FORCE), igual a um superuser no Postgres.
  await db.execute(sql.raw('CREATE ROLE tenant_app NOLOGIN;'));
  await db.execute(
    sql.raw(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO tenant_app;',
    ),
  );

  return { client, db };
}
