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
  // Menus / combos (Sprint 10, manager-only). `.create/.update/.delete` = menu
  // lifecycle (restore/purge use the generic `trash.*`). metadata = ids, item count
  // and a `priceChanged` boolean + changed field names only — NEVER the menu price
  // value or notes.
  | 'menu.create'
  | 'menu.update'
  | 'menu.delete'
  // Production plans (Sprint 11a, kitchen OR manager). `.create/.update/.plan/.reopen/
  // .delete` = the pre-post lifecycle (restore/purge use the generic `trash.*`).
  // metadata = ids, item count, total planned portions, status transition and changed
  // field names only — NEVER cost, price or any ingredient financial field.
  | 'production.create'
  | 'production.update'
  | 'production.plan'
  | 'production.reopen'
  | 'production.delete'
  // Production completion (Sprint 11b, kitchen OR manager completes; manager-only
  // void). `.complete` metadata = item count, total planned portions, distinct
  // ingredient count, stockMoved, movement count; `.void` metadata = reversal count.
  // NEVER any cost value.
  | 'production.complete'
  | 'production.void'
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
  // Receiving (Sprint 8b, manager-only). `.receive` = a posted goods receipt;
  // `.receiptVoid` = a correction (reversal); `.close` = short-close. metadata =
  // ids/counts/status only — NEVER supplier contact details or per-person money.
  | 'purchaseOrder.receive'
  | 'purchaseOrder.receiptVoid'
  | 'purchaseOrder.close'
  | 'export.purchaseOrderPdf'
  // Kitchen task lists + tasks (Sprint 6, kitchen OR manager — see RBAC asymmetry).
  // `taskList.create/.update/.delete/.reset/.duplicate/.reorder` = list lifecycle
  // (restore/purge use the generic `trash.*`); `task.create/.update/.delete` = task
  // CRUD; `task.complete/.reopen` = status toggle (no-op toggles don't audit);
  // `task.assign` = assignee set/cleared. metadata = ids/counts/status/sourceKind and
  // whether-assigned only — NEVER task titles, notes, station, or assignee names.
  | 'taskList.create'
  | 'taskList.update'
  | 'taskList.delete'
  | 'taskList.reset'
  | 'taskList.duplicate'
  | 'taskList.reorder'
  | 'task.create'
  | 'task.update'
  | 'task.delete'
  | 'task.complete'
  | 'task.reopen'
  // Prep/Reorder Planner bulk task creation (Sprint 7, manager-only). One event per
  // create call; metadata = list id + created/prep/reorder/skipped COUNTS only, never
  // recipe/ingredient names.
  | 'taskList.prepPlanTasks'
  | 'task.assign'
  // Daily-close sales (Sprint 12a, manager-only). `.create/.update/.delete` = draft
  // lifecycle; `.post` = draft→posted (single protected income row + idempotent stock
  // consumption); `.void` = posted→void (income soft-delete + stock reversal).
  // metadata = ids / line count / ingredient count / stockMoved / movement count /
  // reversal count / transaction id only — NEVER the gross/net/tax amounts or any
  // item name.
  | 'sale.create'
  | 'sale.update'
  | 'sale.delete'
  | 'sale.post'
  | 'sale.void'
  // Inventory depth — storage areas + transfers + counts (Sprint 12c). Area CRUD is
  // manager-only; transfers + count commits are kitchen OR manager. metadata = ids /
  // areaFrom / areaTo / line + movement counts only — NEVER quantities, NEVER value.
  | 'inventory.areaCreate'
  | 'inventory.areaRename'
  | 'inventory.areaDelete'
  | 'inventory.transfer'
  | 'inventory.countCommit'
  // Manual inventory adjustments (Sprint 3 / audit F-06, kitchen OR manager).
  // `inventory.movement` = a manual stock movement was posted (deduped replays are
  // NOT audited); `inventory.thresholdSet` = a low-stock threshold was set/cleared.
  // metadata = ingredient id + a direction/cleared descriptor only — NEVER the delta
  // quantity, the threshold value, or any note text.
  | 'inventory.movement'
  | 'inventory.thresholdSet'
  // Kitchen presets (Recipe-editor parity, kitchen OR manager — operational config
  // that drives printed prep output, so it is audited unlike ingredient reorder).
  // `.create/.update/.delete/.reorder` = preset lifecycle. metadata = preset id +
  // changed-field names + count only — NEVER the preset name or weight value.
  | 'recipePreset.create'
  | 'recipePreset.update'
  | 'recipePreset.delete'
  | 'recipePreset.reorder'
  // Org settings
  | 'settings.update'
  // Purchase VAT bands (per-org lookup). metadata = the band's name + rate in bps,
  // which is org configuration, never PII.
  | 'settings.vatCategoryCreate'
  | 'settings.vatCategoryUpdate'
  | 'settings.vatCategoryDelete'
  // Sensitive exports / generated documents
  | 'export.transactionsCsv'
  | 'export.invoicePdf'
  | 'export.recipeCardPdf'
  // Operational scaled prep card (Recipe scaling MVP) — money-free, BOTH roles;
  // metadata is the recipe id only (no costs, no scale value beyond the id).
  | 'export.recipePrepCardPdf'
  // Nutrition label PDF (Fase 6) — money-free, both roles; metadata = recipe id
  // + draft flag only, never nutrient values.
  | 'export.nutritionLabelPdf'
  | 'export.plPdf'
  | 'export.plXlsx'
  | 'export.payrollPdf'
  | 'export.payrollXlsx'
  // A generated document emailed to a recipient (Sprint 3.5C) — written only
  // AFTER the provider accepts; metadata is documentType + provider message id
  // only (never the recipient address, amounts, or names).
  | 'document.email'
  // Weekly CFO report emailed by the outbox worker (React Email migration) — written
  // only AFTER the provider accepts; system actor. metadata is weekTo + provider
  // message id + non-sensitive section COUNTS only (never the recipient, item names,
  // amounts, or any AI prose — the automated email is deterministic, no AI).
  | 'report.cfoEmail'
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
  // AI photo recipe extraction (Sprint 4.7; improvement plan §4). `ai.extract` = an
  // image was extracted into an editable draft (attempt `succeeded`, no job yet);
  // `ai.stage` = the user's edited draft was staged into a recipe_photo job (status
  // `parsed`) and linked to the attempt; `ai.extractFailed` = the provider/validation
  // failed and a `failed` attempt was recorded. metadata holds only provider/model/
  // token counts/quality-flag/line + issue COUNTS — never the image or recipe text.
  | 'ai.extract'
  | 'ai.stage'
  | 'ai.extractFailed'
  // Supplier Invoice Reader (Sprint 2, AI margin roadmap, manager-only). `ai.invoiceExtract`
  // = an invoice was extracted into a draft import (attempt `succeeded`);
  // `ai.invoiceExtractFailed` = the provider/validation failed (a `failed` attempt was
  // recorded); `invoiceImport.apply` = approved lines were recorded as pending price
  // observations; `invoiceImport.void` = a draft import was discarded. metadata holds
  // only provider/model/token/line/observation COUNTS + ids — NEVER the document, raw
  // line text, prices tied to a person, or supplier contact details.
  | 'ai.invoiceExtract'
  | 'ai.invoiceExtractFailed'
  | 'invoiceImport.apply'
  | 'invoiceImport.void'
  // Profit Insight Inbox (Sprint 4, AI margin roadmap, manager-only). `ai.profitLeakExplain`
  // = a finding was explained by AI (attempt `succeeded`); `ai.profitLeakExplainFailed` =
  // the provider/validation failed (a `failed` attempt was recorded); `profitInsight.dismiss`
  // / `profitInsight.restore` = a manager hid/unhid a finding. metadata holds only
  // provider/model/token COUNTS, the finding type + risk level, and ids — NEVER entity
  // names or the explanation prose.
  | 'ai.profitLeakExplain'
  | 'ai.profitLeakExplainFailed'
  | 'profitInsight.dismiss'
  | 'profitInsight.restore'
  // Daily Close Summary (Sprint 6, AI margin roadmap, manager-only). `ai.dailyCloseSummary`
  // = a posted close was summarized by AI (attempt `succeeded`); `ai.dailyCloseSummaryFailed`
  // = the provider/validation failed (a `failed` attempt was recorded). metadata holds only
  // provider/model/token COUNTS, the risk level, and the sale id — NEVER amounts, item
  // names, or the summary prose.
  | 'ai.dailyCloseSummary'
  | 'ai.dailyCloseSummaryFailed'
  // Prep/Reorder Plan Summary (Sprint 7, AI margin roadmap). `ai.prepPlanSummary` = a plan
  // was summarized by AI (attempt `succeeded`); `ai.prepPlanSummaryFailed` = the provider/
  // validation failed (a `failed` attempt was recorded). metadata holds only provider/model/
  // token COUNTS, the supply-risk level, and the attempt id — NEVER quantities, item names,
  // or the summary prose. The plan carries no money.
  | 'ai.prepPlanSummary'
  | 'ai.prepPlanSummaryFailed'
  // Weekly CFO Report (Sprint 8, AI margin roadmap, manager-only). `ai.cfoReport` = the
  // weekly report was written up by AI (attempt `succeeded`); `ai.cfoReportFailed` = the
  // provider/validation failed (a `failed` attempt was recorded). metadata holds only
  // provider/model/token COUNTS, the risk level, the week-ending date, and the attempt id —
  // NEVER amounts, item names, or the report prose.
  | 'ai.cfoReport'
  | 'ai.cfoReportFailed'
  // GDPR account lifecycle (Sprint 5e). `account.export` = a manager downloaded the
  // full org data bundle (metadata = row count only, never the data). `account.
  // deletionRequest` / `account.deletionCancel` = a manager asked to erase / undid
  // the request (metadata = whether a reason was given, never its text).
  | 'account.export'
  | 'account.deletionRequest'
  | 'account.deletionCancel'
  // Recipes 2.0 workspace (Meez-parity plan). `recipe.workspaceSave` = one
  // atomic workspace save (header/sections/lines/method). metadata = old/new
  // version and changed area names only — NEVER cost, price or free-text
  // content.
  | 'recipe.workspaceSave'
  // Portion options (Fase 5, §6.8, manager-only — FINANCIAL). metadata = ids +
  // boolean flags (isDefault/hasPrice/hasTarget) only — NEVER the price or
  // target values.
  | 'recipe.portionOptionCreate'
  | 'recipe.portionOptionUpdate'
  | 'recipe.portionOptionDelete'
  | 'recipe.portionOptionSetDefault'
  | 'recipe.portionOptionSetNutritionServing'
  // Ingredient nutrition profiles (Fase 6, §6.7, manager-only). `nutritionSave`
  // = manual save (USDA selection or custom); `nutritionRefresh` = explicit
  // "Refresh from source". metadata = ingredientId, source, fdcId only — NEVER
  // nutrient values.
  | 'ingredient.nutritionSave'
  | 'ingredient.nutritionRefresh'
  // Recipe media lifecycle (Fase 3, plan §6.4). `recipe.mediaUpload` = an
  // uploaded object was validated and confirmed `ready`; `recipe.mediaReject` =
  // confirm validation failed; `recipe.mediaDelete` = soft delete requested.
  // metadata = ids, kind, mime, byte size and reject reason only — NEVER media
  // content, filenames or URLs.
  | 'recipe.mediaUpload'
  | 'recipe.mediaReject'
  | 'recipe.mediaDelete'
  // Library bulk trash (Fase 7, kitchen OR manager — same reach as the single
  // trash action, audited because one call can trash up to 200 recipes).
  // metadata = trashed/blocked/skipped COUNTS + trashed ids only — never names.
  | 'recipe.bulkTrash'
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
