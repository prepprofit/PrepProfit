import * as Sentry from '@sentry/nextjs';

/**
 * Sentry server-runtime init (Sprint 5a). Loaded by `instrumentation.ts` only on
 * the Node.js runtime. FAIL-OPEN by design: with no `SENTRY_DSN` set, `init` is a
 * no-op — no network, no crash — so `next build`/CI and any unconfigured
 * environment behave exactly as before (same discipline as `emailEnv`/`aiEnv`).
 *
 * Privacy: `sendDefaultPii: false` — we never ship user PII to Sentry. This mirrors
 * the `logError` rule (org id is fine for incident scoping, user PII is not). The
 * DSN is read straight from env and is never logged.
 */
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  // Low trace sampling: this is primarily error tracking, not full APM.
  tracesSampleRate: 0.1,
  sendDefaultPii: false,
});
