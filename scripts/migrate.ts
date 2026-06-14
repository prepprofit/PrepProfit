import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { migrate } from 'drizzle-orm/neon-http/migrator';
import { sql } from 'drizzle-orm';
import { rlsStatements } from '../lib/db/rls';

function loadEnv() {
  try {
    process.loadEnvFile('.env.local');
  } catch {
    // .env.local is optional when DATABASE_URL is already in the environment
  }
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
