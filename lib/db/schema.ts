import { sql, type InferSelectModel, type InferInsertModel } from 'drizzle-orm';
import {
  pgTable,
  text,
  integer,
  numeric,
  boolean,
  timestamp,
  date,
  index,
  uniqueIndex,
  unique,
  foreignKey,
  check,
  jsonb,
} from 'drizzle-orm/pg-core';
import type {
  ImportEntity,
  ImportFormat,
  ImportStatus,
  ImportNormalizedRows,
  ImportRowIssue,
} from '@/lib/import/types';
import type { AiExtractionStatus, AiQualityFlag } from '@/lib/ai/types';

/**
 * RULE #1 (CLAUDE.md): every business-data table has an `organization_id`
 * (text, from Clerk) and a composite index starting with it. Monetary values
 * are ALWAYS stored as integer cents — never float. Physical quantities (grams)
 * are not money and may use numeric.
 */

const orgId = () => text('organization_id').notNull();
const id = () =>
  text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());
const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    // ORM-level: stamps `now()` on every Drizzle .update() (the DB default only
    // covers inserts).
    .$onUpdate(() => new Date());
// Soft-delete marker: NULL = active, a timestamp = in the trash since then. The
// 30-day auto-purge and the "days left" UI both read it (see lib/trash.ts). Every
// future deletable table should adopt this column + filter reads by `IS NULL`.
const deletedAt = () =>
  timestamp('deleted_at', { withTimezone: true });

/**
 * Per-organization settings: exactly one row per org (the Clerk org id is the
 * primary key). RULE #1 still holds — the row carries `organization_id`, so the
 * shared RLS policy isolates it like every other business table. Single currency
 * per org (no conversion; money stays integer cents); `measurement_system`
 * drives unit display only — quantities are always stored canonically (g/ml).
 */
export const organizationSettings = pgTable('organization_settings', {
  organizationId: text('organization_id').primaryKey(),
  // ISO-4217 currency code (validated against a curated list, see
  // lib/validation/org-settings.ts).
  currency: text('currency').notNull().default('EUR'),
  measurementSystem: text('measurement_system', {
    enum: ['metric', 'imperial'],
  })
    .notNull()
    .default('metric'),
  // Seller identity for generated documents (invoice PDF/print, Sprint 3.5A).
  // All optional: existing rows stay valid and documents fall back to the Clerk
  // org name when `businessName` is blank. `businessLogoUrl` is validated to be
  // an https URL only (lib/validation/org-settings.ts) so it is safe to embed in
  // the document header. None of these are PII of an individual.
  businessName: text('business_name'),
  businessAddress: text('business_address'),
  businessTaxId: text('business_tax_id'),
  businessEmail: text('business_email'),
  businessLogoUrl: text('business_logo_url'),
  // Sales fiscal config (Sprint F5). `default_tax_rate_bps` is the org's single
  // VAT rate in integer BASIS POINTS (2300 = 23%), 0..10000; NULL = NOT configured
  // (Sprint 12a must require a rate before posting sales — no silent 0%). Sale
  // lines default from it and may override per item (see lib/calculations/tax.ts).
  // It is validated/capped in Zod + the tax module, not by a DB constraint.
  defaultTaxRateBps: integer('default_tax_rate_bps'),
  // Financial-only mode (Sprint F5). Events (sales/productions) dated BEFORE this
  // bare calendar date book revenue/cost but do NOT move stock — so importing
  // history can't wreck on-hand quantities. NULL = stock control always active.
  // Evaluated AT POSTING TIME ONLY (lib/finance/stock-control.ts): changing it
  // later does NOT recalc or reverse movements already posted.
  stockControlStartDate: date('stock_control_start_date', { mode: 'string' }),
  // Set-once timestamp marking when the org's manager completed the post-signup
  // onboarding flow (Sprint 4d). NULL = not onboarded yet → the /dashboard gate
  // sends a manager to /onboarding. Never reset (markOnboarded only sets it when
  // currently NULL). Purely a UX nudge — it gates no data.
  onboardedAt: timestamp('onboarded_at', { withTimezone: true }),
  // GDPR account-deletion request (Sprint 5e). A manager can REQUEST erasure of the
  // org's data; org self-delete is disabled in Clerk (Sprint 4e), so an operator
  // fulfils it out-of-band. NULL = no pending request. These record the request,
  // they do NOT delete anything: `deletionRequestedBy` is the Clerk user id who
  // asked, `deletionReason` is an optional free-text note. Cleared on cancel.
  deletionRequestedAt: timestamp('deletion_requested_at', { withTimezone: true }),
  deletionRequestedBy: text('deletion_requested_by'),
  deletionReason: text('deletion_reason'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const ingredients = pgTable(
  'ingredients',
  {
    id: id(),
    organizationId: orgId(),
    name: text('name').notNull(),
    // Physical dimension of the ingredient. Determines the canonical unit of both
    // its recipe quantities (g / ml / count) and its price reference (priceCents).
    dimension: text('dimension', { enum: ['weight', 'volume', 'count'] })
      .notNull()
      .default('weight'),
    // Price per canonical purchase unit, in integer cents:
    //   weight → per kg, volume → per litre, count → per piece.
    priceCents: integer('price_cents').notNull().default(0),
    // TRUE when the ingredient was created without a real price (import / future
    // AI extraction default to priceCents 0 and set this), so the UI can flag it
    // for pricing and a "0" cost is honestly "unpriced", not "free" (Sprint 4.6).
    needsPricing: boolean('needs_pricing').notNull().default(false),
    // A newer approved cost OBSERVED (quote/receipt, Sprint F2) but not yet
    // accepted by a manager. NULL = nothing pending. Receiving/quotes raise this;
    // only the manager-only "accept cost" action moves it into price_cents. So the
    // approved cost (price_cents) never changes silently.
    pendingPriceCents: integer('pending_price_cents'),
    supplier: text('supplier'),
    // Current stock on hand, in the ingredient's canonical unit (g / ml / count).
    // Maintained transactionally alongside the inventory_movements ledger.
    stockQuantity: numeric('stock_quantity', { precision: 12, scale: 2 })
      .notNull()
      .default(sql`0`),
    // Optional low-stock threshold (canonical); a low-stock alert fires at/below it.
    lowStockThreshold: numeric('low_stock_threshold', { precision: 12, scale: 2 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    // Soft-delete: NULL = active. Reads filter `deleted_at IS NULL`.
    deletedAt: deletedAt(),
  },
  (t) => [
    index('ingredients_org_idx').on(t.organizationId),
    index('ingredients_org_name_idx').on(t.organizationId, t.name),
    // Serves the /trash listing and keeps active-row filtering index-friendly.
    index('ingredients_org_deleted_idx').on(t.organizationId, t.deletedAt),
    // FK target for the composite (organization_id, ingredient_id) reference.
    unique('ingredients_org_id_key').on(t.organizationId, t.id),
    // pg_trgm GIN indexes for typo-tolerant global search (Sprint 2.7). The
    // search query is org-scoped + RLS-filtered first; these accelerate the
    // similarity()/ILIKE matching on the searchable text columns.
    index('ingredients_name_trgm_idx').using('gin', t.name.op('gin_trgm_ops')),
    index('ingredients_supplier_trgm_idx').using(
      'gin',
      t.supplier.op('gin_trgm_ops'),
    ),
  ],
);

/**
 * Folders for filing recipes — a flat, per-organization namespace (no nesting).
 * A recipe belongs to at most one folder (`recipes.folder_id`, nullable = "No
 * folder"). Folders are HARD-deleted (never trashed): deleting one reassigns its
 * recipes to NULL in the same transaction (see lib/data/recipe-folders.ts), so
 * this table needs no `deleted_at`. The reusable template for later modules
 * (ingredient_folders, transaction_folders, …) is this exact shape + a nullable
 * `folder_id` on the owning table.
 */
export const recipeFolders = pgTable(
  'recipe_folders',
  {
    id: id(),
    organizationId: orgId(),
    name: text('name').notNull(),
    // Optional chef/kitchen emoji shown in the rail; NULL = default Folder glyph.
    // Constrained to the curated FOLDER_ICONS set server-side (validation layer).
    icon: text('icon'),
    // Manual ordering in the folder rail (move up / down). Lower sorts first.
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('recipe_folders_org_idx').on(t.organizationId),
    index('recipe_folders_org_sort_idx').on(t.organizationId, t.sortOrder),
    // One folder name per organization (rename/create surface the violation).
    unique('recipe_folders_org_name_key').on(t.organizationId, t.name),
    // FK target for the composite (organization_id, folder_id) reference.
    unique('recipe_folders_org_id_key').on(t.organizationId, t.id),
  ],
);

export const recipes = pgTable(
  'recipes',
  {
    id: id(),
    organizationId: orgId(),
    name: text('name').notNull(),
    // Folder this recipe is filed under; NULL = "No folder" (uncategorized).
    folderId: text('folder_id'),
    yieldPortions: integer('yield_portions').notNull().default(1),
    // Usable yield after trim/loss, as a percentage (100 = no loss).
    yieldPercentage: integer('yield_percentage').notNull().default(100),
    // Hidden per-recipe costs beyond ingredients, in integer cents (CLAUDE.md).
    laborCostCents: integer('labor_cost_cents').notNull().default(0),
    energyCostCents: integer('energy_cost_cents').notNull().default(0),
    packagingCostCents: integer('packaging_cost_cents').notNull().default(0),
    // Optional selling price per portion, in cents — drives margin + traffic light.
    sellingPriceCents: integer('selling_price_cents'),
    notes: text('notes'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    // Soft-delete: NULL = active. Reads filter `deleted_at IS NULL`.
    deletedAt: deletedAt(),
  },
  (t) => [
    index('recipes_org_idx').on(t.organizationId),
    index('recipes_org_name_idx').on(t.organizationId, t.name),
    // Serves the /trash listing and keeps active-row filtering index-friendly.
    index('recipes_org_deleted_idx').on(t.organizationId, t.deletedAt),
    // Serves per-folder listing (and the uncategorized = NULL view).
    index('recipes_org_folder_idx').on(t.organizationId, t.folderId),
    // FK target for the composite (organization_id, recipe_id) reference.
    unique('recipes_org_id_key').on(t.organizationId, t.id),
    // pg_trgm GIN indexes for typo-tolerant global search (Sprint 2.7).
    index('recipes_name_trgm_idx').using('gin', t.name.op('gin_trgm_ops')),
    index('recipes_notes_trgm_idx').using('gin', t.notes.op('gin_trgm_ops')),
    // Composite FK forces the folder to share THIS recipe's organization_id —
    // a recipe can never be filed under another tenant's folder. ON DELETE
    // restrict: the app nulls folder_id before deleting a folder (a multi-column
    // SET NULL would also null the NOT NULL organization_id), so a delete never
    // orphans a row. folder_id is nullable → NULL rows skip the FK (MATCH SIMPLE).
    foreignKey({
      columns: [t.organizationId, t.folderId],
      foreignColumns: [recipeFolders.organizationId, recipeFolders.id],
      name: 'recipes_folder_fk',
    }).onDelete('restrict'),
  ],
);

export const recipeIngredients = pgTable(
  'recipe_ingredients',
  {
    id: id(),
    organizationId: orgId(),
    recipeId: text('recipe_id').notNull(),
    ingredientId: text('ingredient_id').notNull(),
    // Canonical amount in the linked ingredient's dimension: grams (weight),
    // millilitres (volume), or a plain count.
    quantity: numeric('quantity', { precision: 10, scale: 2 })
      .notNull()
      .default(sql`0`),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [
    index('recipe_ingredients_org_idx').on(t.organizationId),
    index('recipe_ingredients_recipe_idx').on(t.recipeId),
    // One row per ingredient per recipe.
    unique('recipe_ingredients_recipe_ingredient_key').on(
      t.recipeId,
      t.ingredientId,
    ),
    // Composite FKs force the referenced recipe/ingredient to share THIS row's
    // organization_id — cross-tenant links are impossible at the DB level, not
    // just discouraged by the app layer. Delete semantics preserved: removing a
    // recipe cascades to its lines; an ingredient in use cannot be deleted.
    foreignKey({
      columns: [t.organizationId, t.recipeId],
      foreignColumns: [recipes.organizationId, recipes.id],
      name: 'recipe_ingredients_recipe_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.organizationId, t.ingredientId],
      foreignColumns: [ingredients.organizationId, ingredients.id],
      name: 'recipe_ingredients_ingredient_fk',
    }).onDelete('restrict'),
  ],
);

/**
 * Append-only inventory ledger (Sprint F1). Each row is a signed canonical change
 * to an ingredient's stock (positive = in, negative = out).
 * `ingredients.stock_quantity` is the running total, updated in the SAME
 * transaction (see lib/data/inventory.ts). The ledger is AUTHORITATIVE and
 * append-only at the DB layer — its RLS is SELECT/INSERT-only (lib/db/rls.ts), so
 * a movement is never updated or deleted; corrections/reversals are new inserts.
 *
 * PROVENANCE + IDEMPOTENCY (F1):
 *  - `source_type`/`source_id`/`source_line_id` trace WHY a movement happened
 *    (which order/production/sale/count line produced it).
 *  - `idempotency_key` is a DETERMINISTIC, caller-built key, unique per org, so a
 *    retried/double-submitted write applies the movement exactly once.
 *  - `reversal_of` (set only on `reversal` rows) points at the movement being
 *    undone: an equal-and-opposite insert, never an edit/delete.
 */
export const inventoryMovements = pgTable(
  'inventory_movements',
  {
    id: id(),
    organizationId: orgId(),
    ingredientId: text('ingredient_id').notNull(),
    // Signed canonical change (g / ml / count): + stock in, − stock out.
    deltaCanonical: numeric('delta_canonical', { precision: 12, scale: 2 }).notNull(),
    note: text('note'),
    // Provenance: what kind of event produced this movement. NOT NULL — every
    // movement has a source (legacy rows backfilled to 'seed'/'manual').
    sourceType: text('source_type').notNull(),
    // The source document id (order/production/sale/count) and its specific line.
    // Both nullable: a manual/seed movement has no document; aggregated
    // document-level consumption has no single line.
    sourceId: text('source_id'),
    sourceLineId: text('source_line_id'),
    // Set ONLY on `source_type='reversal'` rows: the movement being undone (same
    // org). A movement can be reversed at most once (partial unique below).
    reversalOf: text('reversal_of'),
    // Deterministic, caller-built dedup key, unique per org. NOT NULL.
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('inventory_movements_org_idx').on(t.organizationId),
    index('inventory_movements_org_ingredient_idx').on(
      t.organizationId,
      t.ingredientId,
    ),
    // Traceability: "every movement from order/production/sale X" (F1).
    index('inventory_movements_org_source_idx').on(
      t.organizationId,
      t.sourceType,
      t.sourceId,
    ),
    // Same-tenant link enforced at the DB level; removing an ingredient also
    // removes its movement history (cascade is exempt from child-table RLS).
    foreignKey({
      columns: [t.organizationId, t.ingredientId],
      foreignColumns: [ingredients.organizationId, ingredients.id],
      name: 'inventory_movements_ingredient_fk',
    }).onDelete('cascade'),
    // Target for the composite self-FK below — lets a reversal reference the
    // original by (organization_id, id), enforcing same-org at the DB level.
    unique('inventory_movements_org_id_key').on(t.organizationId, t.id),
    // Idempotency: one row per (org, deterministic key) → retries dedup.
    unique('inventory_movements_org_idempotency_key').on(
      t.organizationId,
      t.idempotencyKey,
    ),
    // A movement can be reversed AT MOST ONCE. Partial unique so the many
    // non-reversal rows (reversal_of NULL) don't collide.
    uniqueIndex('inventory_movements_org_reversal_of_key')
      .on(t.organizationId, t.reversalOf)
      .where(sql`${t.reversalOf} is not null`),
    // Composite self-FK: a reversal's target must be a real movement in the SAME
    // org. Cascade so purging the original (only ever via ingredient purge) takes
    // the reversal with it, avoiding self-referential delete-ordering issues.
    foreignKey({
      columns: [t.organizationId, t.reversalOf],
      foreignColumns: [t.organizationId, t.id],
      name: 'inventory_movements_reversal_of_fk',
    }).onDelete('cascade'),
  ],
);

/**
 * Ingredient price history (Sprint F2). An append log of observed/derived costs
 * per ingredient: a manual per-unit price entry, or a purchase PACK price seen on
 * a quote/receipt converted to the approved per-unit cost
 * (lib/calculations/purchasePrice.ts). `accepted` flips TRUE on the row whose
 * value became `ingredients.price_cents` via the manager-only "accept cost" action
 * — receiving/quotes NEVER mutate `price_cents` silently (they raise
 * `ingredients.pending_price_cents` instead). Standard org_isolation RLS (it is a
 * log, and accept must flip `accepted`). Retained until the ingredient is fully
 * purged (cascade FK).
 */
export const ingredientPriceHistory = pgTable(
  'ingredient_price_history',
  {
    id: id(),
    organizationId: orgId(),
    ingredientId: text('ingredient_id').notNull(),
    // Where this observation came from.
    source: text('source', {
      enum: ['manual', 'order', 'quote', 'import'],
    }).notNull(),
    // The purchase pack (NULL for a direct manual per-unit price entry).
    packSize: numeric('pack_size', { precision: 12, scale: 2 }),
    packUnit: text('pack_unit'),
    packPriceCents: integer('pack_price_cents'),
    // The approved cost per priced unit (per kg / litre / piece) derived from the
    // pack, or the directly entered manual price. Integer cents.
    derivedPriceCents: integer('derived_price_cents').notNull(),
    // TRUE on the row whose value became ingredients.price_cents.
    accepted: boolean('accepted').notNull().default(false),
    // Clerk user who recorded it (NULL for system / import).
    actorUserId: text('actor_user_id'),
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => [
    index('ingredient_price_history_org_idx').on(t.organizationId),
    // History view: newest-first per ingredient.
    index('ingredient_price_history_org_ingredient_idx').on(
      t.organizationId,
      t.ingredientId,
      t.createdAt,
    ),
    // Same-tenant link; history dies with the ingredient on full purge (F3).
    foreignKey({
      columns: [t.organizationId, t.ingredientId],
      foreignColumns: [ingredients.organizationId, ingredients.id],
      name: 'ingredient_price_history_ingredient_fk',
    }).onDelete('cascade'),
  ],
);

/**
 * Per-organization income/expense categories. Predefined categories are seeded
 * as rows (with a `slug`) so reports group by a STABLE id and a rename never
 * orphans a transaction; their display name comes from i18n
 * (`finance.categories.<slug>`), not this row's `name` (a fallback only). Custom
 * per-org categories are rows with `slug = NULL` and a literal `name`. `kind`
 * keeps income and expense categories apart in the picker and in reports.
 * `isSystem` is derived as `slug != null` (no separate column needed).
 */
export const transactionCategories = pgTable(
  'transaction_categories',
  {
    id: id(),
    organizationId: orgId(),
    // Stable key for predefined rows (NULL = custom). NULLs are distinct in
    // Postgres, so many custom rows coexist; predefined seeding stays idempotent
    // via ON CONFLICT (organization_id, slug).
    slug: text('slug'),
    name: text('name').notNull(),
    kind: text('kind', { enum: ['income', 'expense'] }).notNull(),
    // Manual ordering in the picker; predefined seed sets ascending values.
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('transaction_categories_org_idx').on(t.organizationId),
    // Idempotent predefined seeding (NULLs distinct → custom rows never collide).
    unique('transaction_categories_org_slug_key').on(t.organizationId, t.slug),
    // FK target for transactions' composite (organization_id, category_id).
    unique('transaction_categories_org_id_key').on(t.organizationId, t.id),
  ],
);

/**
 * Money ledger: one row per income/expense entry. RULE #1 — `organization_id` on
 * every row, org-scoped queries, RLS via `businessTables`. The monetary value is
 * a POSITIVE integer-cents magnitude; direction comes from `type` (income vs
 * expense). `occurred_on` is a bare calendar `date` ('YYYY-MM-DD', no time, no
 * timezone): monthly/annual buckets slice the string, so there is zero tz math.
 *
 * `amount_cents` is the FULL GROSS amount the chef records (what hit the bank).
 * Tax is intentionally deferred (Sprint 2 decision): adding it later is a purely
 * additive migration — nullable `tax_rate` (numeric) + `tax_cents` (int), where
 * net = `amount_cents − tax_cents` and existing rows mean "no tax recorded".
 */
export const transactions = pgTable(
  'transactions',
  {
    id: id(),
    organizationId: orgId(),
    type: text('type', { enum: ['income', 'expense'] }).notNull(),
    // Every transaction has a category (predefined "Other income/expense" is the
    // fallback) so by-category reports are complete.
    categoryId: text('category_id').notNull(),
    // Optional link to a recipe → powers "top products" for income. Nullable:
    // income without a recipe is still valid.
    recipeId: text('recipe_id'),
    // Bare calendar date (string mode → 'YYYY-MM-DD'); no time, no timezone.
    occurredOn: date('occurred_on', { mode: 'string' }).notNull(),
    // Positive magnitude in integer cents; sign/direction implied by `type`.
    amountCents: integer('amount_cents').notNull(),
    note: text('note'),
    // Provenance (Sprint F5): when a transaction is the financial PROJECTION of
    // another domain event (a posted sale), these record what produced it. Both
    // nullable — a normal manual transaction has neither. A `source_type='sale'`
    // row is PROTECTED: owned solely by the sale lifecycle, so the generic
    // mutators refuse it, Trash excludes it, and auto-purge skips it. See
    // lib/data/transactions.ts (postSaleTransaction / voidSaleTransaction).
    sourceType: text('source_type'),
    sourceId: text('source_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    // Soft-delete: NULL = active. Reads filter `deleted_at IS NULL` (Trash pattern).
    deletedAt: deletedAt(),
  },
  (t) => [
    index('transactions_org_idx').on(t.organizationId),
    // Period scans (monthly/annual dashboards, list filters).
    index('transactions_org_date_idx').on(t.organizationId, t.occurredOn),
    // Active-row filtering + the /trash listing.
    index('transactions_org_deleted_idx').on(t.organizationId, t.deletedAt),
    // pg_trgm GIN index for typo-tolerant global search (Sprint 2.7), on the
    // free-text note (the only searchable text column on a transaction).
    index('transactions_note_trgm_idx').using('gin', t.note.op('gin_trgm_ops')),
    // A sale posts AT MOST ONE transaction (Sprint F5 dedup): one row per
    // (org, source_type, source_id). Partial — the many normal rows (source_type
    // NULL) don't collide; it also serves "the transaction for sale X" lookups,
    // so no separate plain index is needed.
    uniqueIndex('transactions_org_source_key')
      .on(t.organizationId, t.sourceType, t.sourceId)
      .where(sql`${t.sourceType} is not null`),
    // Provenance is all-or-nothing: both columns NULL or both set. No
    // half-populated source can exist.
    check(
      'transactions_source_pair_chk',
      sql`(${t.sourceType} is null) = (${t.sourceId} is null)`,
    ),
    // Composite FK: the category must share THIS transaction's organization_id —
    // a cross-tenant link is impossible at the DB level. ON DELETE restrict: a
    // category still in use cannot be deleted (the action surfaces CATEGORY_IN_USE).
    foreignKey({
      columns: [t.organizationId, t.categoryId],
      foreignColumns: [
        transactionCategories.organizationId,
        transactionCategories.id,
      ],
      name: 'transactions_category_fk',
    }).onDelete('restrict'),
    // Composite FK to the recipe (same-tenant). ON DELETE restrict, because a
    // multi-column SET NULL would also null the NOT NULL organization_id (PG
    // can't emit the column-subset form); the recipe-purge path nulls recipe_id
    // first instead (see lib/data/recipes.ts). NULL recipe_id rows skip the FK
    // (MATCH SIMPLE).
    foreignKey({
      columns: [t.organizationId, t.recipeId],
      foreignColumns: [recipes.organizationId, recipes.id],
      name: 'transactions_recipe_fk',
    }).onDelete('restrict'),
  ],
);

/**
 * Customers an invoice can be addressed to (Sprint 3, module 6). Org-scoped,
 * soft-deletable (Trash pattern). On purge, referencing invoices have their
 * `customer_id` nulled first (see lib/data/customers.ts) — the invoice keeps its
 * own customer SNAPSHOT, so the historical document still shows who it was for.
 */
export const customers = pgTable(
  'customers',
  {
    id: id(),
    organizationId: orgId(),
    name: text('name').notNull(),
    // Optional billing details (VAT / fiscal number, postal address, contact email).
    taxId: text('tax_id'),
    address: text('address'),
    email: text('email'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    // Soft-delete: NULL = active. Reads filter `deleted_at IS NULL` (Trash pattern).
    deletedAt: deletedAt(),
  },
  (t) => [
    index('customers_org_idx').on(t.organizationId),
    index('customers_org_name_idx').on(t.organizationId, t.name),
    // Serves the /trash listing and keeps active-row filtering index-friendly.
    index('customers_org_deleted_idx').on(t.organizationId, t.deletedAt),
    // FK target for the composite (organization_id, customer_id) reference.
    unique('customers_org_id_key').on(t.organizationId, t.id),
    // pg_trgm GIN indexes for typo-tolerant global search (Sprint 2.7 registry).
    index('customers_name_trgm_idx').using('gin', t.name.op('gin_trgm_ops')),
    index('customers_email_trgm_idx').using('gin', t.email.op('gin_trgm_ops')),
  ],
);

/**
 * Per-organization, per-year invoice number counter (Sprint 3). The ONLY source
 * of sequential invoice numbers. Allocation is a single atomic upsert-increment
 * inside the issuing transaction (see lib/data/invoices.ts), which takes a row
 * lock (serializing concurrent allocations) and commits with the invoice insert —
 * a rollback burns no number, so the sequence is GAP-FREE. `last_seq` is
 * monotonic and never decremented; numbers reset per calendar year.
 */
export const invoiceCounters = pgTable(
  'invoice_counters',
  {
    organizationId: orgId(),
    // Calendar year the sequence belongs to (numbers reset each year).
    year: integer('year').notNull(),
    // Highest sequence number handed out for (org, year) so far.
    lastSeq: integer('last_seq').notNull().default(0),
  },
  (t) => [
    // One counter row per (organization, year); also the upsert conflict target.
    unique('invoice_counters_org_year_key').on(t.organizationId, t.year),
  ],
);

/**
 * Invoices (Sprint 3, module 6). Lifecycle: draft → issued → paid / void.
 *
 * A `draft` is freely editable and has NO number. At the `draft → issued`
 * transition a gap-free number is allocated (invoice_counters) and the customer
 * snapshot + monetary totals are FROZEN — an issued invoice is immutable except
 * for its status (→ paid / void) and internal note. Issued invoices are never
 * deleted (the number must survive for the audit trail); only DRAFTS are
 * soft-deletable. Monetary values are integer cents (CLAUDE.md).
 */
export const invoices = pgTable(
  'invoices',
  {
    id: id(),
    organizationId: orgId(),
    // Live link to the customer; nulled (not cascaded) when the customer is
    // purged, because the snapshot below preserves the historical billing detail.
    customerId: text('customer_id'),
    // Customer SNAPSHOT, captured at issue — survives a customer soft-delete/purge.
    customerName: text('customer_name'),
    customerTaxId: text('customer_tax_id'),
    customerAddress: text('customer_address'),
    customerEmail: text('customer_email'),
    status: text('status', { enum: ['draft', 'issued', 'paid', 'void'] })
      .notNull()
      .default('draft'),
    // Display number (e.g. 'INV-2026-0001'), plus its structured parts for sort /
    // search. All NULL while draft; assigned together at issue.
    number: text('number'),
    seq: integer('seq'),
    year: integer('year'),
    // Bare calendar dates 'YYYY-MM-DD' (no time, no tz), set at issue.
    issueDate: date('issue_date', { mode: 'string' }),
    dueDate: date('due_date', { mode: 'string' }),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    // Frozen totals (integer cents), computed by the pure invoice calc at issue.
    subtotalCents: integer('subtotal_cents').notNull().default(0),
    taxCents: integer('tax_cents').notNull().default(0),
    totalCents: integer('total_cents').notNull().default(0),
    notes: text('notes'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    // Soft-delete: NULL = active. Only DRAFT invoices are ever trashed.
    deletedAt: deletedAt(),
  },
  (t) => [
    index('invoices_org_idx').on(t.organizationId),
    index('invoices_org_status_idx').on(t.organizationId, t.status),
    // Serves the /trash listing and keeps active-row filtering index-friendly.
    index('invoices_org_deleted_idx').on(t.organizationId, t.deletedAt),
    // FK target for invoice_items' composite (organization_id, invoice_id).
    unique('invoices_org_id_key').on(t.organizationId, t.id),
    // One issued number per organization (the gap-free guarantee's DB backstop;
    // NULLs are distinct, so unlimited drafts coexist).
    unique('invoices_org_number_key').on(t.organizationId, t.number),
    // pg_trgm GIN indexes for typo-tolerant global search (find by number / who).
    index('invoices_number_trgm_idx').using('gin', t.number.op('gin_trgm_ops')),
    index('invoices_customer_name_trgm_idx').using(
      'gin',
      t.customerName.op('gin_trgm_ops'),
    ),
    // Composite FK: the customer must share THIS invoice's organization_id — a
    // cross-tenant link is impossible at the DB level. ON DELETE restrict: the
    // customer-purge path nulls customer_id first (a multi-column SET NULL would
    // also null the NOT NULL organization_id). NULL customer_id rows skip the FK.
    foreignKey({
      columns: [t.organizationId, t.customerId],
      foreignColumns: [customers.organizationId, customers.id],
      name: 'invoices_customer_fk',
    }).onDelete('restrict'),
  ],
);

/**
 * Invoice line items (Sprint 3). VAT is modelled PER LINE — food businesses mix
 * standard and reduced rates on one invoice. `unit_price_cents` is the NET unit
 * price (integer cents); `tax_rate` is a numeric percent (e.g. 23.00, not money).
 * Per-line and invoice totals are derived by the pure calc (lib/calculations/
 * invoice.ts); the frozen sums live on the invoice row.
 */
export const invoiceItems = pgTable(
  'invoice_items',
  {
    id: id(),
    organizationId: orgId(),
    invoiceId: text('invoice_id').notNull(),
    description: text('description').notNull(),
    quantity: numeric('quantity', { precision: 12, scale: 3 })
      .notNull()
      .default(sql`0`),
    // Net unit price in integer cents.
    unitPriceCents: integer('unit_price_cents').notNull().default(0),
    // VAT rate as a percentage (0..100); numeric, not money.
    taxRate: numeric('tax_rate', { precision: 5, scale: 2 })
      .notNull()
      .default(sql`0`),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [
    index('invoice_items_org_idx').on(t.organizationId),
    index('invoice_items_invoice_idx').on(t.invoiceId),
    // Composite FK forces the line to share its invoice's organization_id; removing
    // an invoice cascades to its lines.
    foreignKey({
      columns: [t.organizationId, t.invoiceId],
      foreignColumns: [invoices.organizationId, invoices.id],
      name: 'invoice_items_invoice_fk',
    }).onDelete('cascade'),
  ],
);

/**
 * Employees (Sprint 3, module 5). PII — manager-only access (RBAC), and NOT in
 * the shared 30-day trash: "removing" an employee archives it (`active = false`);
 * a separate manager-only hard-delete cascades the shift history. `hourly_rate`
 * is integer cents (CLAUDE.md).
 */
export const employees = pgTable(
  'employees',
  {
    id: id(),
    organizationId: orgId(),
    name: text('name').notNull(),
    email: text('email'),
    hourlyRateCents: integer('hourly_rate_cents').notNull().default(0),
    // Archive flag: false = deactivated (kept for historical shifts), true = active.
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('employees_org_idx').on(t.organizationId),
    index('employees_org_active_idx').on(t.organizationId, t.active),
    // FK target for shifts' composite (organization_id, employee_id).
    unique('employees_org_id_key').on(t.organizationId, t.id),
  ],
);

/**
 * Shifts worked by an employee (Sprint 3). Stores absolute timestamptz INSTANTS
 * for check-in/out, so a shift crossing midnight is just `ended_at − started_at`
 * — no wall-clock or DST math. `ended_at` NULL = an open (checked-in) shift.
 * `break_minutes` is subtracted from worked time by the pure payroll calc.
 */
export const shifts = pgTable(
  'shifts',
  {
    id: id(),
    organizationId: orgId(),
    employeeId: text('employee_id').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    breakMinutes: integer('break_minutes').notNull().default(0),
    note: text('note'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('shifts_org_idx').on(t.organizationId),
    index('shifts_org_employee_idx').on(t.organizationId, t.employeeId),
    index('shifts_org_started_idx').on(t.organizationId, t.startedAt),
    // Composite FK forces the shift to share its employee's organization_id;
    // hard-deleting an employee cascades their shifts.
    foreignKey({
      columns: [t.organizationId, t.employeeId],
      foreignColumns: [employees.organizationId, employees.id],
      name: 'shifts_employee_fk',
    }).onDelete('cascade'),
  ],
);

/**
 * Append-only AUDIT LOG (Sprint 3.1, module-wide). One row per high-risk mutation
 * (financial changes, invoice lifecycle, payroll, trash restore/purge, settings,
 * exports, cron purge). RULE #1 still holds — it carries `organization_id` and is
 * in `businessTables`, so it is org-isolated. UNLIKE every other table its RLS is
 * SELECT/INSERT-only (see lib/db/rls.ts): with FORCE RLS and no UPDATE/DELETE
 * policy, the log can never be edited or erased, even by the app role — append-only
 * is a DB guarantee, not a convention.
 *
 * `actor_user_id` is NULLABLE and `actor_role` accepts `'system'` so the org-less
 * cron purge (no logged-in user) can still attribute its events. `metadata` holds
 * only non-sensitive descriptors (ids, counts, status) — never PII or raw content.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: id(),
    organizationId: orgId(),
    // NULL = non-user actor (cron). Otherwise the Clerk user id.
    actorUserId: text('actor_user_id'),
    // 'manager' | 'kitchen' | 'system' (system = cron/automated, no user).
    actorRole: text('actor_role').notNull(),
    // Stable machine action key, e.g. 'transaction.create', 'invoice.issue'.
    action: text('action').notNull(),
    // The entity kind + id the action touched (id nullable for non-entity events).
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    // Non-sensitive structured context (amounts/counts/status). Never PII.
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    // Correlates all events from one action invocation / request.
    requestId: text('request_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('audit_log_org_idx').on(t.organizationId),
    // Serves the (future) manager audit view: newest-first per org.
    index('audit_log_org_created_idx').on(t.organizationId, t.createdAt),
  ],
);

/**
 * Subscription state MIRROR (Sprint 4c). One row per org (the Clerk org id is the
 * PK, like `organization_settings`) reflecting the latest billing state delivered
 * by Clerk webhooks (`subscription.*` + `organization.deleted` lapse).
 *
 * NOT the enforcement source of truth — feature/plan gating reads Clerk LIVE via
 * `auth().has()` in lib/entitlements.ts (fail-closed). This table is a READ-ONLY
 * projection for display (`/billing`), observability, and ops lapse detection; it
 * never grants access, so a stale or missing row can never widen entitlements.
 *
 * RULE #1 still holds: it carries `organization_id` and is in `businessTables`, so
 * the standard `org_isolation` RLS applies. The webhook is org-less at entry but
 * derives the org id from the VERIFIED payload and writes inside `withOrg(orgId)`
 * (same pattern as the cron purge), so RLS stays active.
 *
 * `plan` stores the RESOLVED tier (`starter|pro|business`, see lib/entitlements);
 * `status` is the raw Clerk subscription status. `last_event_at` is the source
 * event's timestamp and guards against out-of-order Svix delivery (an older event
 * never overwrites a newer state — see lib/data/subscriptions.ts).
 */
export const subscriptions = pgTable('subscriptions', {
  organizationId: text('organization_id').primaryKey(),
  // Resolved PlanTier: 'starter' | 'pro' | 'business' (lib/entitlements.ts).
  plan: text('plan').notNull().default('starter'),
  // Raw Clerk subscription status (active|past_due|canceled|ended|...).
  status: text('status').notNull(),
  // Clerk subscription id, for traceability against the Clerk/Stripe dashboard.
  clerkSubscriptionId: text('clerk_subscription_id'),
  // End of the current paid period when the payload carries it (else NULL).
  currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
  // The last webhook event type applied to this row (e.g. 'subscription.active').
  lastEventType: text('last_event_type').notNull(),
  // The source event's own timestamp — the out-of-order guard compares against it.
  lastEventAt: timestamp('last_event_at', { withTimezone: true }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * Staged import jobs (Sprint 4.5). The server-side staging area for deterministic
 * CSV/XLSX imports: a parse step writes one row here (status `parsed`) holding the
 * NORMALIZED, validated records + per-row issues; a separate confirm step loads it
 * by id under `withOrg` (RLS), re-checks role, applies the records in ONE
 * transaction, and flips the status to `committed` (immutable thereafter).
 *
 * RULE #1 holds — it carries `organization_id` and is in `businessTables`, so the
 * standard `org_isolation` RLS applies. The client never sends rows back: it holds
 * only the job id, so a forged confirm payload can neither alter rows nor reach
 * another org (RLS hides the row). Jobs `expires_at` (24h); the daily cron and a
 * lazy check at confirm reject/clean expired `parsed` jobs.
 *
 * `normalized_rows` / `issues` are non-sensitive structured staging data (the same
 * data the user is about to create) — not the audit log, so no append-only rule.
 */
export const importJobs = pgTable(
  'import_jobs',
  {
    id: id(),
    organizationId: orgId(),
    // The Clerk user who uploaded the file (never null — imports are authenticated).
    actorUserId: text('actor_user_id').notNull(),
    entity: text('entity', {
      enum: ['ingredients', 'transactions', 'recipes', 'recipe_photo'],
    })
      .$type<ImportEntity>()
      .notNull(),
    format: text('format', { enum: ['csv', 'xlsx', 'photo'] })
      .$type<ImportFormat>()
      .notNull(),
    status: text('status', {
      enum: ['parsed', 'committed', 'expired', 'failed'],
    })
      .$type<ImportStatus>()
      .notNull()
      .default('parsed'),
    sourceFilename: text('source_filename'),
    // Count of IMPORTABLE records (rows with hard issues are excluded).
    rowCount: integer('row_count').notNull().default(0),
    // Staged payload (narrowed by `entity`): a flat record array for ingredients/
    // transactions, or the recipe payload (records + resolutions) for recipes.
    normalizedRows: jsonb('normalized_rows').$type<ImportNormalizedRows>(),
    // Per-row problems (stable codes, localized client-side). Never PII.
    issues: jsonb('issues').$type<ImportRowIssue[]>(),
    // Traceability / dedupe hint; the authoritative confirm guard is the status
    // flip under a FOR UPDATE lock, not this key.
    idempotencyKey: text('idempotency_key'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('import_jobs_org_idx').on(t.organizationId),
    index('import_jobs_org_status_idx').on(t.organizationId, t.status),
    // One job per (org, idempotency_key); NULLs are distinct so it never blocks.
    unique('import_jobs_org_idempotency_key').on(
      t.organizationId,
      t.idempotencyKey,
    ),
    // Backs the composite (org, id) FK from `ai_extraction_attempts` (Sprint 4.7),
    // so an attempt can never link to a job in another org.
    unique('import_jobs_org_id_key').on(t.organizationId, t.id),
  ],
);

/**
 * AI photo recipe extraction attempts (Sprint 4.7). One row per extraction try:
 * written `pending` BEFORE the provider call, flipped to `succeeded` (with a link
 * to the staged `import_jobs` row) or `failed` (with an `error_code`). It is the
 * observability + USAGE-METERING ledger — the monthly cap (D4) counts `succeeded`
 * rows for the org in the current month, all inside the extract action's `withOrg`.
 *
 * RULE #1: it carries `organization_id`, is in `businessTables` (standard
 * `org_isolation` RLS), and the optional `import_job_id` link is a composite
 * (org, id) FK so it can only reference THIS org's jobs. `import_job_id` is NULL
 * until a job is staged (a failed attempt has none) — MATCH SIMPLE means NULL rows
 * skip the FK. ON DELETE restrict mirrors the other tables; import jobs are never
 * hard-deleted, so it never blocks.
 *
 * It stores ONLY non-sensitive metadata (provider/model/status, token counts,
 * derived quality flags, an error code) — NEVER the image bytes or raw model prose
 * (CLAUDE.md: ephemeral images, log metadata not contents).
 */
export const aiExtractionAttempts = pgTable(
  'ai_extraction_attempts',
  {
    id: id(),
    organizationId: orgId(),
    // The Clerk user who ran the extraction (never null — extraction is authenticated).
    actorUserId: text('actor_user_id').notNull(),
    // The staged job this attempt produced; NULL until/unless a job is staged.
    importJobId: text('import_job_id'),
    // Vendor + pinned model id (lib/ai/recipe-extraction.ts), for traceability.
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    status: text('status', { enum: ['pending', 'succeeded', 'failed'] })
      .$type<AiExtractionStatus>()
      .notNull()
      .default('pending'),
    // Images sent in this attempt (1 in v1, D3); kept for future multi-image.
    imageCount: integer('image_count').notNull().default(1),
    // Provider token usage, when reported (NULL otherwise). Cost observability only.
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    // Estimated provider cost in micros (millionths of a currency unit); NULL when
    // not computed. This is provider spend metadata, NOT tenant money.
    costMicros: integer('cost_micros'),
    // Derived, stable quality-flag codes (lib/ai/types.ts). Never raw model prose.
    qualityFlags: jsonb('quality_flags').$type<AiQualityFlag[]>(),
    // Stable ActionErrorCode/reason on a failed attempt (NULL when succeeded).
    errorCode: text('error_code'),
    createdAt: createdAt(),
  },
  (t) => [
    index('ai_extraction_attempts_org_idx').on(t.organizationId),
    // Serves the monthly usage count: succeeded rows per org, newest-first.
    index('ai_extraction_attempts_org_created_idx').on(
      t.organizationId,
      t.createdAt,
    ),
    // Same-tenant link enforced at the DB level; NULL import_job_id rows skip it.
    foreignKey({
      columns: [t.organizationId, t.importJobId],
      foreignColumns: [importJobs.organizationId, importJobs.id],
      name: 'ai_extraction_attempts_job_fk',
    }).onDelete('restrict'),
  ],
);

/**
 * Rate-limit buckets (Sprint 3.1). INFRA table — DELIBERATELY NOT a business table:
 * it carries no `organization_id` and is NOT in `businessTables`, so it gets NO RLS.
 * This is the one documented exception to RULE #1 (CLAUDE.md "rate limiting"): the
 * limiter must run for the org-less cron route (authenticated by CRON_SECRET, before
 * any `withOrg`), so it cannot depend on the org GUC. Tenancy is instead encoded —
 * and HASHED — inside the opaque `key` (e.g. sha256('search:<org>:<user>')), so no
 * raw tenant id or secret is ever stored. Fixed-window counter (see lib/rate-limit).
 */
export const rateLimits = pgTable('rate_limits', {
  // Opaque "<bucket>:<sha256(scope)>" — never a raw id/secret (see lib/rate-limit).
  key: text('key').primaryKey(),
  // Start of the current window; reset atomically when it falls out of range.
  windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
  // Hits counted in the current window.
  count: integer('count').notNull(),
});

export type Ingredient = InferSelectModel<typeof ingredients>;
export type NewIngredient = InferInsertModel<typeof ingredients>;
export type InventoryMovement = InferSelectModel<typeof inventoryMovements>;
export type NewInventoryMovement = InferInsertModel<typeof inventoryMovements>;
export type IngredientPriceHistory = InferSelectModel<typeof ingredientPriceHistory>;
export type NewIngredientPriceHistory = InferInsertModel<typeof ingredientPriceHistory>;
export type Recipe = InferSelectModel<typeof recipes>;
export type NewRecipe = InferInsertModel<typeof recipes>;
export type RecipeFolder = InferSelectModel<typeof recipeFolders>;
export type NewRecipeFolder = InferInsertModel<typeof recipeFolders>;
export type RecipeIngredient = InferSelectModel<typeof recipeIngredients>;
export type NewRecipeIngredient = InferInsertModel<typeof recipeIngredients>;
export type OrganizationSettings = InferSelectModel<typeof organizationSettings>;
export type NewOrganizationSettings = InferInsertModel<typeof organizationSettings>;
export type MeasurementSystem = OrganizationSettings['measurementSystem'];
export type TransactionCategory = InferSelectModel<typeof transactionCategories>;
export type NewTransactionCategory = InferInsertModel<typeof transactionCategories>;
export type Transaction = InferSelectModel<typeof transactions>;
export type NewTransaction = InferInsertModel<typeof transactions>;
export type TransactionType = Transaction['type'];
export type CategoryKind = TransactionCategory['kind'];
export type Customer = InferSelectModel<typeof customers>;
export type NewCustomer = InferInsertModel<typeof customers>;
export type Invoice = InferSelectModel<typeof invoices>;
export type NewInvoice = InferInsertModel<typeof invoices>;
export type InvoiceStatus = Invoice['status'];
export type InvoiceItem = InferSelectModel<typeof invoiceItems>;
export type NewInvoiceItem = InferInsertModel<typeof invoiceItems>;
export type Employee = InferSelectModel<typeof employees>;
export type NewEmployee = InferInsertModel<typeof employees>;
export type Shift = InferSelectModel<typeof shifts>;
export type NewShift = InferInsertModel<typeof shifts>;
export type AuditLogEntry = InferSelectModel<typeof auditLog>;
export type NewAuditLogEntry = InferInsertModel<typeof auditLog>;
export type Subscription = InferSelectModel<typeof subscriptions>;
export type NewSubscription = InferInsertModel<typeof subscriptions>;
export type ImportJob = InferSelectModel<typeof importJobs>;
export type NewImportJob = InferInsertModel<typeof importJobs>;
export type AiExtractionAttempt = InferSelectModel<typeof aiExtractionAttempts>;
export type NewAiExtractionAttempt = InferInsertModel<typeof aiExtractionAttempts>;
export type RateLimitRow = InferSelectModel<typeof rateLimits>;

/** All business tables, for applying RLS in bulk. */
export const businessTables = [
  'organization_settings',
  'ingredients',
  'recipe_folders',
  'recipes',
  'recipe_ingredients',
  'inventory_movements',
  // Ingredient price history (Sprint F2) — standard org_isolation RLS.
  'ingredient_price_history',
  'transaction_categories',
  'transactions',
  'customers',
  'invoice_counters',
  'invoices',
  'invoice_items',
  'employees',
  'shifts',
  // Append-only audit log: org-isolated like the rest, but its RLS is
  // SELECT/INSERT-only (lib/db/rls.ts) so it can never be edited or erased.
  'audit_log',
  // Billing-state mirror (Sprint 4c) — standard org_isolation RLS.
  'subscriptions',
  // Staged import jobs (Sprint 4.5) — standard org_isolation RLS.
  'import_jobs',
  // AI extraction attempts (Sprint 4.7) — observability + usage metering, standard
  // org_isolation RLS.
  'ai_extraction_attempts',
  // NOTE: `rate_limits` is intentionally ABSENT — it is infra, not tenant data,
  // and must work without an org context (see its table comment + lib/db/rls.ts).
] as const;
