import { sql, type InferSelectModel, type InferInsertModel } from 'drizzle-orm';
import {
  pgTable,
  text,
  integer,
  numeric,
  timestamp,
  date,
  index,
  unique,
  foreignKey,
} from 'drizzle-orm/pg-core';

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
 * Append-only inventory ledger. Each row is a signed canonical change to an
 * ingredient's stock (positive = in, negative = out). `ingredients.stock_quantity`
 * is the running total, updated in the same transaction (see lib/data/inventory.ts).
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
    createdAt: createdAt(),
  },
  (t) => [
    index('inventory_movements_org_idx').on(t.organizationId),
    index('inventory_movements_org_ingredient_idx').on(
      t.organizationId,
      t.ingredientId,
    ),
    // Same-tenant link enforced at the DB level; removing an ingredient also
    // removes its movement history.
    foreignKey({
      columns: [t.organizationId, t.ingredientId],
      foreignColumns: [ingredients.organizationId, ingredients.id],
      name: 'inventory_movements_ingredient_fk',
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

export type Ingredient = InferSelectModel<typeof ingredients>;
export type NewIngredient = InferInsertModel<typeof ingredients>;
export type InventoryMovement = InferSelectModel<typeof inventoryMovements>;
export type NewInventoryMovement = InferInsertModel<typeof inventoryMovements>;
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

/** All business tables, for applying RLS in bulk. */
export const businessTables = [
  'organization_settings',
  'ingredients',
  'recipe_folders',
  'recipes',
  'recipe_ingredients',
  'inventory_movements',
  'transaction_categories',
  'transactions',
] as const;
