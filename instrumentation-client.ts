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
  // Drop ClerkJS's own transient session-keepalive failures. Clerk polls
  // `/v1/.../touch` in the background to refresh the session; on mobile WebKit a
  // long in-flight request (e.g. the 15–20s photo extraction) or a network blip
  // makes that background fetch fail with "Load failed", which surfaces as an
  // unhandled rejection inside `clerk.browser.js`. Clerk retries on its own and the
  // session is unaffected, so this is noise, not an actionable app error. Scoped to
  // ClerkJS's network-error message so genuine app failures are never masked.
  ignoreErrors: [
    /ClerkJS: Network error/,
    // The Flows SDK (@flows/react) opens a wss:// socket for live block updates
    // with a bare `new WebSocket(url)` — no try/catch. On iOS WebKit (all iOS
    // browsers, incl. Chrome) with Lockdown Mode or a content blocker, the
    // constructor itself throws SecurityError "The operation is insecure", which
    // bubbles to the global error handler. Nothing app-side is wrong and the app
    // works without the socket (Flows still loads blocks over HTTP), so this is
    // unactionable client-environment noise. ponytail: vendor bug — drop the
    // filter if @flows/react ever wraps its WebSocket constructor.
    'The operation is insecure.',
  ],
});

// Capture client-side navigation transitions when tracing is enabled.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
