import type { ActionResult } from './action-result';

/**
 * Minimal, dependency-free error observability. Every unexpected failure gets a
 * single structured `console.error` line with a correlation `eventId`, so prod
 * logs (Vercel) are searchable and the user-facing message can reference the id.
 * Deliberately tiny — swapping in Sentry later means changing only `logError`.
 *
 * Privacy: we log the org id (needed to scope an incident) but never user PII.
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
