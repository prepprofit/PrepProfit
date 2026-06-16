import { readFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { migrate } from 'drizzle-orm/neon-http/migrator';
import { sql } from 'drizzle-orm';
import { rlsStatements } from '../lib/db/rls';
import {
  findSkippableMigrations,
  describeSkippable,
  type JournalEntry,
} from '../lib/db/migrate-guard';

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

  console.log('✓ Migrations + RLS applied.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
