import { businessTables } from './schema';

/**
 * Row-Level Security — the second layer of multi-tenant defense.
 *
 * Each business table only exposes rows whose `organization_id` matches the
 * `app.current_org_id` GUC, set per transaction by `runInOrg()` (see
 * lib/db/tenant.ts). If the GUC is not set, `current_setting(..., true)` returns
 * NULL and no row passes — secure by default.
 *
 * `FORCE ROW LEVEL SECURITY` makes the policy apply even to the table owner
 * (the role the app uses on Neon), not only to non-privileged roles.
 *
 * Statements are generated from `businessTables` so no business table can be
 * left without isolation.
 *
 * APPEND-ONLY EXCEPTION (`audit_log`, `inventory_movements`): instead of the
 * generic `FOR ALL` policy, these get SELECT-only and INSERT-only policies. With
 * FORCE RLS and no UPDATE or DELETE policy, those commands match zero rows — the
 * trail can never be mutated or erased, not even by the app role. Org isolation
 * still holds via the same `organization_id = current_setting(...)` predicate.
 *
 * `inventory_movements` is append-only by the same rule (Sprint F1): the stock
 * ledger is authoritative, so corrections are equal-and-opposite INSERTS, never
 * edits/deletes. Cascade deletes via the ingredient FK are a referential action,
 * NOT an RLS-checked DELETE, so purging an ingredient still removes its movements.
 */

/** Tables whose RLS is append-only (SELECT + INSERT, never UPDATE/DELETE). */
const APPEND_ONLY_TABLES = new Set<string>(['audit_log', 'inventory_movements']);

/** Enable + force RLS on a table (shared prologue for every policy set). */
function enableForce(table: string): string[] {
  return [
    `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`,
  ];
}

/** The standard org-isolation policy: read + write the active org's rows only. */
function orgIsolationPolicy(table: string): string[] {
  return [
    ...enableForce(table),
    `DROP POLICY IF EXISTS org_isolation ON ${table};`,
    `CREATE POLICY org_isolation ON ${table}
       USING (organization_id = current_setting('app.current_org_id', true))
       WITH CHECK (organization_id = current_setting('app.current_org_id', true));`,
  ];
}

/**
 * Append-only org isolation: rows of the active org are readable and insertable,
 * but there is NO update/delete policy, so those commands affect zero rows under
 * FORCE RLS. Drop the generic `org_isolation` too, in case a prior deploy created
 * it (idempotent re-runs).
 */
function appendOnlyPolicy(table: string): string[] {
  return [
    ...enableForce(table),
    `DROP POLICY IF EXISTS org_isolation ON ${table};`,
    `DROP POLICY IF EXISTS org_isolation_select ON ${table};`,
    `DROP POLICY IF EXISTS org_isolation_insert ON ${table};`,
    `CREATE POLICY org_isolation_select ON ${table}
       FOR SELECT
       USING (organization_id = current_setting('app.current_org_id', true));`,
    `CREATE POLICY org_isolation_insert ON ${table}
       FOR INSERT
       WITH CHECK (organization_id = current_setting('app.current_org_id', true));`,
  ];
}

export const rlsStatements: string[] = businessTables.flatMap((table) =>
  APPEND_ONLY_TABLES.has(table)
    ? appendOnlyPolicy(table)
    : orgIsolationPolicy(table),
);
