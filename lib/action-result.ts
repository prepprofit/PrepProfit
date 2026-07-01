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
  // The recipe's ingredient lines changed between page load and a reorder drop
  // (a line was added/removed concurrently, or the payload didn't match) — reload
  // and retry. No write happened.
  | 'RECIPE_LINES_CHANGED'
  // The recipe's presets changed between page load and a reorder drop (a preset was
  // added/removed concurrently, or the payload didn't match) — reload and retry.
  // No write happened (Recipe-editor parity).
  | 'RECIPE_PRESETS_CHANGED'
  // The recipe reached its per-recipe preset cap (MAX_RECIPE_PRESETS) — remove one
  // before adding another (Recipe-editor parity).
  | 'RECIPE_PRESET_LIMIT_REACHED'
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
  // The AI vision provider was TRANSIENTLY overloaded/rate-limited and stayed busy
  // through our retries (Sprint 4.7) — distinct from AI_EXTRACTION_FAILED so the user
  // is told to retry in a moment, not to take a clearer photo. Nothing is staged.
  | 'AI_EXTRACTION_BUSY'
  // The org reached its monthly AI-extraction allowance for the plan (Sprint 4.7).
  // Also used for the Supplier Invoice Reader monthly cap (Sprint 2, AI margin roadmap).
  | 'USAGE_LIMIT_REACHED'
  // The AI provider failed or returned unusable output while reading a supplier
  // invoice (Sprint 2, AI margin roadmap). The document is discarded; nothing staged.
  | 'AI_INVOICE_FAILED'
  // The AI provider was TRANSIENTLY overloaded reading a supplier invoice and stayed
  // busy through retries (Sprint 2) — retry in a moment, not a document problem.
  | 'AI_INVOICE_BUSY'
  // The AI provider failed or returned unusable output while explaining a profit-leak
  // finding (Sprint 4, AI margin roadmap). The deterministic finding still surfaces.
  | 'AI_EXPLAIN_FAILED'
  // The AI provider was TRANSIENTLY overloaded explaining a finding and stayed busy
  // through retries (Sprint 4) — retry in a moment. The finding still surfaces.
  | 'AI_EXPLAIN_BUSY'
  // A supplier invoice import was applied while its currency differs from the org
  // currency (Sprint 2, D6) — MVP requires a match; no silent gross/net mixing.
  | 'INVOICE_CURRENCY_MISMATCH'
  // Tried to edit/apply/void a supplier invoice import that is not a `draft`
  // (Sprint 2) — applied/void imports are terminal history.
  | 'INVOICE_IMPORT_NOT_EDITABLE'
  // Tried to apply a supplier invoice import with no `ready` (matched + complete)
  // lines (Sprint 2) — resolve at least one line first.
  | 'INVOICE_IMPORT_EMPTY'
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
  // Tried to complete a production that is not `planned` (Sprint 11b) — only a planned
  // run can be completed (drafts must be planned first; terminal runs are immutable).
  | 'PRODUCTION_NOT_COMPLETABLE'
  // Tried to void a production that is not `completed` (Sprint 11b) — only a completed
  // run can be voided (a voided run is terminal; reproduce via a new production).
  | 'PRODUCTION_NOT_VOIDABLE'
  // Tried to trash a completed/voided production (Sprint 11b) — terminal runs are
  // permanent history and never enter Trash.
  | 'PRODUCTION_NOT_DELETABLE'
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
  // A task list was edited from a stale version (Sprint 6 optimistic concurrency) —
  // another edit committed first; reload and retry. No write/audit happened.
  | 'TASK_LIST_STALE'
  // A task was edited from a stale version (Sprint 6 optimistic concurrency).
  | 'TASK_STALE'
  // Tried to add/edit/reorder a task inside a TRASHED list (Sprint 6) — restore the
  // list first; a trashed list is read-only.
  | 'TASK_LIST_NOT_EDITABLE'
  // A task list reached its per-list task cap (Sprint 6) — split the list.
  | 'TASK_LIST_FULL'
  // Tried to assign a task to someone who is not an active member of the current org
  // (Sprint 6 D2) — pick a current org member.
  | 'TASK_ASSIGNEE_INVALID'
  // Short-close requires an explicit reason (Sprint 8b D4).
  | 'PO_CLOSE_REASON_REQUIRED'
  // Tried to cancel a PO that still has a posted receipt (Sprint 8b D5) — void the
  // receipts first; once all are voided the PO returns to `sent` and can be cancelled.
  | 'PO_NOT_CANCELLABLE'
  // A sale was edited from a stale version (Sprint 12a optimistic concurrency) —
  // another edit committed first; reload and retry. No write/audit happened.
  | 'SALE_STALE'
  // Tried to edit/delete a posted/void sale (Sprint 12a) — only a draft is mutable;
  // posted/void closes are permanent history.
  | 'SALE_NOT_EDITABLE'
  // A non-void daily close already exists for that date (Sprint 12a D3) — void the
  // old one (retained as history) then create a new draft.
  | 'SALE_DATE_TAKEN'
  // A sale line's recipe/menu/ingredient (or a menu's component) is missing/trashed
  // (Sprint 12a) — fix the line (remove/replace/restore the source) before posting.
  | 'SALE_INCOMPLETE'
  // Tried to post a sale with no configured org VAT rate (Sprint 12a D5) — set your
  // tax rate in Settings first. No silent 0%.
  | 'SALES_TAX_RATE_REQUIRED'
  // A recipe/menu/ingredient still referenced by a sale line (or a sale-sourced stock
  // movement) was manually purged (Sprint 12a) — the purge does nothing until the
  // sale is removed/voided.
  | 'RECIPE_IN_SALE'
  | 'MENU_IN_SALE'
  | 'INGREDIENT_IN_SALE'
  // A storage area was edited from a stale version (Sprint 12c optimistic concurrency) —
  // reload and retry. No write/audit happened.
  | 'INVENTORY_AREA_STALE'
  // A draft physical count was edited/committed from a stale version (Sprint 12c).
  | 'STOCK_COUNT_STALE'
  // Tried to delete/replace the immutable default storage area (Sprint 12c D2/D8) — the
  // default owns the legacy NULL bucket; it may be renamed but never removed/replaced.
  | 'DEFAULT_AREA_LOCKED'
  // Tried to delete a storage area that still holds stock (Sprint 12c D8) — transfer or
  // count it to zero first.
  | 'AREA_NOT_EMPTY'
  // Tried to delete a storage area referenced by a draft count (Sprint 12c D8) — commit
  // or discard the draft count first.
  | 'AREA_HAS_DRAFT_COUNT'
  | 'UNEXPECTED';

export type ActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; code: ActionErrorCode };
