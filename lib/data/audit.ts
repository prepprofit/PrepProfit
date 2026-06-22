import { auditLog } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';
import { getUserId, getUserRole } from '@/lib/auth';

/**
 * Audit logging (Sprint 3.1). Every high-risk mutation appends one row to
 * `audit_log` INSIDE the same `withOrg` transaction as the mutation, so the event
 * commits atomically with the change and is RLS-scoped to the active org. The log
 * is append-only at the DB level (lib/db/rls.ts) — there is intentionally no
 * update/delete helper here.
 *
 * Privacy: `metadata` carries only non-sensitive descriptors (ids, counts,
 * status, filter shapes). Never store PII, raw notes, amounts tied to a person,
 * or document/image contents.
 */

/** Stable machine action keys. Group by `<entity>.<verb>` so reports can prefix-match. */
export type AuditAction =
  // Financial ledger
  | 'transaction.create'
  | 'transaction.update'
  | 'transaction.delete'
  // Invoice lifecycle
  | 'invoice.create'
  | 'invoice.issue'
  | 'invoice.pay'
  | 'invoice.void'
  | 'invoice.update'
  | 'invoice.delete'
  // Payroll
  | 'employee.create'
  | 'employee.update'
  | 'employee.archive'
  | 'employee.delete'
  | 'shift.open'
  | 'shift.close'
  | 'shift.update'
  | 'shift.delete'
  // Trash lifecycle (restore / permanent purge)
  | 'trash.restore'
  | 'trash.purge'
  // Ingredient approved-cost changes (Sprint F2). `ingredient.priceUpdate` = a
  // manager manually changed price_cents; `ingredient.priceAccept` = a manager
  // accepted a pending observed cost. metadata = old/new cents only (money tied to
  // an ingredient, not a person), never names or notes.
  | 'ingredient.priceUpdate'
  | 'ingredient.priceAccept'
  // Suppliers (Sprint 7). `supplier.create/.update/.archive/.restore` = supplier
  // entity lifecycle (manager-only). `ingredient.supplierSet` = a default supplier
  // link was set/updated on an ingredient; `ingredient.supplierClear` = the default
  // link was removed. metadata = ids + non-PII pack descriptors (size/unit/cents)
  // only — NEVER supplier contact details (email/phone/address/tax id).
  | 'supplier.create'
  | 'supplier.update'
  | 'supplier.archive'
  | 'supplier.restore'
  | 'ingredient.supplierSet'
  | 'ingredient.supplierClear'
  // Allergens (Sprint 9). `allergen.ingredientReview` = an ingredient's allergen
  // tags were replaced + the review stamped (kitchen OR manager — metadata carries
  // the before/after presence SETS as slugs, plus the reviewer is `actor_user_id`).
  // `allergen.overrideAdd` = a recipe add/escalate override; `allergen.overrideClear`
  // = a manual override cleared. metadata = allergen slug(s) + presence only, never
  // a free-text reason or any PII.
  | 'allergen.ingredientReview'
  | 'allergen.overrideAdd'
  | 'allergen.overrideClear'
  // Kitchen-visible allergen matrix document (Sprint 9) — money-free; metadata is
  // recipe count only, never costs.
  | 'export.allergenMatrixPdf'
  | 'export.allergenMatrixXlsx'
  // Purchase orders (Sprint 8a, manager-only). `.create/.update/.cancel/.delete` =
  // draft lifecycle; `.send` = draft→sent (supplier snapshot frozen + email enqueued).
  // metadata = ids/counts/status/number only — NEVER supplier contact details.
  | 'purchaseOrder.create'
  | 'purchaseOrder.update'
  | 'purchaseOrder.send'
  | 'purchaseOrder.cancel'
  | 'purchaseOrder.delete'
  | 'export.purchaseOrderPdf'
  // Org settings
  | 'settings.update'
  // Sensitive exports / generated documents
  | 'export.transactionsCsv'
  | 'export.invoicePdf'
  | 'export.recipeCardPdf'
  | 'export.plPdf'
  | 'export.plXlsx'
  | 'export.payrollPdf'
  | 'export.payrollXlsx'
  // A generated document emailed to a recipient (Sprint 3.5C) — written only
  // AFTER the provider accepts; metadata is documentType + provider message id
  // only (never the recipient address, amounts, or names).
  | 'document.email'
  // Billing webhooks (Sprint 4c, `system` actor — Clerk delivers them, no user).
  // `subscription.update` = the subscription mirror moved to a new plan/status;
  // `subscription.lapse` = a downgrade signal (past_due / org deleted);
  // `organization.update` / `organization.membership` = lifecycle visibility.
  // metadata holds only ids + resolved tier + status (never payer email/name).
  | 'subscription.update'
  | 'subscription.lapse'
  // `organization.create` = a new org was provisioned (defaults seeded via the
  // org-created webhook, system actor, Sprint 4d).
  | 'organization.create'
  | 'organization.update'
  | 'organization.membership'
  // Post-signup onboarding completed by the org manager (Sprint 4d).
  | 'onboarding.complete'
  // Deterministic import (Sprint 4.5). `import.preview` = a file was parsed and
  // staged (status `parsed`); `import.commit` = a staged job was applied. metadata
  // holds only entity + counts (importable/created/skipped), never cell contents.
  | 'import.preview'
  | 'import.commit'
  // AI photo recipe extraction (Sprint 4.7). `ai.extract` = an image was extracted
  // and staged as a recipe_photo job (status `parsed`); `ai.extractFailed` = the
  // provider/validation failed and a `failed` attempt was recorded. metadata holds
  // only provider/model/token counts/quality-flag + issue COUNTS — never the image
  // or recipe text.
  | 'ai.extract'
  | 'ai.extractFailed'
  // GDPR account lifecycle (Sprint 5e). `account.export` = a manager downloaded the
  // full org data bundle (metadata = row count only, never the data). `account.
  // deletionRequest` / `account.deletionCancel` = a manager asked to erase / undid
  // the request (metadata = whether a reason was given, never its text).
  | 'account.export'
  | 'account.deletionRequest'
  | 'account.deletionCancel'
  // Automated cron purge (system actor)
  | 'cron.purge';

/**
 * Who performed the action. `userId` is null for non-user actors (cron); `role`
 * adds `'system'` to the app's user roles for exactly that case.
 */
export type AuditActor = {
  userId: string | null;
  role: 'manager' | 'kitchen' | 'system';
  /** Correlates every event from one action invocation / request. */
  requestId: string;
};

export type AuditEventInput = {
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
};

/**
 * Resolve the acting Clerk user + role for an authenticated Server Action, plus a
 * fresh request id. Call once at the top of an action, then pass the result into
 * the `withOrg` callback. (Cron builds a literal `system` actor instead.)
 */
export async function auditActor(): Promise<AuditActor> {
  const [userId, role] = await Promise.all([getUserId(), getUserRole()]);
  return { userId, role, requestId: crypto.randomUUID() };
}

/** Append one audit event. MUST run inside the mutation's `withOrg` transaction. */
export async function writeAuditEvent(
  db: TenantClient,
  organizationId: string,
  actor: AuditActor,
  event: AuditEventInput,
): Promise<void> {
  await db.insert(auditLog).values({
    organizationId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId ?? null,
    metadata: event.metadata ?? null,
    requestId: actor.requestId,
  });
}
