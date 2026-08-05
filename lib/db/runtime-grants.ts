/**
 * Post-migration verification of what the runtime role needs (RLS regression guard,
 * plan §B). Pure comparison logic — `scripts/migrate.ts` does the querying, this
 * module decides whether the answer is acceptable, so it is unit-testable without a
 * database (same split as `findSkippableMigrations` in lib/db/migrate-guard.ts).
 *
 * WHY this exists, and why it is the piece most likely to save an outage: since the
 * app stopped connecting as the table owner (2026-08-04), a table it has no GRANT on
 * is a runtime `permission denied for table X` — visible only to the user, after the
 * deploy. `ALTER DEFAULT PRIVILEGES` covers the normal case (a migration creating a
 * table as the owner) but not a table created by another role, a revoked grant, or a
 * schema other than `public`. Checking at migrate time turns that into a failed deploy.
 *
 * It also re-checks that RLS is enabled AND forced with at least one policy on every
 * business table, which is cheap here and catches a table that slipped out of
 * `rlsStatements`.
 */

import { businessTables } from './schema';

/**
 * Tables the runtime role must reach but that carry NO `organization_id` and get no
 * RLS (documented Rule 1 exceptions): the rate limiter runs before any `withOrg`, and
 * the Open Food Facts cache is read directly.
 */
export const NON_TENANT_RUNTIME_TABLES = [
  'rate_limits',
  'external_food_cache',
] as const;

/** Every table the runtime role must hold SELECT/INSERT/UPDATE/DELETE on. */
export function runtimeGrantedTables(): string[] {
  return [...businessTables, ...NON_TENANT_RUNTIME_TABLES];
}

/** The four DML privileges the runtime role needs on every table it touches. */
export const REQUIRED_PRIVILEGES = ['select', 'insert', 'update', 'delete'] as const;
export type Privilege = (typeof REQUIRED_PRIVILEGES)[number];

/** One row of the catalogue query in `scripts/migrate.ts`, per table in `public`. */
export type TableAccessRow = {
  table: string;
  select: boolean;
  insert: boolean;
  update: boolean;
  delete: boolean;
  /** `relrowsecurity` — RLS enabled. */
  rlsEnabled: boolean;
  /** `relforcerowsecurity` — applies to the table owner too. */
  rlsForced: boolean;
  /** How many policies exist on the table. */
  policies: number;
};

/** A table the runtime role cannot fully use, with the privileges it is missing. */
export type MissingGrant = { table: string; missing: Privilege[] };

/** A business table whose RLS is not in the expected `enabled + forced + policy` state. */
export type RlsGap = { table: string; problems: string[] };

/**
 * Tables the runtime role is missing privileges on. A table that is expected but
 * absent from `rows` is reported as missing ALL privileges — that means the migration
 * did not create it, which is just as broken as a missing GRANT.
 */
export function findMissingGrants(rows: TableAccessRow[]): MissingGrant[] {
  const byTable = new Map(rows.map((r) => [r.table, r]));

  return runtimeGrantedTables().flatMap((table) => {
    const row = byTable.get(table);
    if (!row) return [{ table, missing: [...REQUIRED_PRIVILEGES] }];

    const missing = REQUIRED_PRIVILEGES.filter((p) => !row[p]);
    return missing.length > 0 ? [{ table, missing }] : [];
  });
}

/**
 * Business tables whose row-level security is not fully armed. `FORCE` matters as much
 * as `ENABLE`: without it the policies would not apply to the table owner, which is
 * exactly the hole this whole migration closed.
 */
export function findRlsGaps(rows: TableAccessRow[]): RlsGap[] {
  const byTable = new Map(rows.map((r) => [r.table, r]));

  return businessTables.flatMap((table) => {
    const row = byTable.get(table);
    if (!row) return [{ table, problems: ['table is missing from the database'] }];

    const problems: string[] = [];
    if (!row.rlsEnabled) problems.push('RLS not enabled');
    if (!row.rlsForced) problems.push('RLS not forced');
    if (row.policies === 0) problems.push('no policies');
    return problems.length > 0 ? [{ table, problems }] : [];
  });
}

/** Operator-facing report, with the exact SQL to fix the grants. */
export function describeRuntimeAccessFailure(
  role: string,
  missingGrants: MissingGrant[],
  rlsGaps: RlsGap[],
): string {
  const lines: string[] = [];

  if (missingGrants.length > 0) {
    lines.push(
      `✗ Role "${role}" is missing privileges on ${missingGrants.length} table(s):`,
      ...missingGrants.map((g) => `    ${g.table} — missing ${g.missing.join(', ')}`),
      '',
      '  Fix (as the owner, on the same database):',
      `    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role};`,
      '',
      '  If this keeps happening, the ALTER DEFAULT PRIVILEGES grant is not in place:',
      `    ALTER DEFAULT PRIVILEGES IN SCHEMA public`,
      `      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role};`,
    );
  }

  if (rlsGaps.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(
      `✗ Row-Level Security is not fully armed on ${rlsGaps.length} business table(s):`,
      ...rlsGaps.map((g) => `    ${g.table} — ${g.problems.join('; ')}`),
      '',
      '  Every business table must be in `businessTables` so lib/db/rls.ts generates its',
      '  policies. Re-running `npm run db:migrate` re-applies them idempotently.',
    );
  }

  return lines.join('\n');
}
