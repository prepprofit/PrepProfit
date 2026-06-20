import * as Sentry from '@sentry/nextjs';

/**
 * Sentry browser init (Sprint 5a). Next 15 loads this on the client automatically.
 * FAIL-OPEN: with no `NEXT_PUBLIC_SENTRY_DSN`, `init` is a no-op — the bundle ships
 * but does nothing, so an unconfigured environment is unaffected. The public DSN is
 * not a secret, but it is still only read from env, never hardcoded.
 *
 * Privacy: `sendDefaultPii: false`, matching the server config.
 */
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1,
  sendDefaultPii: false,
});

// Capture client-side navigation transitions when tracing is enabled.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
