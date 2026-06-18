/**
 * Shared result shape for Server Actions: a discriminated union so client
 * components can show inline errors without throwing across the RPC boundary.
 *
 * The failure arm carries a stable `code` (never a localized string) — the
 * client maps it to a translated message via `useActionError()`
 * (lib/i18n/use-action-error.ts), honouring CLAUDE.md's "UI strings always via
 * next-intl". Add a new code here AND a matching `actionErrors.<code>` message.
 */
export type ActionErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'DUPLICATE_NAME'
  | 'ALREADY_IN_RECIPE'
  | 'INGREDIENT_IN_USE'
  // A stock-out larger than the ingredient's on-hand stock (would go negative).
  | 'INSUFFICIENT_STOCK'
  | 'RECIPE_HAS_TRASHED_INGREDIENTS'
  | 'INGREDIENT_IN_TRASHED_RECIPE'
  | 'CATEGORY_IN_USE'
  // An issued/paid/void invoice was edited or trashed — only drafts are mutable.
  | 'INVOICE_LOCKED'
  // Tried to issue an invoice with no (active) linked customer to snapshot.
  | 'INVOICE_NO_CUSTOMER'
  // A status change that the lifecycle does not allow (e.g. pay a draft).
  | 'INVALID_STATUS_TRANSITION'
  | 'FORBIDDEN'
  // Too many requests in the rate-limit window (Sprint 3.1 limiter).
  | 'RATE_LIMITED'
  | 'UNEXPECTED';

export type ActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; code: ActionErrorCode };
