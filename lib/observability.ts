import * as Sentry from '@sentry/nextjs';
import type { ActionResult } from './action-result';

/**
 * Error observability seam. Every unexpected failure gets a single structured
 * `console.error` line with a correlation `eventId` (searchable in Vercel logs and
 * surfaced to the user) AND is forwarded to Sentry (Sprint 5a) tagged with that
 * same id, so a log line and its Sentry issue cross-link. Sentry is FAIL-OPEN: with
 * no DSN configured it is a no-op, and a forwarding failure can never escalate the
 * original error — `logError` always returns the id and never throws.
 *
 * Privacy: we attach the org id (needed to scope an incident) but never user PII;
 * `sendDefaultPii: false` in the Sentry config enforces the same rule provider-side.
 */

export type ErrorContext = {
  /** The action or boundary that failed, e.g. 'createFolderAction'. */
  action: string;
  orgId?: string;
};

/** Structured one-line error log. Returns the generated event id. */
export function logError(context: ErrorContext, err: unknown): string {
  const eventId =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;

  console.error(
    JSON.stringify({
      level: 'error',
      eventId,
      at: new Date().toISOString(),
      action: context.action,
      orgId: context.orgId,
      message,
      stack,
    }),
  );

  // Forward to Sentry under the SAME correlation id. Guarded so an SDK hiccup (or
  // an unconfigured DSN edge case) can never turn an observed error into a thrown
  // one. No-op when Sentry has no DSN.
  try {
    Sentry.captureException(err, {
      tags: { action: context.action, eventId },
      extra: { orgId: context.orgId },
    });
  } catch {
    // Intentionally swallowed: observability must never break the request.
  }

  return eventId;
}

/**
 * Catch-arm helper for Server Actions: log the unexpected error and return a
 * generic `UNEXPECTED` result instead of letting the throw bubble to Next (which
 * would crash the request with no correlation id and leak internals).
 */
export function unexpected(
  action: string,
  err: unknown,
  orgId?: string,
): ActionResult<never> {
  logError({ action, orgId }, err);
  return { ok: false, code: 'UNEXPECTED' };
}
