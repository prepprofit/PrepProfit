import { describe, expect, it } from 'vitest';
import { businessTables } from './schema';
import {
  NON_TENANT_RUNTIME_TABLES,
  describeRuntimeAccessFailure,
  findMissingGrants,
  findRlsGaps,
  runtimeGrantedTables,
  type TableAccessRow,
} from './runtime-grants';

/** A fully healthy catalogue row — the shape the checks expect to see everywhere. */
function healthy(table: string): TableAccessRow {
  return {
    table,
    select: true,
    insert: true,
    update: true,
    delete: true,
    rlsEnabled: true,
    rlsForced: true,
    policies: 1,
  };
}

/** The catalogue of a correctly migrated database. */
function healthyCatalogue(): TableAccessRow[] {
  return runtimeGrantedTables().map(healthy);
}

describe('runtimeGrantedTables', () => {
  it('covers every business table plus the two RLS-free infra tables', () => {
    const tables = runtimeGrantedTables();

    expect(tables).toEqual([...businessTables, ...NON_TENANT_RUNTIME_TABLES]);
    // rate_limits is reached BEFORE any withOrg, so losing access to it breaks every
    // rate-limited route — it must never drop off this list (Rule 1's exception).
    expect(tables).toContain('rate_limits');
  });
});

describe('findMissingGrants', () => {
  it('passes a healthy catalogue', () => {
    expect(findMissingGrants(healthyCatalogue())).toEqual([]);
  });

  it('reports the exact privileges a table is missing', () => {
    const rows = healthyCatalogue();
    const target = rows.find((r) => r.table === 'recipes')!;
    target.insert = false;
    target.delete = false;

    expect(findMissingGrants(rows)).toEqual([
      { table: 'recipes', missing: ['insert', 'delete'] },
    ]);
  });

  it('treats a table absent from the database as missing everything', () => {
    // The case this guard exists for: a new sprint's table that never got a GRANT —
    // or, as here, never got created at all.
    const rows = healthyCatalogue().filter((r) => r.table !== 'ingredients');

    expect(findMissingGrants(rows)).toEqual([
      { table: 'ingredients', missing: ['select', 'insert', 'update', 'delete'] },
    ]);
  });

  it('ignores tables outside the runtime set', () => {
    const rows = [...healthyCatalogue(), { ...healthy('__drizzle_extra'), select: false }];

    expect(findMissingGrants(rows)).toEqual([]);
  });
});

describe('findRlsGaps', () => {
  it('passes a healthy catalogue', () => {
    expect(findRlsGaps(healthyCatalogue())).toEqual([]);
  });

  it('flags a business table with RLS enabled but not forced', () => {
    const rows = healthyCatalogue();
    rows.find((r) => r.table === 'recipes')!.rlsForced = false;

    expect(findRlsGaps(rows)).toEqual([
      { table: 'recipes', problems: ['RLS not forced'] },
    ]);
  });

  it('flags a business table with no policies', () => {
    const rows = healthyCatalogue();
    rows.find((r) => r.table === 'invoices')!.policies = 0;

    expect(findRlsGaps(rows)).toEqual([
      { table: 'invoices', problems: ['no policies'] },
    ]);
  });

  it('accumulates every problem on the same table', () => {
    const rows = healthyCatalogue();
    const target = rows.find((r) => r.table === 'transactions')!;
    target.rlsEnabled = false;
    target.rlsForced = false;
    target.policies = 0;

    expect(findRlsGaps(rows)).toEqual([
      {
        table: 'transactions',
        problems: ['RLS not enabled', 'RLS not forced', 'no policies'],
      },
    ]);
  });

  it('does not require RLS on the infra tables that deliberately have none', () => {
    const rows = healthyCatalogue().map((r) =>
      (NON_TENANT_RUNTIME_TABLES as readonly string[]).includes(r.table)
        ? { ...r, rlsEnabled: false, rlsForced: false, policies: 0 }
        : r,
    );

    expect(findRlsGaps(rows)).toEqual([]);
  });
});

describe('describeRuntimeAccessFailure', () => {
  it('gives the operator the failing tables and the SQL that fixes them', () => {
    const text = describeRuntimeAccessFailure(
      'app_runtime',
      [{ table: 'recipes', missing: ['insert'] }],
      [{ table: 'invoices', problems: ['no policies'] }],
    );

    expect(text).toContain('recipes — missing insert');
    expect(text).toContain('GRANT SELECT, INSERT, UPDATE, DELETE');
    expect(text).toContain('ALTER DEFAULT PRIVILEGES');
    expect(text).toContain('invoices — no policies');
  });

  it('mentions only the section that actually failed', () => {
    const text = describeRuntimeAccessFailure(
      'app_runtime',
      [{ table: 'recipes', missing: ['insert'] }],
      [],
    );

    expect(text).toContain('missing privileges');
    expect(text).not.toContain('Row-Level Security is not fully armed');
  });
});
