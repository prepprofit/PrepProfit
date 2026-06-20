import * as Sentry from '@sentry/nextjs';

/**
 * Next.js instrumentation hook (Sprint 5a). Runs once per server runtime at boot
 * and wires Sentry in. The per-runtime config modules each FAIL-OPEN (no DSN → no-op),
 * so this stays safe to ship everywhere.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

/**
 * Captures errors thrown inside React Server Components / nested server rendering,
 * which otherwise never reach a `try/catch`. No-op when Sentry is unconfigured.
 */
export const onRequestError = Sentry.captureRequestError;
