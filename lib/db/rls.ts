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
 */
export const rlsStatements: string[] = businessTables.flatMap((table) => [
  `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`,
  `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`,
  `DROP POLICY IF EXISTS org_isolation ON ${table};`,
  `CREATE POLICY org_isolation ON ${table}
     USING (organization_id = current_setting('app.current_org_id', true))
     WITH CHECK (organization_id = current_setting('app.current_org_id', true));`,
]);
