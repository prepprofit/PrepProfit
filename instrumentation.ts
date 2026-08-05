import * as Sentry from '@sentry/nextjs';

/**
 * Next.js instrumentation hook (Sprint 5a). Runs once per server runtime at boot
 * and wires Sentry in. The per-runtime config modules each FAIL-OPEN (no DSN → no-op),
 * so this stays safe to ship everywhere.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
    await checkRuntimeRole();
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

/**
 * Boot-time RLS guard: confirm the app is connected as a role WITHOUT `BYPASSRLS`,
 * i.e. that the policies in `lib/db/rls.ts` actually filter. That property lives in
 * `DATABASE_URL`, not in this repository, so no test can prove it — see
 * `docs/rls-regression-guard-plan.md`.
 *
 * FAIL-OPEN, deliberately: everything here is wrapped, the imports are dynamic (so a
 * build without a database never loads the driver), and a failure is at most a log
 * line. Boot must not depend on this check succeeding.
 */
async function checkRuntimeRole() {
  if (!process.env.DATABASE_URL) return;

  try {
    const [{ getDb }, { makeRuntimeRoleProbe, reportRuntimeRoleIsolation }] =
      await Promise.all([import('./lib/db'), import('./lib/db/runtime-role')]);

    await reportRuntimeRoleIsolation(makeRuntimeRoleProbe(getDb()));
  } catch {
    // Intentionally swallowed: a diagnostic must never keep the server from starting.
  }
}

/**
 * Captures errors thrown inside React Server Components / nested server rendering,
 * which otherwise never reach a `try/catch`. No-op when Sentry is unconfigured.
 */
export const onRequestError = Sentry.captureRequestError;
