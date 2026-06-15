/**
 * Shared result shape for Server Actions: a discriminated union so client
 * components can show inline errors without throwing across the RPC boundary.
 */
export type ActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: string };
