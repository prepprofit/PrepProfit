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
  // A recipe allergen override tried to lower/remove a presence — overrides may only
  // ADD or ESCALATE (Sprint 9). The derived allergens are never suppressible.
  | 'ALLERGEN_CANNOT_DOWNGRADE'
  // A menu line referenced a recipe that is missing/trashed/cross-org at save time
  // (Sprint 10) — fix the line (remove/replace/restore the recipe) before saving.
  | 'MENU_RECIPE_INVALID'
  // A recipe still referenced by a menu was manually purged (Sprint 10) — remove the
  // menu line (or purge the menu) first; the purge does nothing until then.
  | 'RECIPE_IN_MENU'
  // A production line referenced a recipe that is missing/trashed/cross-org at save
  // time (Sprint 11a) — fix the line (remove/replace/restore the recipe) before saving.
  | 'PRODUCTION_RECIPE_INVALID'
  // Tried to edit a production that is not a draft (Sprint 11a) — a planned plan is
  // read-only; explicitly reopen it to draft first.
  | 'PRODUCTION_NOT_EDITABLE'
  // Tried to plan a draft that is not ready (Sprint 11a) — it needs a planned date and
  // a complete explosion (all recipes active, finite in-domain math).
  | 'PRODUCTION_INCOMPLETE'
  // A production was edited from a stale version (Sprint 11a optimistic concurrency) —
  // another edit committed first; reload and retry. No write/audit happened.
  | 'PRODUCTION_STALE'
  // A recipe still referenced by a production was manually purged (Sprint 11a, D4) —
  // remove the production line (or purge the production) first.
  | 'RECIPE_IN_PRODUCTION'
  // A supplier still in use (the default for ≥1 ingredient) was archived (Sprint 7) —
  // replace/remove the default link first.
  | 'SUPPLIER_IN_USE'
  // Tried to attach an ARCHIVED supplier to an ingredient (Sprint 7) — reactivate it
  // first (find-or-create never silently revives an archived supplier).
  | 'SUPPLIER_INACTIVE'
  // A pack unit's dimension does not match the ingredient's (Sprint 7), e.g. kg on a
  // volume ingredient; also covers blocking a dimension change while packs exist.
  | 'PACK_UNIT_MISMATCH'
  // A purchase order that is not a draft was edited / deleted / re-sent (Sprint 8a) —
  // a sent/cancelled PO is immutable (cancel-only). Re-sending also returns this.
  | 'PO_NOT_DRAFT'
  // Tried to send a PO with no (active) linked supplier to snapshot (Sprint 8a).
  | 'SUPPLIER_REQUIRED'
  // Tried to send a PO with no line items (Sprint 8a).
  | 'PO_EMPTY'
  // A manual PO number edit collided with an existing number for the org (Sprint 8a).
  | 'PO_NUMBER_TAKEN'
  // A PO line points at a missing/trashed ingredient at send time (Sprint 8a) — the
  // link was nulled or the ingredient was trashed; fix the line before sending.
  | 'PO_LINE_INGREDIENT_MISSING'
  // Tried to receive against a PO that is not sent/partially_received (Sprint 8b) —
  // a draft/cancelled/received PO cannot take a new delivery (received is terminal).
  | 'PO_NOT_RECEIVABLE'
  // Tried to short-close a PO that is not partially_received (Sprint 8b).
  | 'PO_NOT_CLOSABLE'
  // Short-close requires an explicit reason (Sprint 8b D4).
  | 'PO_CLOSE_REASON_REQUIRED'
  // Tried to cancel a PO that still has a posted receipt (Sprint 8b D5) — void the
  // receipts first; once all are voided the PO returns to `sent` and can be cancelled.
  | 'PO_NOT_CANCELLABLE'
  | 'UNEXPECTED';

export type ActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; code: ActionErrorCode };
