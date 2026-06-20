import * as Sentry from '@sentry/nextjs';

/**
 * Sentry edge-runtime init (Sprint 5a). Loaded by `instrumentation.ts` on the
 * Edge runtime (e.g. middleware). FAIL-OPEN: with no `SENTRY_DSN`, `init` is a
 * no-op. See `sentry.server.config.ts` for the rationale; kept separate because
 * the Edge runtime has its own module graph.
 */
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 0.1,
  sendDefaultPii: false,
});
