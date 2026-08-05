/**
 * The runtime role guard (RLS regression guard, plan §A).
 *
 * Production connects as `app_runtime`, a role WITHOUT `BYPASSRLS`, so the policies
 * in `lib/db/rls.ts` actually filter. That property lives in an environment variable
 * (`DATABASE_URL` in Coolify), not in this repository — no unit test can reach it, and
 * pointing it back at the owner role would silently disable RLS everywhere while the
 * app kept working perfectly. See `docs/rls-regression-guard-plan.md`.
 *
 * So we ask the database itself, once per server boot, and shout if the answer is wrong.
 *
 * FAIL-OPEN by decision (plan D1): a wrong role is a defense-in-depth regression, not
 * data corruption — Rule 1's explicit `organization_id` filter still scopes every query.
 * A network hiccup at boot must not take production down, and a boot that crash-loops on
 * a database probe is a self-inflicted outage. We log loudly (and to Sentry) instead.
 */

import { sql, type SQL } from 'drizzle-orm';
import { logError } from '../observability';

/** The role production is expected to connect as. */
export const RUNTIME_DB_ROLE = 'app_runtime';

export type RuntimeRoleStatus =
  /** The connected role obeys RLS — the expected state. */
  | { kind: 'isolated'; role: string }
  /** The connected role has BYPASSRLS: policies are inert. This is the alarm. */
  | { kind: 'bypassing'; role: string }
  /** The probe failed (no database, no permission, network). Says nothing either way. */
  | { kind: 'unknown'; reason: string };

/** What a probe must return: the connected role and whether it bypasses RLS. */
export type RuntimeRoleProbe = () => Promise<{
  role: string;
  bypasses: boolean;
} | null>;

/**
 * Classifies the connected role. Never throws: a failing probe is `unknown`, which
 * callers report as a warning rather than an alarm — we cannot claim a regression we
 * did not observe.
 */
export async function checkRuntimeRoleIsolation(
  probe: RuntimeRoleProbe,
): Promise<RuntimeRoleStatus> {
  let row: Awaited<ReturnType<RuntimeRoleProbe>>;
  try {
    row = await probe();
  } catch (err) {
    return {
      kind: 'unknown',
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  if (!row) return { kind: 'unknown', reason: 'probe returned no row' };

  return row.bypasses
    ? { kind: 'bypassing', role: row.role }
    : { kind: 'isolated', role: row.role };
}

/**
 * Asks the connected database who we are. Kept separate from the classifier above so
 * the decision logic stays testable without a database.
 */
export function makeRuntimeRoleProbe(db: {
  execute: (query: SQL) => Promise<{ rows: { role: string; bypasses: boolean }[] }>;
}): RuntimeRoleProbe {
  return async () => {
    const result = await db.execute(sql`
      select current_user::text as role,
             coalesce(
               (select rolbypassrls from pg_roles where rolname = current_user),
               false
             ) as bypasses
    `);
    return result.rows[0] ?? null;
  };
}

/**
 * Boot-time check, wired into `instrumentation.ts`. Reports and returns; never throws
 * and never blocks startup (plan D1 — fail-open).
 */
export async function reportRuntimeRoleIsolation(
  probe: RuntimeRoleProbe,
): Promise<RuntimeRoleStatus> {
  const status = await checkRuntimeRoleIsolation(probe);

  if (status.kind === 'bypassing') {
    logError(
      { action: 'runtimeRoleBypassesRls' },
      new Error(describeBypassingRole(status.role)),
    );
  } else if (status.kind === 'unknown') {
    // Not an alarm: we failed to observe, which is different from observing a problem.
    console.warn(
      JSON.stringify({
        level: 'warn',
        at: new Date().toISOString(),
        action: 'runtimeRoleCheckSkipped',
        message: status.reason,
      }),
    );
  }

  return status;
}

/** The operator-facing alarm text for a role that bypasses RLS. */
export function describeBypassingRole(role: string): string {
  return [
    `Database role "${role}" has BYPASSRLS: Row-Level Security is NOT being enforced.`,
    `The policies in lib/db/rls.ts are inert — every query sees every organization's rows,`,
    `and only Rule 1 (the explicit organization_id filter) is holding tenancy up.`,
    `Fix: point DATABASE_URL at the "${RUNTIME_DB_ROLE}" role and restart.`,
    `See docs/production-operations.md § Database roles.`,
  ].join(' ');
}
