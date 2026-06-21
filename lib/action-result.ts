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
  // The same idempotency key was reused for a DIFFERENT movement payload (F1) —
  // a real conflict, never silently deduped.
  | 'IDEMPOTENCY_CONFLICT'
  | 'RECIPE_HAS_TRASHED_INGREDIENTS'
  | 'INGREDIENT_IN_TRASHED_RECIPE'
  | 'CATEGORY_IN_USE'
  // An issued/paid/void invoice was edited or trashed — only drafts are mutable.
  | 'INVOICE_LOCKED'
  // Tried to issue an invoice with no (active) linked customer to snapshot.
  | 'INVOICE_NO_CUSTOMER'
  // A status change that the lifecycle does not allow (e.g. pay a draft).
  | 'INVALID_STATUS_TRANSITION'
  // A sale-sourced transaction was edited/trashed/restored/purged directly — it is
  // owned by the sale lifecycle and can only change by voiding the sale (Sprint F5).
  | 'PROTECTED_TRANSACTION'
  | 'FORBIDDEN'
  // Too many requests in the rate-limit window (Sprint 3.1 limiter).
  | 'RATE_LIMITED'
  // The email provider rejected the send, or email is not configured (Sprint 3.5C).
  | 'EMAIL_FAILED'
  // The org's plan does not include this paid feature (Sprint 4 entitlements).
  | 'UPGRADE_REQUIRED'
  // A plan numeric limit (e.g. Starter's 50-recipe cap) was reached (Sprint 4).
  | 'PLAN_LIMIT_REACHED'
  // A staged import job was confirmed after its 24h TTL (Sprint 4.5) — re-upload.
  | 'IMPORT_EXPIRED'
  // The AI vision provider failed or returned unusable output (Sprint 4.7). The
  // image is discarded; nothing is staged.
  | 'AI_EXTRACTION_FAILED'
  // The org reached its monthly AI-extraction allowance for the plan (Sprint 4.7).
  | 'USAGE_LIMIT_REACHED'
  | 'UNEXPECTED';

export type ActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; code: ActionErrorCode };
