import { sql, type ExtractTablesWithRelations } from 'drizzle-orm';
import type {
  PgDatabase,
  PgQueryResultHKT,
  PgTransaction,
} from 'drizzle-orm/pg-core';
import type * as schema from './schema';

type Schema = typeof schema;

/** Cliente Drizzle (qualquer driver Postgres) com o nosso schema. */
export type TenantDb = PgDatabase<
  PgQueryResultHKT,
  Schema,
  ExtractTablesWithRelations<Schema>
>;

/** Transação Drizzle escopada a uma organização. */
export type TenantTx = PgTransaction<
  PgQueryResultHKT,
  Schema,
  ExtractTablesWithRelations<Schema>
>;

/** Cliente OU transação — o que as funções de acesso a dados aceitam. */
export type TenantClient = TenantDb | TenantTx;

/**
 * Executa `fn` dentro de uma transação com a GUC `app.current_org_id` definida,
 * ativando as policies de RLS (lib/db/rls.ts) para a organização informada.
 * Toda leitura/escrita de dados de negócio em runtime deve passar por aqui.
 */
export async function runInOrg<T>(
  database: TenantDb,
  organizationId: string,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  return database.transaction(async (tx) => {
    // `set_config(..., true)` = escopo da transação (equivalente a SET LOCAL),
    // e aceita parâmetro vinculado (SET LOCAL não aceita).
    await tx.execute(
      sql`select set_config('app.current_org_id', ${organizationId}, true)`,
    );
    return fn(tx as unknown as TenantTx);
  });
}
