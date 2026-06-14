import { sql, type ExtractTablesWithRelations } from 'drizzle-orm';
import type {
  PgDatabase,
  PgQueryResultHKT,
  PgTransaction,
} from 'drizzle-orm/pg-core';
import type * as schema from './schema';

type Schema = typeof schema;

/** Drizzle client (any Postgres driver) bound to our schema. */
export type TenantDb = PgDatabase<
  PgQueryResultHKT,
  Schema,
  ExtractTablesWithRelations<Schema>
>;

/** Drizzle transaction scoped to one organization. */
export type TenantTx = PgTransaction<
  PgQueryResultHKT,
  Schema,
  ExtractTablesWithRelations<Schema>
>;

/** Client OR transaction — what the data-access functions accept. */
export type TenantClient = TenantDb | TenantTx;

/**
 * Runs `fn` inside a transaction with the `app.current_org_id` GUC set,
 * activating the RLS policies (lib/db/rls.ts) for the given organization. Every
 * runtime read/write of business data must go through here.
 */
export async function runInOrg<T>(
  database: TenantDb,
  organizationId: string,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  return database.transaction(async (tx) => {
    // `set_config(..., true)` = transaction scope (equivalent to SET LOCAL),
    // and accepts a bound parameter (SET LOCAL does not).
    await tx.execute(
      sql`select set_config('app.current_org_id', ${organizationId}, true)`,
    );
    return fn(tx as unknown as TenantTx);
  });
}
