import { readFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { migrate } from 'drizzle-orm/neon-http/migrator';
import { sql } from 'drizzle-orm';
import { rlsStatements } from '../lib/db/rls';
import { businessTables } from '../lib/db/schema';
import {
  findSkippableMigrations,
  describeSkippable,
  type JournalEntry,
} from '../lib/db/migrate-guard';
import { RUNTIME_DB_ROLE } from '../lib/db/runtime-role';
import {
  describeRuntimeAccessFailure,
  findMissingGrants,
  findRlsGaps,
  runtimeGrantedTables,
  type TableAccessRow,
} from '../lib/db/runtime-grants';

function loadEnv() {
  try {
    process.loadEnvFile('.env.local');
  } catch {
    // .env.local is optional when DATABASE_URL is already in the environment
  }
}

type Db = ReturnType<typeof drizzle>;

/**
 * Abort before migrating if any journal entry would be silently skipped (its
 * `when` ≤ the max already-applied `created_at`). Kills the migration-timestamp
 * gotcha that broke prod on 0006 and 0008 (see lib/db/migrate-guard.ts).
 */
async function assertJournalOrdering(db: Db) {
  const journal = JSON.parse(
    readFileSync('./drizzle/meta/_journal.json', 'utf8'),
  ) as { entries: JournalEntry[] };

  // On a fresh database the migrations table does not exist yet → all entries
  // apply in idx order, nothing to check.
  const reg = await db.execute<{ reg: string | null }>(
    sql`select to_regclass('drizzle.__drizzle_migrations') as reg`,
  );
  if (!reg.rows[0]?.reg) return;

  const applied = await db.execute<{ created_at: string }>(
    sql`select created_at from drizzle.__drizzle_migrations`,
  );
  const appliedWhens = applied.rows.map((r) => Number(r.created_at));

  const skippable = findSkippableMigrations(journal.entries, appliedWhens);
  if (skippable.length > 0) {
    console.error(describeSkippable(skippable));
    process.exit(1);
  }
  console.log(
    `✓ Journal ordering OK (${journal.entries.length} entries; max applied created_at ${
      appliedWhens.length ? Math.max(...appliedWhens) : 0
    }).`,
  );
}

/**
 * Verify, after migrating, that the RUNTIME role can still use every table and that
 * RLS is armed on every business table (see lib/db/runtime-grants.ts for the why).
 *
 * This script runs as the OWNER, which is the only role that can see the whole
 * catalogue and fix a grant — so this is the right place, and the deploy is the right
 * moment: a missing GRANT surfaces here instead of as `permission denied` in front of
 * a user.
 *
 * When the runtime role does not exist (local dev, CI, a fresh branch) the check warns
 * and skips: those databases legitimately have a single role. Set
 * `EXPECT_APP_RUNTIME_ROLE=1` to make its absence an error, which production should do.
 */
async function assertRuntimeRoleAccess(db: Db) {
  const roleRow = await db.execute<{ bypasses: boolean }>(
    sql`select rolbypassrls as bypasses from pg_roles where rolname = ${RUNTIME_DB_ROLE}`,
  );

  if (!roleRow.rows[0]) {
    const message = `Role "${RUNTIME_DB_ROLE}" does not exist on this database.`;
    if (process.env.EXPECT_APP_RUNTIME_ROLE === '1') {
      console.error(`✗ ${message} Refusing to continue (EXPECT_APP_RUNTIME_ROLE=1).`);
      process.exit(1);
    }
    console.warn(`⚠ ${message} Skipping the runtime-access check.`);
    return;
  }

  if (roleRow.rows[0].bypasses) {
    console.error(
      `✗ Role "${RUNTIME_DB_ROLE}" has BYPASSRLS — RLS would not be enforced for the app.\n` +
        `  Fix: ALTER ROLE ${RUNTIME_DB_ROLE} NOBYPASSRLS;`,
    );
    process.exit(1);
  }

  // One catalogue pass: privileges, RLS flags and policy counts for every table in
  // `public`. Comparing happens in lib/db/runtime-grants.ts, which is unit-tested.
  const catalogue = await db.execute<TableAccessRow>(sql`
    select c.relname                                          as table,
           has_table_privilege(${RUNTIME_DB_ROLE}, c.oid, 'SELECT') as select,
           has_table_privilege(${RUNTIME_DB_ROLE}, c.oid, 'INSERT') as insert,
           has_table_privilege(${RUNTIME_DB_ROLE}, c.oid, 'UPDATE') as update,
           has_table_privilege(${RUNTIME_DB_ROLE}, c.oid, 'DELETE') as delete,
           c.relrowsecurity                                   as "rlsEnabled",
           c.relforcerowsecurity                              as "rlsForced",
           (select count(*) from pg_policy p where p.polrelid = c.oid)::int as policies
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
  `);

  const missingGrants = findMissingGrants(catalogue.rows);
  const rlsGaps = findRlsGaps(catalogue.rows);

  if (missingGrants.length > 0 || rlsGaps.length > 0) {
    console.error(
      describeRuntimeAccessFailure(RUNTIME_DB_ROLE, missingGrants, rlsGaps),
    );
    process.exit(1);
  }

  console.log(
    `✓ Runtime role "${RUNTIME_DB_ROLE}" OK (NOBYPASSRLS; DML on ${
      runtimeGrantedTables().length
    } tables; RLS enabled + forced on ${businessTables.length} business tables).`,
  );
}

async function main() {
  loadEnv();
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env.local and fill it in (see SETUP.md).',
    );
  }

  const db = drizzle(neon(url));

  console.log('▶ Checking migration journal ordering...');
  await assertJournalOrdering(db);

  console.log('▶ Applying schema migrations...');
  await migrate(db, { migrationsFolder: './drizzle' });

  console.log('▶ Applying Row-Level Security policies...');
  for (const statement of rlsStatements) {
    await db.execute(sql.raw(statement));
  }

  console.log('▶ Verifying runtime role access...');
  await assertRuntimeRoleAccess(db);

  console.log('✓ Migrations + RLS applied.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
