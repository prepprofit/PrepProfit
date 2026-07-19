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
import type {
  AiOperationStatus,
  AiOperationFeature,
  SupplierInvoiceImportStatus,
  SupplierInvoiceLineStatus,
  SupplierInvoiceLineIssueCode,
  ProfitLeakExplanationData,
} from '@/lib/ai/operation-types';
import { ALLERGEN_SLUGS, PRESENCE_VALUES } from '@/lib/allergens/catalog';

// The 14-slug + 2-presence whitelists as SQL string literals, so the DB CHECK
// constraints repeat the catalog (defense-in-depth beside the Zod enum). Built
// from the single source of truth (lib/allergens/catalog.ts) so they can never
// drift. e.g. "'cereals_gluten','crustaceans',...".
const ALLERGEN_SLUG_SQL_LIST = ALLERGEN_SLUGS.map((s) => `'${s}'`).join(', ');
const PRESENCE_SQL_LIST = PRESENCE_VALUES.map((p) => `'${p}'`).join(', ');

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
  currency: text('currency').notNull().default('USD'),
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
  // Weekly CFO report email opt-in (React Email migration). When TRUE and a
  // `business_email` is set and the org is on a paid tier, the weekly enqueue cron
  // queues ONE deterministic CFO digest to `business_email`. Default OFF for every
  // existing and new org; a manager-only toggle in /settings flips it. The email is
  // the deterministic report only — it never spends an AI quota unit.
  weeklyCfoReportEmailEnabled: boolean('weekly_cfo_report_email_enabled')
    .notNull()
    .default(false),
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
  // Feature flag: Recipes 2.0 workspace (Meez-parity plan, Release B). Per-org
  // opt-in; the legacy editor stays the default until rollout completes. OFF for
  // every existing org (additive default false).
  recipesWorkspaceV2: boolean('recipes_workspace_v2').notNull().default(false),
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
    // Suggested USDA FDC id carried over from the seed ingredient catalogue
    // (docs/ingredient-seed-catalog-plan.md D3). A HINT only: the Nutrition tab
    // may offer a one-click import of this profile via the existing Fase 6 flow
    // (which re-fetches server-side). Never used in any calculation directly.
    suggestedFdcId: integer('suggested_fdc_id'),
    // Allergen review provenance (Sprint 9). `reviewed_at` NULL = the ingredient's
    // allergens have never been reviewed (NOT "no allergens" — correctly unreviewed);
    // a timestamp = reviewed then. `reviewed_by` is the Clerk user id who reviewed.
    // The derived boolean "reviewed" = `reviewed_at IS NOT NULL`. Stamped atomically
    // by the allergen-replace flow (lib/data/allergens.ts), even on an empty set.
    allergensReviewedAt: timestamp('allergens_reviewed_at', { withTimezone: true }),
    allergensReviewedBy: text('allergens_reviewed_by'),
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
 * Cross-dimension unit anchors for one ingredient (Recipes 2.0, plan §6.6). At
 * most one row per ingredient; at least two positive anchors are required to be
 * useful (validation layer). Anchors are CANONICAL quantities that describe the
 * SAME amount of the ingredient (e.g. 141.75 g = 236.59 ml = 1 each), enabling
 * weight↔volume↔count conversion. Conversion NEVER assumes 1 ml = 1 g — a
 * missing anchor means the conversion is honestly impossible.
 *
 * RULE #1: carries `organization_id`, in `businessTables` → standard
 * org_isolation RLS. Composite (org, ingredient_id) FK, ON DELETE cascade.
 */
export const ingredientUomEquivalencies = pgTable(
  'ingredient_uom_equivalencies',
  {
    id: id(),
    organizationId: orgId(),
    ingredientId: text('ingredient_id').notNull(),
    weightGrams: numeric('weight_grams', {
      precision: 12,
      scale: 4,
      mode: 'number',
    }),
    volumeMl: numeric('volume_ml', {
      precision: 12,
      scale: 4,
      mode: 'number',
    }),
    eachCount: numeric('each_count', {
      precision: 12,
      scale: 4,
      mode: 'number',
    }),
    // 'manual' = typed by the user; 'standard' = accepted from a suggested
    // standard (locks manual editing in the UI while active).
    source: text('source', { enum: ['manual', 'standard'] })
      .notNull()
      .default('manual'),
    updatedBy: text('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('ingredient_uom_equivalencies_org_idx').on(t.organizationId),
    // One equivalency row per ingredient.
    unique('ingredient_uom_equivalencies_org_ingredient_key').on(
      t.organizationId,
      t.ingredientId,
    ),
    unique('ingredient_uom_equivalencies_org_id_key').on(
      t.organizationId,
      t.id,
    ),
    // Anchors are strictly positive when present (NULL = no anchor).
    check(
      'ingredient_uom_equivalencies_weight_chk',
      sql`${t.weightGrams} IS NULL OR ${t.weightGrams} > 0`,
    ),
    check(
      'ingredient_uom_equivalencies_volume_chk',
      sql`${t.volumeMl} IS NULL OR ${t.volumeMl} > 0`,
    ),
    check(
      'ingredient_uom_equivalencies_each_chk',
      sql`${t.eachCount} IS NULL OR ${t.eachCount} > 0`,
    ),
    foreignKey({
      columns: [t.organizationId, t.ingredientId],
      foreignColumns: [ingredients.organizationId, ingredients.id],
      name: 'ingredient_uom_equivalencies_ingredient_fk',
    }).onDelete('cascade'),
  ],
);

/**
 * Named prep transformations of an ingredient with their own usable yield
 * (Recipes 2.0, plan §6.6): "diced" onion yields 78.54% of the whole onion.
 * `yield_bps` is basis points (7854 = 78.54%). The optional anchors OVERRIDE the
 * ingredient's base equivalency for this prep state ("onion, diced" packs
 * differently than "onion, whole"). Prep loss feeds cost / required purchase —
 * the line's canonical quantity stays what the recipe actually uses (no double
 * loss application; see lib/calculations contract).
 *
 * RULE #1: carries `organization_id`, in `businessTables` → standard
 * org_isolation RLS. Composite (org, ingredient_id) FK, ON DELETE cascade.
 */
export const ingredientPrepActions = pgTable(
  'ingredient_prep_actions',
  {
    id: id(),
    organizationId: orgId(),
    ingredientId: text('ingredient_id').notNull(),
    name: text('name').notNull(),
    // Usable yield in basis points; 1..10000 (a 0%-yield prep is meaningless).
    yieldBps: integer('yield_bps').notNull(),
    weightGrams: numeric('weight_grams', {
      precision: 12,
      scale: 4,
      mode: 'number',
    }),
    volumeMl: numeric('volume_ml', {
      precision: 12,
      scale: 4,
      mode: 'number',
    }),
    eachCount: numeric('each_count', {
      precision: 12,
      scale: 4,
      mode: 'number',
    }),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('ingredient_prep_actions_org_idx').on(t.organizationId),
    index('ingredient_prep_actions_org_ingredient_sort_idx').on(
      t.organizationId,
      t.ingredientId,
      t.sortOrder,
    ),
    // FK target for recipe lines referencing a prep action.
    unique('ingredient_prep_actions_org_id_key').on(t.organizationId, t.id),
    // One prep-action name per ingredient, case-insensitive.
    uniqueIndex('ingredient_prep_actions_org_ingredient_name_key').on(
      t.organizationId,
      t.ingredientId,
      sql`lower(${t.name})`,
    ),
    check(
      'ingredient_prep_actions_yield_bps_chk',
      sql`${t.yieldBps} > 0 AND ${t.yieldBps} <= 10000`,
    ),
    check(
      'ingredient_prep_actions_weight_chk',
      sql`${t.weightGrams} IS NULL OR ${t.weightGrams} > 0`,
    ),
    check(
      'ingredient_prep_actions_volume_chk',
      sql`${t.volumeMl} IS NULL OR ${t.volumeMl} > 0`,
    ),
    check(
      'ingredient_prep_actions_each_chk',
      sql`${t.eachCount} IS NULL OR ${t.eachCount} > 0`,
    ),
    check('ingredient_prep_actions_sort_order_chk', sql`${t.sortOrder} >= 0`),
    foreignKey({
      columns: [t.organizationId, t.ingredientId],
      foreignColumns: [ingredients.organizationId, ingredients.id],
      name: 'ingredient_prep_actions_ingredient_fk',
    }).onDelete('cascade'),
  ],
);

/**
 * Nutrition profile of an ingredient, per 100 g edible weight (Recipes 2.0,
 * plan §6.7). ONE active profile per ingredient. Every nutrient is nullable —
 * NULL means UNKNOWN, never zero; recipe nutrition propagates that honestly
 * (an unknown nutrient makes the recipe's calc incomplete, plan §7.4). A USDA
 * selection stores a normalized SNAPSHOT + source metadata: later API changes
 * never rewrite recipes until the user explicitly refreshes from source.
 * Allergens stay fully independent of this table (absence in USDA never means
 * allergen-free).
 *
 * RULE #1: carries `organization_id`, in `businessTables` → standard
 * org_isolation RLS. Composite (org, ingredient_id) FK, ON DELETE cascade.
 */
export const ingredientNutritionProfiles = pgTable(
  'ingredient_nutrition_profiles',
  {
    id: id(),
    organizationId: orgId(),
    ingredientId: text('ingredient_id').notNull(),
    source: text('source', {
      enum: ['usda', 'open_food_facts', 'custom'],
    }).notNull(),
    // USDA FoodData Central identifiers (NULL for custom profiles). Kept for
    // backward compatibility during the Open Food Facts migration; the generic
    // identity below (`external_source_id`/`external_source_type`) is the source
    // of truth going forward and a later cleanup PR removes these two.
    fdcId: integer('fdc_id'),
    fdcDataType: text('fdc_data_type'),
    // Provider-neutral identity (Open Food Facts integration plan §6.1). For a
    // USDA profile this is `fdc_id::text`; for Open Food Facts it is the
    // normalized GTIN (a STRING, so leading zeroes survive). `external_source_type`
    // is the USDA data type or a provider-specific subtype.
    externalSourceId: text('external_source_id'),
    externalSourceType: text('external_source_type'),
    // Normalized product code (barcode providers only; NULL for USDA/custom).
    barcode: text('barcode'),
    // Market/relevance context of the lookup — NOT manufacturing origin.
    sourceCountry: text('source_country'),
    sourceLanguage: text('source_language'),
    // Provider revision string, when available (e.g. Open Food Facts `rev`).
    sourceRevision: text('source_revision'),
    // Version of PrepProfit's mapping/derivation logic that produced this row.
    normalizationVersion: integer('normalization_version'),
    // Debug/audit identity of the source body WITHOUT storing the raw payload.
    sourcePayloadHash: text('source_payload_hash'),
    // Snapshot quality classification (Open Food Facts plan §11).
    qualityStatus: text('quality_status', {
      enum: ['complete', 'partial', 'rejected'],
    }),
    // Stable machine warning codes (never translated sentences).
    qualityWarnings: jsonb('quality_warnings').$type<string[]>(),
    sourceDescription: text('source_description'),
    brandOwner: text('brand_owner'),
    // Reference mass the nutrient columns describe (per-100 g contract).
    basisGrams: numeric('basis_grams', {
      precision: 12,
      scale: 4,
      mode: 'number',
    })
      .notNull()
      .default(100),
    caloriesKcal: numeric('calories_kcal', { precision: 12, scale: 4, mode: 'number' }),
    totalFatG: numeric('total_fat_g', { precision: 12, scale: 4, mode: 'number' }),
    saturatedFatG: numeric('saturated_fat_g', { precision: 12, scale: 4, mode: 'number' }),
    transFatG: numeric('trans_fat_g', { precision: 12, scale: 4, mode: 'number' }),
    cholesterolMg: numeric('cholesterol_mg', { precision: 12, scale: 4, mode: 'number' }),
    sodiumMg: numeric('sodium_mg', { precision: 12, scale: 4, mode: 'number' }),
    totalCarbohydrateG: numeric('total_carbohydrate_g', { precision: 12, scale: 4, mode: 'number' }),
    dietaryFiberG: numeric('dietary_fiber_g', { precision: 12, scale: 4, mode: 'number' }),
    totalSugarsG: numeric('total_sugars_g', { precision: 12, scale: 4, mode: 'number' }),
    addedSugarsG: numeric('added_sugars_g', { precision: 12, scale: 4, mode: 'number' }),
    proteinG: numeric('protein_g', { precision: 12, scale: 4, mode: 'number' }),
    vitaminDMcg: numeric('vitamin_d_mcg', { precision: 12, scale: 4, mode: 'number' }),
    calciumMg: numeric('calcium_mg', { precision: 12, scale: 4, mode: 'number' }),
    ironMg: numeric('iron_mg', { precision: 12, scale: 4, mode: 'number' }),
    potassiumMg: numeric('potassium_mg', { precision: 12, scale: 4, mode: 'number' }),
    caffeineMg: numeric('caffeine_mg', { precision: 12, scale: 4, mode: 'number' }),
    // European salt value per profile basis (g). Kept alongside `sodium_mg`
    // (which drives the recipe calc) for label display; NULL = unknown.
    saltG: numeric('salt_g', { precision: 12, scale: 4, mode: 'number' }),
    // When the SOURCE last changed its data / when we last pulled it.
    sourceUpdatedAt: timestamp('source_updated_at', { withTimezone: true }),
    refreshedAt: timestamp('refreshed_at', { withTimezone: true }),
    updatedBy: text('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('ingredient_nutrition_profiles_org_idx').on(t.organizationId),
    // One active profile per ingredient.
    unique('ingredient_nutrition_profiles_org_ingredient_key').on(
      t.organizationId,
      t.ingredientId,
    ),
    unique('ingredient_nutrition_profiles_org_id_key').on(
      t.organizationId,
      t.id,
    ),
    check(
      'ingredient_nutrition_profiles_basis_chk',
      sql`${t.basisGrams} > 0`,
    ),
    foreignKey({
      columns: [t.organizationId, t.ingredientId],
      foreignColumns: [ingredients.organizationId, ingredients.id],
      name: 'ingredient_nutrition_profiles_ingredient_fk',
    }).onDelete('cascade'),
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
    // Usable finished batch/output weight for the recipe as currently written, in
    // canonical grams (Recipe-editor parity). OPERATIONAL physical data — both
    // manager and kitchen edit it, like yield portions/percentage; it carries no
    // money. NULL = not set: existing recipes stay valid and we never infer it from
    // ingredient lines. It anchors manager-only cost/kg and kitchen target-weight
    // presets. `mode: 'number'` (unlike the g/ml `quantity` columns, which stay
    // string-mode): a Zod-validated `z.number()` flows straight to/from the typed
    // column with no string juggling, and a 2-decimal value ≤ 1e8 is exact in a JS number.
    yieldWeightGrams: numeric('yield_weight_grams', {
      precision: 10,
      scale: 2,
      mode: 'number',
    }),
    // Hidden per-recipe costs beyond ingredients, in integer cents (CLAUDE.md).
    laborCostCents: integer('labor_cost_cents').notNull().default(0),
    energyCostCents: integer('energy_cost_cents').notNull().default(0),
    packagingCostCents: integer('packaging_cost_cents').notNull().default(0),
    // Optional selling price per portion, in cents — drives margin + traffic light.
    sellingPriceCents: integer('selling_price_cents'),
    notes: text('notes'),
    // ---- Recipes 2.0 additive columns (plan §6.1) ----
    // Secondary display line under the name (e.g. category / style).
    subtitle: text('subtitle'),
    // Optimistic-concurrency version: incremented on every workspace save.
    // Saves carry `expectedVersion`; a mismatch is a conflict, never a silent
    // overwrite (plan decision 3).
    version: integer('version').notNull().default(1),
    // Yield as the chef describes it ("3 qt", "30 lb", "1 serving"). NULL = not
    // set (legacy recipes backfill from yield_portions). `yield_weight_grams`
    // above remains the physical anchor for cost/kg, presets and conversions.
    yieldQuantity: numeric('yield_quantity', {
      precision: 12,
      scale: 4,
      mode: 'number',
    }),
    yieldUnit: text('yield_unit'),
    // Nutrition serving definition for the label (plan §6.1); NULL = not set →
    // label stays incomplete/disabled.
    nutritionServingQuantity: numeric('nutrition_serving_quantity', {
      precision: 12,
      scale: 4,
      mode: 'number',
    }),
    nutritionServingUnit: text('nutrition_serving_unit'),
    servingsPerContainer: numeric('servings_per_container', {
      precision: 12,
      scale: 4,
      mode: 'number',
    }),
    // Cover media. Points at a confirmed recipe_media row of the SAME recipe and
    // organization — enforced by the workspace save (media-ownership validation),
    // not a DB FK: recipes ↔ recipe_media would be circular table definitions.
    coverMediaId: text('cover_media_id'),
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

/**
 * Ingredient-list section headers inside one recipe (Recipes 2.0, plan §6.2) —
 * e.g. "Dough", "Filling". Ingredient AND component lines may point at a
 * section; NULL section = the implicit default group. Ordering across headers
 * and lines is a single merged visual sequence persisted transactionally.
 *
 * RULE #1: carries `organization_id`, in `businessTables` → standard
 * org_isolation RLS. Composite (org, recipe_id) FK, ON DELETE cascade.
 */
export const recipeIngredientSections = pgTable(
  'recipe_ingredient_sections',
  {
    id: id(),
    organizationId: orgId(),
    recipeId: text('recipe_id').notNull(),
    title: text('title').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('recipe_ingredient_sections_org_idx').on(t.organizationId),
    index('recipe_ingredient_sections_org_recipe_sort_idx').on(
      t.organizationId,
      t.recipeId,
      t.sortOrder,
    ),
    // FK target for lines referencing their section.
    unique('recipe_ingredient_sections_org_id_key').on(t.organizationId, t.id),
    check(
      'recipe_ingredient_sections_sort_order_chk',
      sql`${t.sortOrder} >= 0`,
    ),
    foreignKey({
      columns: [t.organizationId, t.recipeId],
      foreignColumns: [recipes.organizationId, recipes.id],
      name: 'recipe_ingredient_sections_recipe_fk',
    }).onDelete('cascade'),
  ],
);

/**
 * Media objects (image/video) attached to a recipe (Recipes 2.0, plan §6.4).
 * The actual bytes live in a PRIVATE S3-compatible bucket behind the
 * `RecipeMediaStorage` adapter — never in Postgres. `storage_key` is built
 * server-side as `org/{orgId}/recipes/{recipeId}/{mediaId}` (filenames never
 * form keys). Lifecycle: `pending` (signed upload issued) → `ready` (bytes
 * validated + confirmed) → `deleted` (soft; async idempotent bucket removal),
 * or `rejected` (validation failed). Unconfirmed `pending` rows are swept by
 * cron. Upload/delete are audited without logging media content.
 *
 * RULE #1: carries `organization_id`, in `businessTables` → standard
 * org_isolation RLS. Composite (org, recipe_id) FK, ON DELETE cascade.
 */
export const recipeMedia = pgTable(
  'recipe_media',
  {
    id: id(),
    organizationId: orgId(),
    recipeId: text('recipe_id').notNull(),
    storageKey: text('storage_key').notNull().unique(),
    kind: text('kind', { enum: ['image', 'video'] }).notNull(),
    mimeType: text('mime_type').notNull(),
    byteSize: integer('byte_size'),
    width: integer('width'),
    height: integer('height'),
    durationMs: integer('duration_ms'),
    status: text('status', {
      enum: ['pending', 'ready', 'rejected', 'deleted'],
    })
      .notNull()
      .default('pending'),
    sha256: text('sha256'),
    uploadedBy: text('uploaded_by'),
    createdAt: createdAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index('recipe_media_org_idx').on(t.organizationId),
    index('recipe_media_org_recipe_idx').on(t.organizationId, t.recipeId),
    // Serves the pending-sweeper cron (status + age scan).
    index('recipe_media_status_created_idx').on(t.status, t.createdAt),
    // FK target for step-media links and (app-level) cover references.
    unique('recipe_media_org_id_key').on(t.organizationId, t.id),
    foreignKey({
      columns: [t.organizationId, t.recipeId],
      foreignColumns: [recipes.organizationId, recipes.id],
      name: 'recipe_media_recipe_fk',
    }).onDelete('cascade'),
  ],
);

/**
 * Recipe Books (Recipes 2.0, plan §6.5) — the many-to-many replacement for the
 * visual concept of folders. A recipe can belong to zero or many books. The
 * folder backfill turns each folder into a book and each `recipes.folder_id`
 * into a membership; `recipe_folders`/`folder_id` stay untouched (deprecation
 * is a later, separate migration — plan Release A).
 *
 * RULE #1: carries `organization_id`, in `businessTables` → standard
 * org_isolation RLS.
 */
export const recipeBooks = pgTable(
  'recipe_books',
  {
    id: id(),
    organizationId: orgId(),
    name: text('name').notNull(),
    icon: text('icon'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('recipe_books_org_idx').on(t.organizationId),
    index('recipe_books_org_sort_idx').on(t.organizationId, t.sortOrder),
    // One book name per organization (also the idempotency key for the folder
    // backfill).
    unique('recipe_books_org_name_key').on(t.organizationId, t.name),
    unique('recipe_books_org_id_key').on(t.organizationId, t.id),
    check('recipe_books_sort_order_chk', sql`${t.sortOrder} >= 0`),
  ],
);

export const recipeBookEntries = pgTable(
  'recipe_book_entries',
  {
    id: id(),
    organizationId: orgId(),
    recipeBookId: text('recipe_book_id').notNull(),
    recipeId: text('recipe_id').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    index('recipe_book_entries_org_idx').on(t.organizationId),
    // Serves "recipes of this book" in manual order.
    index('recipe_book_entries_org_book_sort_idx').on(
      t.organizationId,
      t.recipeBookId,
      t.sortOrder,
    ),
    // Serves "books of this recipe".
    index('recipe_book_entries_org_recipe_idx').on(
      t.organizationId,
      t.recipeId,
    ),
    // One membership per (book, recipe) pair — also the backfill idempotency key.
    unique('recipe_book_entries_org_book_recipe_key').on(
      t.organizationId,
      t.recipeBookId,
      t.recipeId,
    ),
    foreignKey({
      columns: [t.organizationId, t.recipeBookId],
      foreignColumns: [recipeBooks.organizationId, recipeBooks.id],
      name: 'recipe_book_entries_book_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.organizationId, t.recipeId],
      foreignColumns: [recipes.organizationId, recipes.id],
      name: 'recipe_book_entries_recipe_fk',
    }).onDelete('cascade'),
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
    // ---- Recipes 2.0 additive columns (plan §6.2) ----
    // Section header this line sits under; NULL = default group.
    sectionId: text('section_id'),
    // Position in the MERGED visual sequence (headers + ingredient lines +
    // component lines). Legacy `sort_order` above keeps the old editor working
    // until Release C retires it.
    displaySortOrder: integer('display_sort_order').notNull().default(0),
    // Free-text note shown under the line ("finely chopped, divided").
    note: text('note'),
    // Optional prep state of the ingredient for this line.
    prepActionId: text('prep_action_id'),
    // What the chef literally typed ("2 cups"), preserved verbatim. `quantity`
    // stays the canonical source for cost/stock; the server recalculates it when
    // unit/prep changes — later equivalency edits never rewrite old lines.
    enteredQuantity: numeric('entered_quantity', {
      precision: 12,
      scale: 4,
      mode: 'number',
    }),
    enteredUnit: text('entered_unit'),
  },
  (t) => [
    index('recipe_ingredients_org_idx').on(t.organizationId),
    index('recipe_ingredients_recipe_idx').on(t.recipeId),
    // NOTE (Recipes 2.0): the historical unique (recipe_id, ingredient_id) was
    // DROPPED — the row id is the line identity, so "salt" may appear in two
    // sections (plan §6.2).
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
    // Recipes 2.0: same-org section link. ON DELETE cascade because a section
    // only disappears via recipe purge (lines die anyway) or an explicit section
    // delete, where the workspace save detaches/moves surviving lines in the
    // same transaction BEFORE removing the header.
    foreignKey({
      columns: [t.organizationId, t.sectionId],
      foreignColumns: [
        recipeIngredientSections.organizationId,
        recipeIngredientSections.id,
      ],
      name: 'recipe_ingredients_section_fk',
    }).onDelete('cascade'),
    // Recipes 2.0: same-org prep-action link; a prep action referenced by any
    // line cannot be deleted (the UI offers detach first).
    foreignKey({
      columns: [t.organizationId, t.prepActionId],
      foreignColumns: [
        ingredientPrepActions.organizationId,
        ingredientPrepActions.id,
      ],
      name: 'recipe_ingredients_prep_action_fk',
    }).onDelete('restrict'),
    check(
      'recipe_ingredients_display_sort_order_chk',
      sql`${t.displaySortOrder} >= 0`,
    ),
    check(
      'recipe_ingredients_entered_quantity_chk',
      sql`${t.enteredQuantity} IS NULL OR ${t.enteredQuantity} >= 0`,
    ),
  ],
);

/**
 * Kitchen presets (Recipe-editor parity). A named TARGET FINISHED WEIGHT (e.g.
 * "18cm Cake", "Individual portion") that scales the recipe in one click:
 * `factor = target_weight_grams / recipes.yield_weight_grams` (derive-on-read — no
 * scaled lines are ever stored). OPERATIONAL config: both manager and kitchen
 * manage name + weight; the per-preset COST preview is derived manager-side only,
 * never stored here and never shipped to kitchen.
 *
 * RULE #1: carries `organization_id`, in `businessTables` → standard org_isolation
 * RLS. The composite (org, recipe_id) FK is ON DELETE cascade: presets die with the
 * recipe on full purge. `target_weight_grams` is canonical grams (numeric(10,2),
 * `mode: 'number'` like recipes.yield_weight_grams) with a DB CHECK `> 0`. Per-recipe
 * case-insensitive name uniqueness via a functional unique index; `sort_order` gives
 * a stable manual order. `unique (org, id)` is the FK target other tables would use.
 */
export const recipePresets = pgTable(
  'recipe_presets',
  {
    id: id(),
    organizationId: orgId(),
    recipeId: text('recipe_id').notNull(),
    name: text('name').notNull(),
    // Target finished weight in canonical grams; strictly positive (CHECK below).
    targetWeightGrams: numeric('target_weight_grams', {
      precision: 10,
      scale: 2,
      mode: 'number',
    }).notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('recipe_presets_org_idx').on(t.organizationId),
    // Serves per-recipe listing in manual order.
    index('recipe_presets_org_recipe_sort_idx').on(
      t.organizationId,
      t.recipeId,
      t.sortOrder,
    ),
    // FK target for the composite (organization_id, id) reference.
    unique('recipe_presets_org_id_key').on(t.organizationId, t.id),
    // One preset name per recipe, case-insensitive (rename/create surface the violation).
    uniqueIndex('recipe_presets_org_recipe_name_key').on(
      t.organizationId,
      t.recipeId,
      sql`lower(${t.name})`,
    ),
    check('recipe_presets_target_weight_chk', sql`${t.targetWeightGrams} > 0`),
    check('recipe_presets_sort_order_chk', sql`${t.sortOrder} >= 0`),
    // Composite FK forces the preset to share THIS recipe's organization_id — a
    // preset can never attach to another tenant's recipe. ON DELETE cascade: purging
    // a recipe takes its presets with it.
    foreignKey({
      columns: [t.organizationId, t.recipeId],
      foreignColumns: [recipes.organizationId, recipes.id],
      name: 'recipe_presets_recipe_fk',
    }).onDelete('cascade'),
  ],
);

/**
 * Sub-recipe component lines (recipe-in-recipe). A parent recipe uses another
 * recipe's FINISHED OUTPUT as a material input, measured in grams of that
 * finished output (v1 unit is grams only). Costs, allergens, and stock
 * explosion are derive-on-read through the component graph — nothing cached.
 * Cycle/depth (max 5) invariants are enforced by the data layer at write time
 * under FOR UPDATE row locks; read resolvers re-guard with visited/depth.
 *
 * RULE #1: carries `organization_id`, in `businessTables` → standard
 * org_isolation RLS. Composite same-org FKs on both endpoints: parent ON
 * DELETE cascade (purging a recipe removes its outgoing component lines),
 * component ON DELETE restrict (a recipe referenced as a component cannot be
 * purged while any component row survives).
 */
export const recipeComponents = pgTable(
  'recipe_components',
  {
    id: id(),
    organizationId: orgId(),
    recipeId: text('recipe_id').notNull(),
    componentRecipeId: text('component_recipe_id').notNull(),
    // Grams of the component recipe's finished output; strictly positive
    // (CHECK below). `mode: 'number'` like recipes.yield_weight_grams.
    quantityGrams: numeric('quantity_grams', {
      precision: 10,
      scale: 2,
      mode: 'number',
    }).notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    // ---- Recipes 2.0 additive columns (plan §6.2) — mirror recipe_ingredients
    // so component lines share the merged visual sequence, sections and notes.
    sectionId: text('section_id'),
    displaySortOrder: integer('display_sort_order').notNull().default(0),
    note: text('note'),
  },
  (t) => [
    index('recipe_components_org_idx').on(t.organizationId),
    // Serves per-recipe listing in manual order.
    index('recipe_components_org_recipe_sort_idx').on(
      t.organizationId,
      t.recipeId,
      t.sortOrder,
    ),
    // Serves reverse lookups: "which parents use this component?" (trash/purge/
    // yield-clear guards) and the upward revalidation walk.
    index('recipe_components_org_component_idx').on(
      t.organizationId,
      t.componentRecipeId,
    ),
    // One component line per (parent, component) pair.
    unique('recipe_components_org_parent_component_key').on(
      t.organizationId,
      t.recipeId,
      t.componentRecipeId,
    ),
    check(
      'recipe_components_not_self_chk',
      sql`${t.recipeId} <> ${t.componentRecipeId}`,
    ),
    check('recipe_components_quantity_chk', sql`${t.quantityGrams} > 0`),
    check('recipe_components_sort_order_chk', sql`${t.sortOrder} >= 0`),
    foreignKey({
      columns: [t.organizationId, t.recipeId],
      foreignColumns: [recipes.organizationId, recipes.id],
      name: 'recipe_components_parent_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.organizationId, t.componentRecipeId],
      foreignColumns: [recipes.organizationId, recipes.id],
      name: 'recipe_components_component_fk',
    }).onDelete('restrict'),
    // Recipes 2.0: same-org section link (same semantics as
    // recipe_ingredients_section_fk).
    foreignKey({
      columns: [t.organizationId, t.sectionId],
      foreignColumns: [
        recipeIngredientSections.organizationId,
        recipeIngredientSections.id,
      ],
      name: 'recipe_components_section_fk',
    }).onDelete('cascade'),
    check(
      'recipe_components_display_sort_order_chk',
      sql`${t.displaySortOrder} >= 0`,
    ),
  ],
);

/**
 * Prep-method sections of a recipe (Recipes 2.0, plan §6.3) — e.g. "Make the
 * dough", "Bake". Structured replacement for the single `recipes.notes` text
 * (which stays as a legacy block until the user edits it, per the backfill).
 *
 * RULE #1: carries `organization_id`, in `businessTables` → standard
 * org_isolation RLS. Composite (org, recipe_id) FK, ON DELETE cascade.
 */
export const recipeMethodSections = pgTable(
  'recipe_method_sections',
  {
    id: id(),
    organizationId: orgId(),
    recipeId: text('recipe_id').notNull(),
    title: text('title').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('recipe_method_sections_org_idx').on(t.organizationId),
    index('recipe_method_sections_org_recipe_sort_idx').on(
      t.organizationId,
      t.recipeId,
      t.sortOrder,
    ),
    unique('recipe_method_sections_org_id_key').on(t.organizationId, t.id),
    check('recipe_method_sections_sort_order_chk', sql`${t.sortOrder} >= 0`),
    foreignKey({
      columns: [t.organizationId, t.recipeId],
      foreignColumns: [recipes.organizationId, recipes.id],
      name: 'recipe_method_sections_recipe_fk',
    }).onDelete('cascade'),
  ],
);

/**
 * Ordered prep steps (Recipes 2.0, plan §6.3). A step belongs to a method
 * section (NULL = the implicit default section) and may carry media via
 * recipe_step_media. Step text is rendered as TEXT — never arbitrary HTML.
 *
 * RULE #1: carries `organization_id`, in `businessTables` → standard
 * org_isolation RLS. Composite FKs: recipe cascade, section cascade.
 */
export const recipeSteps = pgTable(
  'recipe_steps',
  {
    id: id(),
    organizationId: orgId(),
    recipeId: text('recipe_id').notNull(),
    sectionId: text('section_id'),
    instruction: text('instruction').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('recipe_steps_org_idx').on(t.organizationId),
    index('recipe_steps_org_recipe_sort_idx').on(
      t.organizationId,
      t.recipeId,
      t.sortOrder,
    ),
    unique('recipe_steps_org_id_key').on(t.organizationId, t.id),
    check('recipe_steps_sort_order_chk', sql`${t.sortOrder} >= 0`),
    foreignKey({
      columns: [t.organizationId, t.recipeId],
      foreignColumns: [recipes.organizationId, recipes.id],
      name: 'recipe_steps_recipe_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.organizationId, t.sectionId],
      foreignColumns: [
        recipeMethodSections.organizationId,
        recipeMethodSections.id,
      ],
      name: 'recipe_steps_section_fk',
    }).onDelete('cascade'),
  ],
);

/**
 * Media attached to one prep step (Recipes 2.0, plan §6.3). Link table only —
 * the physical object lives in recipe_media and may simultaneously be the
 * recipe cover (no duplication). Steps without media are valid.
 *
 * RULE #1: carries `organization_id`, in `businessTables` → standard
 * org_isolation RLS. Composite FKs, all ON DELETE cascade.
 */
export const recipeStepMedia = pgTable(
  'recipe_step_media',
  {
    id: id(),
    organizationId: orgId(),
    recipeId: text('recipe_id').notNull(),
    stepId: text('step_id').notNull(),
    mediaId: text('media_id').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    caption: text('caption'),
  },
  (t) => [
    index('recipe_step_media_org_idx').on(t.organizationId),
    index('recipe_step_media_org_step_sort_idx').on(
      t.organizationId,
      t.stepId,
      t.sortOrder,
    ),
    // One link per (step, media) pair.
    unique('recipe_step_media_org_step_media_key').on(
      t.organizationId,
      t.stepId,
      t.mediaId,
    ),
    check('recipe_step_media_sort_order_chk', sql`${t.sortOrder} >= 0`),
    foreignKey({
      columns: [t.organizationId, t.recipeId],
      foreignColumns: [recipes.organizationId, recipes.id],
      name: 'recipe_step_media_recipe_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.organizationId, t.stepId],
      foreignColumns: [recipeSteps.organizationId, recipeSteps.id],
      name: 'recipe_step_media_step_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.organizationId, t.mediaId],
      foreignColumns: [recipeMedia.organizationId, recipeMedia.id],
      name: 'recipe_step_media_media_fk',
    }).onDelete('cascade'),
  ],
);

/**
 * Sellable portion options of a recipe (Recipes 2.0, plan §6.8) — drive the
 * food-cost calculator. The `is_default` option gradually replaces the legacy
 * `recipes.selling_price_cents` (dual-read until menus/dashboard/documents
 * migrate); the backfill creates a "Default serving" option carrying the
 * current price. FINANCIAL data (selling price / target food cost) — the
 * kitchen DTO must never include those fields.
 *
 * RULE #1: carries `organization_id`, in `businessTables` → standard
 * org_isolation RLS. Composite (org, recipe_id) FK, ON DELETE cascade.
 */
export const recipePortionOptions = pgTable(
  'recipe_portion_options',
  {
    id: id(),
    organizationId: orgId(),
    recipeId: text('recipe_id').notNull(),
    name: text('name').notNull(),
    quantity: numeric('quantity', {
      precision: 12,
      scale: 4,
      mode: 'number',
    }).notNull(),
    unit: text('unit').notNull(),
    sellingPriceCents: integer('selling_price_cents'),
    targetFoodCostBps: integer('target_food_cost_bps'),
    isDefault: boolean('is_default').notNull().default(false),
    isNutritionServing: boolean('is_nutrition_serving').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('recipe_portion_options_org_idx').on(t.organizationId),
    index('recipe_portion_options_org_recipe_sort_idx').on(
      t.organizationId,
      t.recipeId,
      t.sortOrder,
    ),
    unique('recipe_portion_options_org_id_key').on(t.organizationId, t.id),
    // At most ONE default / one nutrition-serving option per recipe.
    uniqueIndex('recipe_portion_options_one_default_key')
      .on(t.organizationId, t.recipeId)
      .where(sql`${t.isDefault}`),
    uniqueIndex('recipe_portion_options_one_nutrition_key')
      .on(t.organizationId, t.recipeId)
      .where(sql`${t.isNutritionServing}`),
    check('recipe_portion_options_quantity_chk', sql`${t.quantity} > 0`),
    check(
      'recipe_portion_options_price_chk',
      sql`${t.sellingPriceCents} IS NULL OR ${t.sellingPriceCents} >= 0`,
    ),
    check(
      'recipe_portion_options_target_chk',
      sql`${t.targetFoodCostBps} IS NULL OR (${t.targetFoodCostBps} > 0 AND ${t.targetFoodCostBps} <= 10000)`,
    ),
    check('recipe_portion_options_sort_order_chk', sql`${t.sortOrder} >= 0`),
    foreignKey({
      columns: [t.organizationId, t.recipeId],
      foreignColumns: [recipes.organizationId, recipes.id],
      name: 'recipe_portion_options_recipe_fk',
    }).onDelete('cascade'),
  ],
);

/**
 * Allergen tags on an ingredient (Sprint 9). One row per (ingredient, allergen)
 * with a `presence` level (certainty, NOT severity). The recipe rollup derives
 * its allergens from these (lib/calculations/allergens.ts). OPERATIONAL data —
 * not a legal declaration, and kitchen-editable (audited), unlike money.
 *
 * RULE #1: carries `organization_id`, in `businessTables` → standard org_isolation
 * RLS. Two DB CHECKs repeat the catalog (the 14 slugs + 2 presence values) beside
 * the Zod enum. The composite (org, ingredient_id) FK is ON DELETE cascade: tags
 * die with the ingredient on full purge. `unique (org, ingredient_id, allergen)`
 * — one presence per allergen per ingredient.
 */
export const ingredientAllergens = pgTable(
  'ingredient_allergens',
  {
    id: id(),
    organizationId: orgId(),
    ingredientId: text('ingredient_id').notNull(),
    allergen: text('allergen').notNull(),
    presence: text('presence').notNull(),
  },
  (t) => [
    index('ingredient_allergens_org_idx').on(t.organizationId),
    index('ingredient_allergens_org_ingredient_idx').on(
      t.organizationId,
      t.ingredientId,
    ),
    unique('ingredient_allergens_org_ingredient_allergen_key').on(
      t.organizationId,
      t.ingredientId,
      t.allergen,
    ),
    check(
      'ingredient_allergens_allergen_chk',
      sql.raw(`allergen IN (${ALLERGEN_SLUG_SQL_LIST})`),
    ),
    check(
      'ingredient_allergens_presence_chk',
      sql.raw(`presence IN (${PRESENCE_SQL_LIST})`),
    ),
    foreignKey({
      columns: [t.organizationId, t.ingredientId],
      foreignColumns: [ingredients.organizationId, ingredients.id],
      name: 'ingredient_allergens_ingredient_fk',
    }).onDelete('cascade'),
  ],
);

/**
 * Recipe-level allergen overrides (Sprint 9). An override row only ever ADDS or
 * ESCALATES an allergen on a recipe (cross-contamination, a process step) — there
 * is NO "suppress" row. The effective presence is `max(derived, override)` at read
 * time (lib/calculations/allergens.ts); the add/escalate guarantee comes from that
 * `max()` + the action guard (lib/data/allergens.ts), NOT this schema.
 *
 * Same shape/constraints as ingredient_allergens: org-isolated, the two catalog
 * CHECKs, `unique (org, recipe_id, allergen)`, composite (org, recipe_id) FK ON
 * DELETE cascade.
 */
export const recipeAllergenOverrides = pgTable(
  'recipe_allergen_overrides',
  {
    id: id(),
    organizationId: orgId(),
    recipeId: text('recipe_id').notNull(),
    allergen: text('allergen').notNull(),
    presence: text('presence').notNull(),
  },
  (t) => [
    index('recipe_allergen_overrides_org_idx').on(t.organizationId),
    index('recipe_allergen_overrides_org_recipe_idx').on(
      t.organizationId,
      t.recipeId,
    ),
    unique('recipe_allergen_overrides_org_recipe_allergen_key').on(
      t.organizationId,
      t.recipeId,
      t.allergen,
    ),
    check(
      'recipe_allergen_overrides_allergen_chk',
      sql.raw(`allergen IN (${ALLERGEN_SLUG_SQL_LIST})`),
    ),
    check(
      'recipe_allergen_overrides_presence_chk',
      sql.raw(`presence IN (${PRESENCE_SQL_LIST})`),
    ),
    foreignKey({
      columns: [t.organizationId, t.recipeId],
      foreignColumns: [recipes.organizationId, recipes.id],
      name: 'recipe_allergen_overrides_recipe_fk',
    }).onDelete('cascade'),
  ],
);

/**
 * Menus / combos (Sprint 10, module — menu engineering). A menu groups recipes
 * sold together at one `selling_price_cents`. It is a LIVE planning/catalogue
 * artifact, NOT an F3 issued document: its cost is NEVER stored — it derives on
 * read as the sum of each component recipe's current `costPerPortionCents ×
 * quantity` (lib/calculations/menu.ts), so it moves when recipe/ingredient costs
 * move. There is no snapshot.
 *
 * `selling_price_cents` is the only persisted money (manager-only + audited);
 * NULL or 0 means "no price set" → food-cost %, margin and traffic light are
 * undefined (the UI renders `—`). RULE #1: carries `organization_id`, in
 * `businessTables` → standard org_isolation RLS. Soft-delete + 30-day Trash, like
 * recipes. pg_trgm GIN on `name` powers ⌘K. Names are non-unique (like recipes).
 */
export const menus = pgTable(
  'menus',
  {
    id: id(),
    organizationId: orgId(),
    name: text('name').notNull(),
    // Optional selling price per menu, integer cents. NULL/0 = no price → KPIs undefined.
    sellingPriceCents: integer('selling_price_cents'),
    notes: text('notes'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    // Soft-delete: NULL = active. Reads filter `deleted_at IS NULL` (Trash pattern).
    deletedAt: deletedAt(),
  },
  (t) => [
    index('menus_org_idx').on(t.organizationId),
    index('menus_org_name_idx').on(t.organizationId, t.name),
    // Serves the /trash listing and keeps active-row filtering index-friendly.
    index('menus_org_deleted_idx').on(t.organizationId, t.deletedAt),
    // FK target for menu_items' composite (organization_id, menu_id).
    unique('menus_org_id_key').on(t.organizationId, t.id),
    // pg_trgm GIN index for typo-tolerant global search (Sprint 2.7 registry).
    index('menus_name_trgm_idx').using('gin', t.name.op('gin_trgm_ops')),
    // A price, when set, is non-negative (NULL = unset).
    check(
      'menus_selling_price_chk',
      sql`${t.sellingPriceCents} is null or ${t.sellingPriceCents} >= 0`,
    ),
  ],
);

/**
 * Menu line items (Sprint 10). Each line places one recipe in a menu at an integer
 * `quantity` of PORTIONS (1..1000 — e.g. `2 × Fries`). A recipe may appear at most
 * ONCE per menu (unique below); multiples are expressed via quantity, not duplicate
 * rows. Raw ingredients and nested menus are out of scope (D1).
 *
 * The recipe link is ON DELETE restrict: a recipe referenced by any menu cannot be
 * PURGED (the manager removes/replaces the line or purges the menu first — surfaced
 * as `RECIPE_IN_MENU`). A recipe may still be soft-deleted (trashed): the line is
 * kept and the menu's financial calculation becomes `incomplete` (price/margin KPIs
 * withheld) — a trashed component never silently becomes a zero-cost line (D5).
 */
export const menuItems = pgTable(
  'menu_items',
  {
    id: id(),
    organizationId: orgId(),
    menuId: text('menu_id').notNull(),
    recipeId: text('recipe_id').notNull(),
    // Portions of this recipe in the menu (1..1000); multiples, not duplicate rows.
    quantity: integer('quantity').notNull().default(1),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [
    index('menu_items_org_menu_idx').on(t.organizationId, t.menuId),
    index('menu_items_org_recipe_idx').on(t.organizationId, t.recipeId),
    // One row per recipe per menu (multiples go through `quantity`).
    unique('menu_items_org_menu_recipe_key').on(
      t.organizationId,
      t.menuId,
      t.recipeId,
    ),
    check('menu_items_quantity_chk', sql`${t.quantity} between 1 and 1000`),
    check('menu_items_sort_order_chk', sql`${t.sortOrder} >= 0`),
    // Composite FK forces the line to share its menu's organization_id; deleting a
    // menu cascades its lines.
    foreignKey({
      columns: [t.organizationId, t.menuId],
      foreignColumns: [menus.organizationId, menus.id],
      name: 'menu_items_menu_fk',
    }).onDelete('cascade'),
    // Composite FK to the recipe (same-tenant). ON DELETE restrict: a recipe in a
    // menu is purge-blocked (the menu line must be removed first); a soft-delete
    // keeps the line and marks the menu incomplete.
    foreignKey({
      columns: [t.organizationId, t.recipeId],
      foreignColumns: [recipes.organizationId, recipes.id],
      name: 'menu_items_recipe_fk',
    }).onDelete('restrict'),
  ],
);

/**
 * Production plans (Sprint 11a, module — production planning). A production is a
 * batch plan: `recipes × planned portions`. From it the app DERIVES on read the
 * aggregated canonical ingredient requirement (mise-en-place), the on-hand
 * shortfall, and — for managers only — the estimated production cost. NOTHING is
 * stored: no requirement, no cost, no inventory movement. 11a is PLANNING, not
 * posting (completion + frozen snapshots + F1 OUT movements are Sprint 11b).
 *
 * Lifecycle (11a): draft ⇄ planned (both PRE-POST operational states), plus
 * soft-delete + 30-day Trash. `status` is CHECK-constrained to `draft|planned`
 * here; 11b widens it to add `completed|voided`. `planned_for` is a bare calendar
 * date (no tz); it is REQUIRED by the transactional `plan` transition, not by a row
 * CHECK, so an incomplete draft can still be saved. RULE #1: carries
 * `organization_id`, in `businessTables` → standard org_isolation RLS. pg_trgm GIN
 * on `reference` AND `notes` powers ⌘K (D9 searches both). `reference` is optional,
 * NON-UNIQUE free text — never a counter.
 */
export const productions = pgTable(
  'productions',
  {
    id: id(),
    organizationId: orgId(),
    // Optional free-text label (trimmed, max 200 at the action boundary). Not unique.
    reference: text('reference'),
    notes: text('notes'),
    status: text('status', {
      enum: ['draft', 'planned', 'completed', 'voided'],
    })
      .notNull()
      .default('draft'),
    // Bare calendar date ('YYYY-MM-DD', no time, no tz). NULL while an incomplete
    // draft; the `plan` transition requires it.
    plannedFor: date('planned_for', { mode: 'string' }),
    // Completion lifecycle (Sprint 11b). `completed_at` is stamped on
    // planned → completed (also retained through a later void); `voided_at` only on
    // completed → voided. `cost_total_cents` is the FROZEN total cost at completion
    // (manager-only on read — the kitchen DTO never selects it); `stock_moved`
    // freezes the F5 stock-control decision (true = OUT movements were posted, false
    // = financial-only completion dated before the org's stock_control_start_date).
    // All gated by the CHECKs below so an unreachable status/timestamp/cost combo
    // can never exist (11a D8 promised the invariants land with the snapshots).
    completedAt: timestamp('completed_at', { withTimezone: true }),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    costTotalCents: integer('cost_total_cents'),
    stockMoved: boolean('stock_moved').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    // Soft-delete: NULL = active. Reads filter `deleted_at IS NULL` (Trash pattern).
    deletedAt: deletedAt(),
  },
  (t) => [
    index('productions_org_idx').on(t.organizationId),
    // Serves the /trash listing and keeps active-row filtering index-friendly.
    index('productions_org_deleted_idx').on(t.organizationId, t.deletedAt),
    // Serves the list view (status + planned date ordering/filtering).
    index('productions_org_status_planned_idx').on(
      t.organizationId,
      t.status,
      t.plannedFor,
    ),
    // FK target for production_items' composite (organization_id, production_id).
    unique('productions_org_id_key').on(t.organizationId, t.id),
    // pg_trgm GIN indexes for typo-tolerant global search (D9 matches both columns).
    index('productions_reference_trgm_idx').using(
      'gin',
      t.reference.op('gin_trgm_ops'),
    ),
    index('productions_notes_trgm_idx').using('gin', t.notes.op('gin_trgm_ops')),
    // 11b widens the lifecycle to the full DAG and locks every posting invariant in
    // the SAME migration that adds the snapshot tables, so no unreachable
    // status/timestamp/cost combination ever exists.
    check(
      'productions_status_chk',
      sql.raw("status IN ('draft', 'planned', 'completed', 'voided')"),
    ),
    // completed_at present iff terminal (completed/voided); voided_at present iff voided.
    check(
      'productions_completed_at_chk',
      sql.raw("(completed_at IS NOT NULL) = (status IN ('completed', 'voided'))"),
    ),
    check(
      'productions_voided_at_chk',
      sql.raw("(voided_at IS NOT NULL) = (status = 'voided')"),
    ),
    // Frozen cost present iff terminal, and non-negative when present.
    check(
      'productions_cost_total_chk',
      sql.raw(
        "(cost_total_cents IS NOT NULL) = (status IN ('completed', 'voided'))",
      ),
    ),
    check(
      'productions_cost_total_nonneg_chk',
      sql.raw('cost_total_cents IS NULL OR cost_total_cents >= 0'),
    ),
    // stock_moved can only be true once terminal (a draft/planned never posted stock).
    check(
      'productions_stock_moved_chk',
      sql.raw("stock_moved = false OR status IN ('completed', 'voided')"),
    ),
  ],
);

/**
 * Production line items (Sprint 11a). Each line places one recipe in a production at
 * an integer `planned_qty` of PORTIONS (1..100000). A recipe may appear at most ONCE
 * per production (unique below) — D2. Raw ingredients, menus and nested recipes are
 * out of scope (D1).
 *
 * The recipe link is ON DELETE restrict: ANY surviving production_item blocks a
 * recipe PURGE (`RECIPE_IN_PRODUCTION`), regardless of the production's status or
 * Trash state — a deliberate catalogue-integrity rule (D4). A recipe may still be
 * soft-deleted (trashed): the line is kept and the explosion becomes INCOMPLETE — a
 * trashed component never silently becomes a zero requirement/cost (D5).
 */
export const productionItems = pgTable(
  'production_items',
  {
    id: id(),
    organizationId: orgId(),
    productionId: text('production_id').notNull(),
    recipeId: text('recipe_id').notNull(),
    // Portions of this recipe planned (1..100000).
    plannedQty: integer('planned_qty').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [
    index('production_items_org_production_idx').on(
      t.organizationId,
      t.productionId,
    ),
    index('production_items_org_recipe_idx').on(t.organizationId, t.recipeId),
    // One row per recipe per production (multiples go through `planned_qty`).
    unique('production_items_org_production_recipe_key').on(
      t.organizationId,
      t.productionId,
      t.recipeId,
    ),
    check(
      'production_items_planned_qty_chk',
      sql`${t.plannedQty} between 1 and 100000`,
    ),
    check('production_items_sort_order_chk', sql`${t.sortOrder} >= 0`),
    // Composite FK forces the line to share its production's organization_id;
    // deleting a production cascades its lines.
    foreignKey({
      columns: [t.organizationId, t.productionId],
      foreignColumns: [productions.organizationId, productions.id],
      name: 'production_items_production_fk',
    }).onDelete('cascade'),
    // Composite FK to the recipe (same-tenant). ON DELETE restrict: a recipe in any
    // production is purge-blocked (D4); a soft-delete keeps the line and marks the
    // explosion incomplete.
    foreignKey({
      columns: [t.organizationId, t.recipeId],
      foreignColumns: [recipes.organizationId, recipes.id],
      name: 'production_items_recipe_fk',
    }).onDelete('restrict'),
  ],
);

/**
 * Storage areas (Sprint 12c) — named physical locations (walk-in, dry store, bar…)
 * so stock can be seen *where* it sits, not just as an org total. An area is OPERATIONAL
 * config (no money column); the per-area balance is derived from `inventory_movements`
 * filtered by `storage_area_id` (the default area also owns the legacy NULL bucket).
 *
 * One row per org is the IMMUTABLE default ("Main", `is_default=true`): it owns every
 * legacy `storage_area_id IS NULL` movement, so it can be RENAMED but never replaced in
 * v1 (replacing it would reassign the NULL bucket without a ledger movement, review #7).
 * RULE #1: carries `organization_id`, in `businessTables` → standard org_isolation RLS.
 * Soft-delete (`deleted_at`) guarded by the data layer (not default, zero balance, no
 * draft count); committed counts may keep referencing a soft-deleted area for history.
 */
export const storageAreas = pgTable(
  'storage_areas',
  {
    id: id(),
    organizationId: orgId(),
    name: text('name').notNull(),
    // Exactly one immutable default per org (partial unique below). Owns the NULL bucket.
    isDefault: boolean('is_default').notNull().default(false),
    // Manual ordering in the area list. Lower sorts first.
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    // Soft-delete: NULL = active. Reads filter `deleted_at IS NULL`.
    deletedAt: deletedAt(),
  },
  (t) => [
    index('storage_areas_org_idx').on(t.organizationId),
    index('storage_areas_org_sort_idx').on(t.organizationId, t.sortOrder),
    // FK target for the composite (organization_id, storage_area_id) references on
    // inventory_movements + stock_counts.
    unique('storage_areas_org_id_key').on(t.organizationId, t.id),
    // One active area name per org (case-insensitive; trashed names free up).
    uniqueIndex('storage_areas_org_name_active_key')
      .on(t.organizationId, sql`lower(${t.name})`)
      .where(sql`${t.deletedAt} is null`),
    // At most one active default area per org.
    uniqueIndex('storage_areas_org_default_key')
      .on(t.organizationId)
      .where(sql`${t.isDefault} and ${t.deletedAt} is null`),
    check(
      'storage_areas_name_chk',
      sql`char_length(btrim(${t.name})) between 1 and 80`,
    ),
    check('storage_areas_sort_order_chk', sql`${t.sortOrder} >= 0`),
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
    // Physical location this movement landed in (Sprint 12c). NULL = the legacy
    // default bucket, which the immutable default area also owns (so sales/production
    // keep posting NULL and still reconcile). Part of the F1 immutable payload.
    storageAreaId: text('storage_area_id'),
    createdAt: createdAt(),
  },
  (t) => [
    index('inventory_movements_org_idx').on(t.organizationId),
    index('inventory_movements_org_ingredient_idx').on(
      t.organizationId,
      t.ingredientId,
    ),
    // Per-area balance query: SUM(delta) GROUP BY ingredient filtered by area (Sprint 12c).
    index('inventory_movements_org_area_ingredient_idx').on(
      t.organizationId,
      t.storageAreaId,
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
    // Same-org area link (Sprint 12c). ON DELETE restrict: an area with movements
    // cannot be hard-deleted (the data layer soft-deletes instead). NULL rows skip
    // the FK (MATCH SIMPLE) — legacy/default-bucket movements.
    foreignKey({
      columns: [t.organizationId, t.storageAreaId],
      foreignColumns: [storageAreas.organizationId, storageAreas.id],
      name: 'inventory_movements_storage_area_fk',
    }).onDelete('restrict'),
  ],
);

/**
 * Physical counts (Sprint 12c). A count records what is actually on the shelf in one
 * storage area, then COMMITS the difference vs the live ledger as F1 `adjustment`
 * movements — so the authoritative ledger matches reality without ever editing a
 * movement. Lifecycle: `draft` (editable line entries) → `committed` (posts the
 * adjustments, immutable thereafter; a correction is a NEW count, no void in v1).
 *
 * MONEY-FREE (kitchen + manager may start/commit). `storage_area_id` NULL is accepted
 * as the default-area alias (the UI writes the concrete default id). Committed counts
 * are permanent history (like production_consumptions). RULE #1: carries
 * `organization_id`, in `businessTables` → standard org_isolation RLS.
 */
export const stockCounts = pgTable(
  'stock_counts',
  {
    id: id(),
    organizationId: orgId(),
    // The counted area; NULL accepted as the default-area alias (recommended UI writes defaultId).
    storageAreaId: text('storage_area_id'),
    status: text('status', { enum: ['draft', 'committed'] })
      .notNull()
      .default('draft'),
    note: text('note'),
    // Actor user id who started the count (provenance only).
    createdBy: text('created_by'),
    committedAt: timestamp('committed_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('stock_counts_org_idx').on(t.organizationId),
    index('stock_counts_org_status_idx').on(t.organizationId, t.status),
    index('stock_counts_org_area_idx').on(t.organizationId, t.storageAreaId),
    // FK target for stock_count_items' composite (organization_id, stock_count_id).
    unique('stock_counts_org_id_key').on(t.organizationId, t.id),
    check('stock_counts_status_chk', sql.raw("status IN ('draft', 'committed')")),
    // committed_at present iff committed.
    check(
      'stock_counts_committed_at_chk',
      sql`(${t.committedAt} is not null) = (${t.status} = 'committed')`,
    ),
    // Same-org area (NULL skips the FK = default alias). ON DELETE restrict: a draft
    // count pins its area from hard delete; the data layer soft-deletes areas anyway.
    foreignKey({
      columns: [t.organizationId, t.storageAreaId],
      foreignColumns: [storageAreas.organizationId, storageAreas.id],
      name: 'stock_counts_storage_area_fk',
    }).onDelete('restrict'),
  ],
);

/**
 * Physical-count line items (Sprint 12c). One row per counted ingredient in a count.
 * `counted_canonical` is what the counter entered (≥ 0); `system_canonical` is the live
 * per-area balance snapshot taken AT COMMIT under lock (NULL while draft); `movement_id`
 * is the provenance id of the F1 `adjustment` posted for the non-zero delta (NULL when
 * the delta was zero, or while draft).
 *
 * `ingredient_id` is provenance only — NO live FK to `ingredients` (mirrors
 * production_consumptions): an ingredient purge cascades its movements, while count
 * items remain as historical records. RULE #1: in `businessTables` → org_isolation RLS.
 */
export const stockCountItems = pgTable(
  'stock_count_items',
  {
    id: id(),
    organizationId: orgId(),
    stockCountId: text('stock_count_id').notNull(),
    // Provenance only (no live FK) — mirrors production_consumptions.
    ingredientId: text('ingredient_id').notNull(),
    countedCanonical: numeric('counted_canonical', { precision: 12, scale: 2 }).notNull(),
    systemCanonical: numeric('system_canonical', { precision: 12, scale: 2 }),
    // The F1 adjustment posted for this line; NULL when delta was 0 (or still draft).
    movementId: text('movement_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('stock_count_items_org_count_idx').on(t.organizationId, t.stockCountId),
    index('stock_count_items_org_movement_idx').on(t.organizationId, t.movementId),
    // One row per ingredient per count.
    unique('stock_count_items_org_count_ingredient_key').on(
      t.organizationId,
      t.stockCountId,
      t.ingredientId,
    ),
    check('stock_count_items_counted_chk', sql`${t.countedCanonical} >= 0`),
    // Same-org line; cascades when the count is deleted (drafts hard-delete).
    foreignKey({
      columns: [t.organizationId, t.stockCountId],
      foreignColumns: [stockCounts.organizationId, stockCounts.id],
      name: 'stock_count_items_count_fk',
    }).onDelete('cascade'),
  ],
);

/**
 * Frozen per-recipe-line cost snapshot of a COMPLETED production (Sprint 11b). One
 * immutable row per production line, written once inside the completing transaction
 * from the live `recipeCost`/`componentCost` at that moment — never updated again, so
 * a later recipe rename/retrash/price change can NEVER move a completed document.
 *
 * `recipe_name` is the historical render source; `recipe_id` is provenance only (NO FK
 * to live `recipes`). The cost columns are MANAGER-ONLY on read — the kitchen
 * completed-DTO projection omits them by key absence (F4). RULE #1: carries
 * `organization_id`, in `businessTables` → standard org_isolation RLS. Immutability is
 * enforced by the data layer never UPDATE-ing these rows, NOT by an append-only policy.
 */
export const productionRecipeSnapshots = pgTable(
  'production_recipe_snapshots',
  {
    id: id(),
    organizationId: orgId(),
    productionId: text('production_id').notNull(),
    // Provenance (no live FK) + frozen render name.
    recipeId: text('recipe_id').notNull(),
    recipeName: text('recipe_name').notNull(),
    // Portions completed for this recipe line (same domain as production_items).
    plannedQty: integer('planned_qty').notNull(),
    // Frozen money (manager-only on read): per-portion cost + line total at completion.
    costPerPortionCents: integer('cost_per_portion_cents').notNull(),
    lineCostCents: integer('line_cost_cents').notNull(),
  },
  (t) => [
    index('production_recipe_snapshots_org_production_idx').on(
      t.organizationId,
      t.productionId,
    ),
    check(
      'production_recipe_snapshots_planned_qty_chk',
      sql`${t.plannedQty} between 1 and 100000`,
    ),
    check(
      'production_recipe_snapshots_cost_chk',
      sql`${t.costPerPortionCents} >= 0 and ${t.lineCostCents} >= 0`,
    ),
    // Same-org line; cascades when the production is purged (drafts/planned only).
    foreignKey({
      columns: [t.organizationId, t.productionId],
      foreignColumns: [productions.organizationId, productions.id],
      name: 'production_recipe_snapshots_production_fk',
    }).onDelete('cascade'),
  ],
);

/**
 * Frozen per-ingredient consumption snapshot of a COMPLETED production (Sprint 11b).
 * One immutable row per consumed ingredient — the aggregated requirement at
 * completion. `qty_canonical` is the kitchen-visible mise-en-place readout;
 * `movement_id` links the F1 OUT movement posted for this ingredient (NULL for a
 * financial-only completion dated before stock control, D4).
 *
 * `ingredient_name`/`dimension` are the historical render source; `ingredient_id` is
 * provenance only (NO FK to live `ingredients`). A ledger-posting completion pins the
 * live ingredient through the D6 purge guard; a financial-only snapshot stays readable
 * even if the ingredient is later purged. RULE #1: in `businessTables` → org_isolation
 * RLS. Immutability is enforced by the data layer, not an append-only policy.
 */
export const productionConsumptions = pgTable(
  'production_consumptions',
  {
    id: id(),
    organizationId: orgId(),
    productionId: text('production_id').notNull(),
    // Provenance (no live FK) + frozen render fields.
    ingredientId: text('ingredient_id').notNull(),
    ingredientName: text('ingredient_name').notNull(),
    dimension: text('dimension', {
      enum: ['weight', 'volume', 'count'],
    }).notNull(),
    // Frozen canonical requirement (g / ml / count) — kitchen-visible.
    qtyCanonical: numeric('qty_canonical', { precision: 12, scale: 2 }).notNull(),
    // The F1 OUT movement posted for this ingredient; NULL when stock_moved=false (D4).
    movementId: text('movement_id'),
  },
  (t) => [
    index('production_consumptions_org_production_idx').on(
      t.organizationId,
      t.productionId,
    ),
    // One consumption row per ingredient per production (aggregated, D5).
    unique('production_consumptions_org_production_ingredient_key').on(
      t.organizationId,
      t.productionId,
      t.ingredientId,
    ),
    // One consumption row owns at most one posted OUT movement. Partial so the many
    // financial-only (movement_id NULL) rows don't collide.
    uniqueIndex('production_consumptions_org_movement_key')
      .on(t.organizationId, t.movementId)
      .where(sql`${t.movementId} is not null`),
    check('production_consumptions_qty_chk', sql`${t.qtyCanonical} > 0`),
    // Same-org line; cascades when the production is purged (drafts/planned only).
    foreignKey({
      columns: [t.organizationId, t.productionId],
      foreignColumns: [productions.organizationId, productions.id],
      name: 'production_consumptions_production_fk',
    }).onDelete('cascade'),
    // Nullable composite FK to the posted movement (same-org). ON DELETE restrict so a
    // posted OUT movement can't vanish while a completed snapshot points at it; the D6
    // purge guard keeps the ingredient (and thus its movements) from being purged.
    // NULL movement_id rows skip the FK (MATCH SIMPLE) — financial-only completions.
    foreignKey({
      columns: [t.organizationId, t.movementId],
      foreignColumns: [inventoryMovements.organizationId, inventoryMovements.id],
      name: 'production_consumptions_movement_fk',
    }).onDelete('restrict'),
  ],
);

/**
 * Daily-close Sales (Sprint 12a, module — sales). A `sale` is a per-day total of
 * what was sold: a manager builds a draft of line items (a recipe / menu /
 * ingredient sold at `units × net unit price`, with tax) then POSTS the close.
 * Posting projects the sale into ONE protected `income` transaction (the F5
 * `postSaleTransaction` primitive — gross total, `daily_sales` category) AND, when
 * the sale date is on/after the org's `stock_control_start_date`, writes idempotent
 * F1 OUT movements consuming the ingredients behind the sold items. VOIDing a posted
 * close soft-deletes that income row (F5) and reverses the movements (F1).
 *
 * Lifecycle: draft → posted → void (void is terminal; the row is RETAINED as
 * permanent history). A draft is editable + HARD-deletable (no Trash — nothing
 * financial is at stake yet, so there is NO `deleted_at`); posted/void are immutable.
 *
 * Sales are FINANCIAL → manager-only (F4: kitchen has no access). The money columns
 * are FROZEN on post (NULL while draft) and computed via lib/calculations/tax.ts
 * (single exclusive org rate, per-line-then-sum). RULE #1: carries `organization_id`,
 * in `businessTables` → standard org_isolation RLS.
 */
export const sales = pgTable(
  'sales',
  {
    id: id(),
    organizationId: orgId(),
    // The close date AND the reference. Bare 'YYYY-MM-DD' (no time, no tz) — the
    // posted income transaction's `occurred_on` is exactly this.
    saleDate: date('sale_date', { mode: 'string' }).notNull(),
    status: text('status', { enum: ['draft', 'posted', 'void'] })
      .notNull()
      .default('draft'),
    // Frozen sale totals (integer cents), set ONLY on post (NULL while draft). The
    // CHECKs below freeze the presence/sign/sum invariants so an unreachable combo
    // can never exist; gross = net + tax (no re-round — sum of rounded line figures).
    netCents: integer('net_cents'),
    taxCents: integer('tax_cents'),
    grossCents: integer('gross_cents'),
    // Lifecycle timestamps: posted_at present once terminal (posted/void); voided_at
    // present only on void.
    postedAt: timestamp('posted_at', { withTimezone: true }),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    // Freezes the F5 stock-control decision at post time (true = OUT movements were
    // posted, false = financial-only close dated before stock_control_start_date).
    stockMoved: boolean('stock_moved').notNull().default(false),
    note: text('note'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    // NO deleted_at: drafts are hard-deleted; posted/void are permanent history.
  },
  (t) => [
    index('sales_org_idx').on(t.organizationId),
    index('sales_org_date_idx').on(t.organizationId, t.saleDate),
    // Serves the list view (status + date ordering/filtering).
    index('sales_org_status_date_idx').on(t.organizationId, t.status, t.saleDate),
    // FK target for sale_items' composite (organization_id, sale_id).
    unique('sales_org_id_key').on(t.organizationId, t.id),
    // At most ONE non-void close per date (D3): correcting a day = void the old one
    // (retained) then create a new draft. A draft + a posted can't coexist for a date.
    uniqueIndex('sales_org_date_active_key')
      .on(t.organizationId, t.saleDate)
      .where(sql`${t.status} <> 'void'`),
    check('sales_status_chk', sql.raw("status IN ('draft', 'posted', 'void')")),
    // Money present iff terminal (posted/void); absent while draft.
    check(
      'sales_money_presence_chk',
      sql`(${t.netCents} is not null) = (${t.status} in ('posted', 'void'))
        and (${t.taxCents} is not null) = (${t.status} in ('posted', 'void'))
        and (${t.grossCents} is not null) = (${t.status} in ('posted', 'void'))`,
    ),
    // Non-negative when present.
    check(
      'sales_money_nonneg_chk',
      sql`${t.netCents} is null
        or (${t.netCents} >= 0 and ${t.taxCents} >= 0 and ${t.grossCents} >= 0)`,
    ),
    // gross = net + tax when present (the rounded per-line figures, summed).
    check(
      'sales_money_sum_chk',
      sql`${t.grossCents} is null or ${t.grossCents} = ${t.netCents} + ${t.taxCents}`,
    ),
    // posted_at present iff terminal; voided_at present iff void.
    check(
      'sales_posted_at_chk',
      sql`(${t.postedAt} is not null) = (${t.status} in ('posted', 'void'))`,
    ),
    check(
      'sales_voided_at_chk',
      sql`(${t.voidedAt} is not null) = (${t.status} = 'void')`,
    ),
    // stock_moved can only be true once terminal (a draft never posted stock).
    check(
      'sales_stock_moved_chk',
      sql`${t.stockMoved} = false or ${t.status} in ('posted', 'void')`,
    ),
  ],
);

/**
 * Sale line items (Sprint 12a). Each line sells exactly ONE catalogue item — a
 * recipe, a menu, or a raw ingredient — discriminated by `item_kind` with exactly
 * the one matching nullable composite FK set (CHECK below). `item_name` is a FROZEN
 * snapshot (re-frozen from the locked source row on post) so a later rename/trash
 * never rewrites a posted close.
 *
 * `quantity` = units sold (integer ≥ 1). For an INGREDIENT line,
 * `ingredient_qty_canonical` states the canonical stock amount (g/ml/count) consumed
 * PER sold unit (so direct consumption = quantity × ingredient_qty_canonical) —
 * required + positive for ingredient lines, NULL for recipe/menu lines (which explode
 * to ingredients on post). `unit_net_cents`/`tax_rate_bps` are the net price + rate
 * per sold unit; `net/tax/gross_cents` are the line totals (live preview on a draft,
 * re-frozen on post). The catalogue FKs are ON DELETE restrict — a sale line pins its
 * item while it exists (surfaced through the purge guards before any side effect).
 */
export const saleItems = pgTable(
  'sale_items',
  {
    id: id(),
    organizationId: orgId(),
    saleId: text('sale_id').notNull(),
    itemKind: text('item_kind', {
      enum: ['recipe', 'menu', 'ingredient'],
    }).notNull(),
    // Exactly the one ref implied by item_kind is set (CHECK below).
    itemRecipeId: text('item_recipe_id'),
    itemMenuId: text('item_menu_id'),
    itemIngredientId: text('item_ingredient_id'),
    // Frozen render name (re-frozen from the locked source row on post).
    itemName: text('item_name').notNull(),
    // Units sold (1..100000).
    quantity: integer('quantity').notNull(),
    // Canonical stock consumed per sold unit — required/positive iff ingredient line.
    ingredientQtyCanonical: numeric('ingredient_qty_canonical', {
      precision: 12,
      scale: 2,
    }),
    // Net price per sold unit + per-line tax rate (basis points, 0..10000).
    unitNetCents: integer('unit_net_cents').notNull(),
    taxRateBps: integer('tax_rate_bps').notNull(),
    // Line totals: live preview on a draft, re-frozen on post. net = quantity ×
    // unit_net_cents; gross = net + tax (tax independently rounded, see tax.ts).
    netCents: integer('net_cents').notNull(),
    taxCents: integer('tax_cents').notNull(),
    grossCents: integer('gross_cents').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [
    index('sale_items_org_sale_idx').on(t.organizationId, t.saleId),
    index('sale_items_org_recipe_idx').on(t.organizationId, t.itemRecipeId),
    index('sale_items_org_menu_idx').on(t.organizationId, t.itemMenuId),
    index('sale_items_org_ingredient_idx').on(t.organizationId, t.itemIngredientId),
    check('sale_items_item_kind_chk', sql.raw("item_kind IN ('recipe', 'menu', 'ingredient')")),
    check('sale_items_quantity_chk', sql`${t.quantity} between 1 and 100000`),
    check('sale_items_unit_net_chk', sql`${t.unitNetCents} >= 0`),
    check('sale_items_tax_rate_chk', sql`${t.taxRateBps} between 0 and 10000`),
    check('sale_items_sort_order_chk', sql`${t.sortOrder} >= 0`),
    // Line money: non-negative, net = quantity × unit_net, gross = net + tax.
    check(
      'sale_items_money_chk',
      sql`${t.netCents} >= 0 and ${t.taxCents} >= 0 and ${t.grossCents} >= 0
        and ${t.netCents} = ${t.quantity} * ${t.unitNetCents}
        and ${t.grossCents} = ${t.netCents} + ${t.taxCents}`,
    ),
    // Source shape: exactly the one ref implied by item_kind is set, the others NULL;
    // ingredient_qty_canonical is non-null/positive ONLY for ingredient lines.
    check(
      'sale_items_source_shape_chk',
      sql`(
        (${t.itemKind} = 'recipe' and ${t.itemRecipeId} is not null and ${t.itemMenuId} is null and ${t.itemIngredientId} is null and ${t.ingredientQtyCanonical} is null)
        or (${t.itemKind} = 'menu' and ${t.itemMenuId} is not null and ${t.itemRecipeId} is null and ${t.itemIngredientId} is null and ${t.ingredientQtyCanonical} is null)
        or (${t.itemKind} = 'ingredient' and ${t.itemIngredientId} is not null and ${t.itemRecipeId} is null and ${t.itemMenuId} is null and ${t.ingredientQtyCanonical} is not null and ${t.ingredientQtyCanonical} > 0)
      )`,
    ),
    // Composite FK forces the line to share its sale's organization_id; deleting a
    // sale cascades its lines.
    foreignKey({
      columns: [t.organizationId, t.saleId],
      foreignColumns: [sales.organizationId, sales.id],
      name: 'sale_items_sale_fk',
    }).onDelete('cascade'),
    // Composite catalogue FKs (same-tenant). ON DELETE restrict: a sale line pins its
    // recipe/menu/ingredient (the purge guards surface this first). NULL rows skip the
    // FK (MATCH SIMPLE) — only the one ref matching item_kind is set.
    foreignKey({
      columns: [t.organizationId, t.itemRecipeId],
      foreignColumns: [recipes.organizationId, recipes.id],
      name: 'sale_items_recipe_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.organizationId, t.itemMenuId],
      foreignColumns: [menus.organizationId, menus.id],
      name: 'sale_items_menu_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.organizationId, t.itemIngredientId],
      foreignColumns: [ingredients.organizationId, ingredients.id],
      name: 'sale_items_ingredient_fk',
    }).onDelete('restrict'),
  ],
);

/**
 * Kitchen task lists (Sprint 6, module — kitchen operations). A named, optionally
 * dated container ("Saturday prep", "Opening", "Closing") for operational tasks. It
 * is OPERATIONAL + money-free end-to-end — no cost/price column, no entitlement
 * gate. A list is the recoverable Trash unit (soft-delete + 30-day Trash, like
 * recipes/menus); purging a trashed list cascades its tasks.
 *
 * RULE #1: carries `organization_id`, in `businessTables` → standard org_isolation
 * RLS. pg_trgm GIN on `name` powers ⌘K (money-free, both roles). `scheduled_for` is
 * a bare calendar date (no time, no tz) that drives the Today/Upcoming/No-date
 * grouping on /tasks (Sprint 6 D5).
 */
export const taskLists = pgTable(
  'task_lists',
  {
    id: id(),
    organizationId: orgId(),
    name: text('name').notNull(),
    notes: text('notes'),
    // Bare calendar date ('YYYY-MM-DD', no time, no tz). NULL = no date.
    scheduledFor: date('scheduled_for', { mode: 'string' }),
    // Manual ordering of the list rail. Lower sorts first.
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    // Soft-delete: NULL = active. Reads filter `deleted_at IS NULL` (Trash pattern).
    deletedAt: deletedAt(),
  },
  (t) => [
    index('task_lists_org_idx').on(t.organizationId),
    // Serves the /trash listing and keeps active-row filtering index-friendly.
    index('task_lists_org_deleted_idx').on(t.organizationId, t.deletedAt),
    // Serves the Today/Upcoming grouping order on /tasks.
    index('task_lists_org_scheduled_idx').on(t.organizationId, t.scheduledFor),
    // FK target for tasks' composite (organization_id, task_list_id).
    unique('task_lists_org_id_key').on(t.organizationId, t.id),
    // pg_trgm GIN index for typo-tolerant global search (Sprint 2.7 registry).
    index('task_lists_name_trgm_idx').using('gin', t.name.op('gin_trgm_ops')),
    // Trimmed name 1..200; notes (when present) ≤1000.
    check(
      'task_lists_name_chk',
      sql`char_length(btrim(${t.name})) between 1 and 200`,
    ),
    check(
      'task_lists_notes_chk',
      sql`${t.notes} is null or char_length(${t.notes}) <= 1000`,
    ),
    check('task_lists_sort_order_chk', sql`${t.sortOrder} >= 0`),
  ],
);

/**
 * Tasks within a list (Sprint 6). A title, optional notes/station, an optional
 * assignee + due date, and an open/done status with completion provenance. A task
 * always belongs to exactly one list (composite cascade FK). Money-free.
 *
 * A task may be ANCHORED to real data (the differentiator over a generic to-do):
 *   - `source_kind = 'prep'` → links a recipe (`source_recipe_id`);
 *   - `source_kind = 'reorder'` → links a low-stock ingredient (`source_ingredient_id`);
 *   - `source_kind = 'manual'` → no link (plain text).
 * Both links are NULLABLE composite FKs `ON DELETE restrict` — a purge of the
 * referenced recipe/ingredient NULLs the matching column FIRST (the task survives as
 * plain text), exactly the `transactions.recipe_id` precedent (lib/data/trash.ts).
 *
 * Individual task rows are HARD-deleted from an active list (not trashed) — the
 * recoverable Trash unit is the list. RULE #1: in `businessTables` → org_isolation
 * RLS. `assignee_user_id` is a Clerk org-member id with NO DB FK (Clerk is the
 * source of truth; the action validates membership before writing).
 */
export const tasks = pgTable(
  'tasks',
  {
    id: id(),
    organizationId: orgId(),
    taskListId: text('task_list_id').notNull(),
    title: text('title').notNull(),
    notes: text('notes'),
    // Free-text station tag (e.g. "grill", "pastry"); ≤60 chars. NULL = none.
    station: text('station'),
    status: text('status', { enum: ['open', 'done'] }).notNull().default('open'),
    // Clerk org-member id (D2); no DB FK — Clerk owns identity. NULL = unassigned.
    assigneeUserId: text('assignee_user_id'),
    // Bare calendar date ('YYYY-MM-DD', no time, no tz). NULL = no due date.
    dueOn: date('due_on', { mode: 'string' }),
    // Completion provenance — both set iff `done` (CHECK below), cleared on reopen.
    completedAt: timestamp('completed_at', { withTimezone: true }),
    completedBy: text('completed_by'),
    // Data anchor discriminator: manual = no link, prep = recipe, reorder = ingredient.
    sourceKind: text('source_kind', {
      enum: ['manual', 'prep', 'reorder'],
    })
      .notNull()
      .default('manual'),
    sourceRecipeId: text('source_recipe_id'),
    sourceIngredientId: text('source_ingredient_id'),
    // Manual ordering within the list. Lower sorts first.
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('tasks_org_task_list_idx').on(t.organizationId, t.taskListId),
    index('tasks_org_assignee_idx').on(t.organizationId, t.assigneeUserId),
    index('tasks_org_source_recipe_idx').on(t.organizationId, t.sourceRecipeId),
    index('tasks_org_source_ingredient_idx').on(
      t.organizationId,
      t.sourceIngredientId,
    ),
    // Trimmed title 1..200; notes ≤1000; station ≤60.
    check(
      'tasks_title_chk',
      sql`char_length(btrim(${t.title})) between 1 and 200`,
    ),
    check(
      'tasks_notes_chk',
      sql`${t.notes} is null or char_length(${t.notes}) <= 1000`,
    ),
    check(
      'tasks_station_chk',
      sql`${t.station} is null or char_length(${t.station}) <= 60`,
    ),
    check('tasks_status_chk', sql.raw("status IN ('open', 'done')")),
    check('tasks_sort_order_chk', sql`${t.sortOrder} >= 0`),
    // completed_at / completed_by present iff status = 'done'.
    check(
      'tasks_completed_at_chk',
      sql`(${t.completedAt} is not null) = (${t.status} = 'done')`,
    ),
    check(
      'tasks_completed_by_chk',
      sql`(${t.completedBy} is not null) = (${t.status} = 'done')`,
    ),
    // The source discriminator is consistent with which link is set:
    //   manual  ⇔ both NULL; prep ⇔ recipe only; reorder ⇔ ingredient only.
    check(
      'tasks_source_kind_chk',
      sql.raw("source_kind IN ('manual', 'prep', 'reorder')"),
    ),
    check(
      'tasks_source_shape_chk',
      sql`(
        (${t.sourceKind} = 'manual' and ${t.sourceRecipeId} is null and ${t.sourceIngredientId} is null)
        or (${t.sourceKind} = 'prep' and ${t.sourceRecipeId} is not null and ${t.sourceIngredientId} is null)
        or (${t.sourceKind} = 'reorder' and ${t.sourceRecipeId} is null and ${t.sourceIngredientId} is not null)
      )`,
    ),
    // Composite FK forces the task to share its list's organization_id; deleting a
    // list cascades its tasks (the list is the Trash unit).
    foreignKey({
      columns: [t.organizationId, t.taskListId],
      foreignColumns: [taskLists.organizationId, taskLists.id],
      name: 'tasks_task_list_fk',
    }).onDelete('cascade'),
    // Composite FKs to the data anchors (same-tenant). ON DELETE restrict: the purge
    // paths NULL the matching link FIRST (no orphan, no blocked purge). NULL rows
    // skip the FK (MATCH SIMPLE).
    foreignKey({
      columns: [t.organizationId, t.sourceRecipeId],
      foreignColumns: [recipes.organizationId, recipes.id],
      name: 'tasks_source_recipe_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.organizationId, t.sourceIngredientId],
      foreignColumns: [ingredients.organizationId, ingredients.id],
      name: 'tasks_source_ingredient_fk',
    }).onDelete('restrict'),
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
    // Provenance (Sprint 7): which ingredient_suppliers link/quote produced this
    // observation, so the price trail can name the supplier. Nullable + NO FK: a
    // multi-column composite SET-NULL would also null the NOT NULL organization_id
    // (PG can't emit the column-subset form), and this is provenance only — same
    // precedent as inventory_movements.source_id. Indexed for the per-link lookup.
    ingredientSupplierId: text('ingredient_supplier_id'),
    // Provenance (Sprint 8b): the receipt line that produced this observation, so a
    // receipt void can find "the pending value that came from this receipt" and
    // recompute it. Nullable + NO FK (provenance only — same precedent as
    // `ingredient_supplier_id`). Indexed for the per-receipt-item lookup.
    sourceReceiptItemId: text('source_receipt_item_id'),
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => [
    index('ingredient_price_history_org_idx').on(t.organizationId),
    // Per-receipt-item provenance lookup (void → recompute pending).
    index('ingredient_price_history_org_receipt_item_idx').on(
      t.organizationId,
      t.sourceReceiptItemId,
    ),
    // History view: newest-first per ingredient.
    index('ingredient_price_history_org_ingredient_idx').on(
      t.organizationId,
      t.ingredientId,
      t.createdAt,
    ),
    // Per-link provenance lookup (which quotes came from a given supplier link).
    index('ingredient_price_history_org_supplier_idx').on(
      t.organizationId,
      t.ingredientSupplierId,
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
 * Suppliers (Sprint 7, module 11). A real, MANAGER-ONLY entity that replaces the
 * free-text `ingredients.supplier` column during a dual-write transition window
 * (docs/supplier-transition-contract.md). Archive, not Trash: `active = false`
 * deactivates a supplier (like `employees`) — there is no shared 30-day trash and
 * no `deleted_at`.
 *
 * `normalized_name` is the F6 dedup key (lib/suppliers/normalize.ts), written by
 * the app at write time (SQL never re-derives it) and made unique per org so two
 * spellings of one supplier can't coexist. RULE #1: carries `organization_id`, in
 * `businessTables` → standard org_isolation RLS. pg_trgm GIN on `name` powers ⌘K
 * (mirrors `customers`). Contact fields are PII-adjacent and never logged/audited.
 */
export const suppliers = pgTable(
  'suppliers',
  {
    id: id(),
    organizationId: orgId(),
    name: text('name').notNull(),
    // F6 dedup key — lower/trim/whitespace-collapsed, written by the app layer.
    normalizedName: text('normalized_name').notNull(),
    email: text('email'),
    phone: text('phone'),
    address: text('address'),
    taxId: text('tax_id'),
    notes: text('notes'),
    // Archive flag: false = deactivated (kept for history/links), true = active.
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('suppliers_org_idx').on(t.organizationId),
    index('suppliers_org_active_idx').on(t.organizationId, t.active),
    // F6 dedup key: one supplier per normalized name per org (write-path conflict
    // target for the atomic find-or-create).
    unique('suppliers_org_normalized_name_key').on(
      t.organizationId,
      t.normalizedName,
    ),
    // FK target for ingredient_suppliers' composite (organization_id, supplier_id).
    unique('suppliers_org_id_key').on(t.organizationId, t.id),
    // pg_trgm GIN index for typo-tolerant global search (Sprint 2.7 registry).
    index('suppliers_name_trgm_idx').using('gin', t.name.op('gin_trgm_ops')),
  ],
);

/**
 * Ingredient ⇄ supplier link (Sprint 7). Carries the purchase PACK an ingredient
 * is bought in from a supplier (size + unit + pack price), from which the per-unit
 * cost is derived (lib/calculations/purchasePrice.ts). The schema supports MANY
 * suppliers per ingredient, but v1 exposes only ONE default per ingredient
 * (`is_default`); the multi-supplier UI is Sprint 8.
 *
 * Setting/updating the DEFAULT link's pack price raises `ingredients.pending_price_
 * cents` (a quote observation) for a manager to accept — `price_cents` is never
 * mutated silently (Sprint F2). RULE #1: carries `organization_id`, in
 * `businessTables` → org_isolation RLS.
 */
export const ingredientSuppliers = pgTable(
  'ingredient_suppliers',
  {
    id: id(),
    organizationId: orgId(),
    ingredientId: text('ingredient_id').notNull(),
    supplierId: text('supplier_id').notNull(),
    // The purchase pack: size in `pack_unit` (e.g. 5 + 'kg'), price of the whole
    // pack in integer cents. All nullable — a link can exist before a price is known.
    packSize: numeric('pack_size', { precision: 12, scale: 2 }),
    packUnit: text('pack_unit'),
    packPriceCents: integer('pack_price_cents'),
    // Exactly one default link per ingredient (partial unique below). The default's
    // supplier name mirrors into the legacy `ingredients.supplier` column.
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('ingredient_suppliers_org_idx').on(t.organizationId),
    index('ingredient_suppliers_org_ingredient_idx').on(
      t.organizationId,
      t.ingredientId,
    ),
    index('ingredient_suppliers_org_supplier_idx').on(
      t.organizationId,
      t.supplierId,
    ),
    // One link per (ingredient, supplier) pair.
    unique('ingredient_suppliers_org_ingredient_supplier_key').on(
      t.organizationId,
      t.ingredientId,
      t.supplierId,
    ),
    // FK target for ingredient_price_history provenance (org, id).
    unique('ingredient_suppliers_org_id_key').on(t.organizationId, t.id),
    // At most ONE default link per ingredient. Partial so the many non-default
    // rows don't collide.
    uniqueIndex('ingredient_suppliers_org_ingredient_default_key')
      .on(t.organizationId, t.ingredientId)
      .where(sql`${t.isDefault}`),
    // Pack integrity (§12.8): positive size, non-negative price, and a price only
    // when both size and unit are present (otherwise the per-unit cost is undefined).
    check(
      'ingredient_suppliers_pack_size_chk',
      sql`${t.packSize} is null or ${t.packSize} > 0`,
    ),
    check(
      'ingredient_suppliers_pack_price_chk',
      sql`${t.packPriceCents} is null or ${t.packPriceCents} >= 0`,
    ),
    check(
      'ingredient_suppliers_price_requires_pack_chk',
      sql`${t.packPriceCents} is null or (${t.packSize} is not null and ${t.packUnit} is not null)`,
    ),
    // Composite FKs force same-org links. ingredient → cascade (links die with the
    // ingredient on purge); supplier → restrict (a supplier in use can't be deleted —
    // suppliers are archived, never hard-deleted, so this never blocks in practice).
    foreignKey({
      columns: [t.organizationId, t.ingredientId],
      foreignColumns: [ingredients.organizationId, ingredients.id],
      name: 'ingredient_suppliers_ingredient_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.organizationId, t.supplierId],
      foreignColumns: [suppliers.organizationId, suppliers.id],
      name: 'ingredient_suppliers_supplier_fk',
    }).onDelete('restrict'),
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
 * Purchase-order reference counter (Sprint F6). One row per org holding the LAST
 * PO number handed out (`last_seq`, mirroring `invoice_counters`). Allocation is an
 * atomic upsert-increment (lib/data/po-counters.ts), so it is row-locked and
 * concurrency-safe — NOT `MAX(number)+1`.
 *
 * UNLIKE invoices, PO numbers are gap-TOLERANT and editable: the counter only yields
 * the suggested default; the real `purchase_orders.number` (Sprint 8a) is an editable
 * column with `unique (org, number)` + a positive-integer check. A manual edit calls
 * `advancePoCounterAtLeast` so the counter never re-issues a number. Per-org single
 * sequence, no yearly reset. Standard org_isolation RLS (it is normal org data, not
 * append-only — do NOT copy the audit-log policy).
 */
export const poCounters = pgTable(
  'po_counters',
  {
    organizationId: text('organization_id').primaryKey(),
    // Highest PO number handed out for this org so far (0 = none yet).
    lastSeq: integer('last_seq').notNull().default(0),
  },
  (t) => [
    // A counter never goes negative.
    check('po_counters_last_seq_chk', sql`${t.lastSeq} >= 0`),
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
 * Purchase orders (Sprint 8a, module — procurement). The first transactional
 * DOCUMENT built on the Foundation: a manager drafts an order to a supplier, then
 * SENDS it. Lifecycle: draft → sent / cancelled (cancel-only — a sent PO is
 * immutable; to change one you cancel + re-draft).
 *
 * Numbering (F6): `number` is allocated at DRAFT CREATION via `allocatePoNumber`
 * (lib/data/po-counters.ts) in the create tx — gap-TOLERANT and editable, unique
 * per org. Snapshot-on-send (F3 Policy A, the `invoices` precedent): at draft→sent
 * the live supplier is FROZEN into the `supplier_*` columns under a row lock, so the
 * historical order never changes when the supplier is later edited/archived.
 * `currency_code` is frozen at create so a later org-currency change can't rewrite a
 * historical PO. RULE #1: carries `organization_id`, in `businessTables`.
 */
export const purchaseOrders = pgTable(
  'purchase_orders',
  {
    id: id(),
    organizationId: orgId(),
    // Editable, gap-tolerant per-org PO number (F6). Allocated at create.
    number: integer('number').notNull(),
    // Frozen ISO-4217 code (from org settings) so totals keep their historical meaning.
    currencyCode: text('currency_code').notNull(),
    // Live link to the supplier; nulled is impossible here (restrict FK) — suppliers
    // are archived, never hard-deleted, so the link always resolves. Nullable so a
    // brand-new draft can exist before a supplier is chosen.
    supplierId: text('supplier_id'),
    // Supplier SNAPSHOT, captured at send — survives a later supplier edit/archive.
    supplierName: text('supplier_name'),
    supplierEmail: text('supplier_email'),
    supplierPhone: text('supplier_phone'),
    supplierAddress: text('supplier_address'),
    supplierTaxId: text('supplier_tax_id'),
    // Lifecycle (Sprint 8a: draft/sent/cancelled; Sprint 8b adds the receiving
    // states). `received` is terminal for new receipts — the only way back is a void.
    status: text('status', {
      enum: ['draft', 'sent', 'partially_received', 'received', 'cancelled'],
    })
      .notNull()
      .default('draft'),
    // Bare calendar dates 'YYYY-MM-DD'. `order_date` is stamped at send.
    orderDate: date('order_date', { mode: 'string' }),
    expectedDate: date('expected_date', { mode: 'string' }),
    notes: text('notes'),
    // Sprint 8b receiving. `received_at` is stamped the first time the PO reaches a
    // `received` state (full delivery or short-close); a void that reopens the PO
    // clears it. `closed_reason` is set ONLY by an explicit short-close.
    receivedAt: timestamp('received_at', { withTimezone: true }),
    closedReason: text('closed_reason'),
    // Frozen totals (integer cents). Computed + stored at draft create/update so the
    // list never shows zero before send; re-frozen at send. v1 has no PO-level tax,
    // so `total_cents == subtotal_cents` (kept separate for forward-compat).
    subtotalCents: integer('subtotal_cents').notNull().default(0),
    totalCents: integer('total_cents').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('purchase_orders_org_idx').on(t.organizationId),
    index('purchase_orders_org_status_idx').on(t.organizationId, t.status),
    // FK target for purchase_order_items' composite (organization_id, purchase_order_id).
    unique('purchase_orders_org_id_key').on(t.organizationId, t.id),
    // Editable but unique per org (F6 consumer contract): gaps allowed, collisions not.
    unique('purchase_orders_org_number_key').on(t.organizationId, t.number),
    // pg_trgm GIN indexes for ⌘K (find by supplier name; number is searched as text).
    index('purchase_orders_supplier_name_trgm_idx').using(
      'gin',
      t.supplierName.op('gin_trgm_ops'),
    ),
    // Canonical PO number is a positive integer (F6); the unique above + this CHECK
    // are the DB backstop for the editable column.
    check('purchase_orders_number_chk', sql`${t.number} > 0`),
    check(
      'purchase_orders_status_chk',
      sql`${t.status} in ('draft', 'sent', 'partially_received', 'received', 'cancelled')`,
    ),
    // Composite FK forces same-org link. ON DELETE restrict: suppliers are archived,
    // never hard-deleted, so this never blocks; the snapshot is the historical truth.
    foreignKey({
      columns: [t.organizationId, t.supplierId],
      foreignColumns: [suppliers.organizationId, suppliers.id],
      name: 'purchase_orders_supplier_fk',
    }).onDelete('restrict'),
  ],
);

/**
 * Purchase-order line items (Sprint 8a). Each line orders an ingredient at a
 * NEGOTIATED `unit_cost_cents` (cost per priced unit — per kg / litre / piece;
 * defaulted from the supplier link, then editable) for a `quantity` in CANONICAL
 * units (g / ml / count). The line total uses the recipeCost convention
 * (`unit_cost_cents × quantity ÷ canonicalFactor`). At send, the ingredient name +
 * dimension are FROZEN (the negotiated `unit_cost_cents` is KEPT, never overwritten
 * by the ingredient's current approved cost).
 */
export const purchaseOrderItems = pgTable(
  'purchase_order_items',
  {
    id: id(),
    organizationId: orgId(),
    purchaseOrderId: text('purchase_order_id').notNull(),
    // Live link to the ingredient; nulled by the purge-block path only for DRAFT
    // references (a sent/cancelled PO blocks the ingredient purge — F3 Policy B).
    ingredientId: text('ingredient_id'),
    // Ingredient SNAPSHOT, frozen at send (survives a later ingredient edit/purge).
    ingredientName: text('ingredient_name'),
    dimension: text('dimension', { enum: ['weight', 'volume', 'count'] }),
    // Canonical amount ordered (g / ml / count). Scale 2 to reconcile EXACTLY with
    // the authoritative F1 ledger + stock (both numeric(12,2)) — Sprint 8b B1.
    quantity: numeric('quantity', { precision: 12, scale: 2 })
      .notNull()
      .default(sql`0`),
    // Negotiated cost per priced unit (per kg / litre / piece), integer cents.
    unitCostCents: integer('unit_cost_cents').notNull().default(0),
    // Frozen line total (integer cents): computed at draft, re-frozen at send.
    lineTotalCents: integer('line_total_cents').notNull().default(0),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [
    index('purchase_order_items_org_idx').on(t.organizationId),
    index('purchase_order_items_po_idx').on(t.purchaseOrderId),
    // Serves the purge-block reference check ("is this ingredient on any PO line?").
    index('purchase_order_items_org_ingredient_idx').on(
      t.organizationId,
      t.ingredientId,
    ),
    // FK target (Sprint 8b): a receipt line proves its ordered line belongs to the
    // stated PO via the composite (organization_id, purchase_order_id, id).
    unique('purchase_order_items_org_po_id_key').on(
      t.organizationId,
      t.purchaseOrderId,
      t.id,
    ),
    check('purchase_order_items_quantity_chk', sql`${t.quantity} > 0`),
    check(
      'purchase_order_items_unit_cost_chk',
      sql`${t.unitCostCents} >= 0`,
    ),
    // Composite FK forces the line to share its PO's organization_id; removing a PO
    // cascades its lines.
    foreignKey({
      columns: [t.organizationId, t.purchaseOrderId],
      foreignColumns: [purchaseOrders.organizationId, purchaseOrders.id],
      name: 'purchase_order_items_po_fk',
    }).onDelete('cascade'),
    // Composite FK to the ingredient (same-tenant). ON DELETE restrict: a non-draft
    // PO blocks the ingredient purge (F3 Policy B); a draft-only reference is nulled
    // first (a multi-column SET NULL would also null organization_id). NULL rows skip.
    foreignKey({
      columns: [t.organizationId, t.ingredientId],
      foreignColumns: [ingredients.organizationId, ingredients.id],
      name: 'purchase_order_items_ingredient_fk',
    }).onDelete('restrict'),
  ],
);

/**
 * Outbound email queue (Sprint 8a). A lease-based work queue so document emails
 * (PO send/cancel notices) are delivered RELIABLY out-of-band: the send action
 * commits the document + enqueues ONE row here in the same tx, and the cron worker
 * (app/api/cron/process-email-outbox) delivers it with backoff. Semantics are
 * AT-LEAST-ONCE with provider-side dedup (the `dedup_key` is passed to Resend as an
 * idempotency key), NOT exactly-once.
 *
 * Crash safety: a worker CLAIMS rows with `FOR UPDATE SKIP LOCKED`, stamping a
 * `lease_until` + `claim_token`; a crashed `sending` row whose lease expired is
 * re-claimable. A row that already has `provider_message_id` is NEVER re-sent.
 * RULE #1: carries `organization_id`, in `businessTables` → org_isolation RLS.
 */
export const emailOutbox = pgTable(
  'email_outbox',
  {
    id: id(),
    organizationId: orgId(),
    // Polymorphic document reference (no FK — kept generic for future doc types).
    documentType: text('document_type').notNull(),
    documentId: text('document_id').notNull(),
    toEmail: text('to_email').notNull(),
    subject: text('subject'),
    status: text('status', {
      enum: ['pending', 'sending', 'sent', 'failed', 'cancelled'],
    })
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    lastError: text('last_error'),
    // Set ONLY after the provider accepts — its presence means "never send again".
    providerMessageId: text('provider_message_id'),
    // Idempotent enqueue key (e.g. 'purchase_order:<id>:send'); also the provider
    // idempotency key. Unique per org.
    dedupKey: text('dedup_key').notNull(),
    // Earliest time the row may be claimed. NOT NULL DEFAULT now() so a freshly
    // enqueued row is immediately due (a NULL would never satisfy `<= now()`).
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Claim lease: while `status='sending'`, the row is owned until `lease_until`;
    // after that a worker may reclaim it (crash recovery). `claim_token` guards the
    // result write so a stale worker can't mark a row another worker re-claimed.
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    claimToken: text('claim_token'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('email_outbox_org_idx').on(t.organizationId),
    // Idempotent enqueue: one row per (org, dedup_key).
    unique('email_outbox_org_dedup_key').on(t.organizationId, t.dedupKey),
    // The claim scan: due, unsent rows. Partial so sent/failed rows are skipped.
    index('email_outbox_claim_idx')
      .on(t.status, t.nextAttemptAt)
      .where(sql`${t.providerMessageId} is null`),
    // Per-document lookup for the UI status chip.
    index('email_outbox_org_document_idx').on(
      t.organizationId,
      t.documentType,
      t.documentId,
    ),
    check(
      'email_outbox_status_chk',
      sql`${t.status} in ('pending', 'sending', 'sent', 'failed', 'cancelled')`,
    ),
    check('email_outbox_attempts_chk', sql`${t.attempts} >= 0`),
    check('email_outbox_max_attempts_chk', sql`${t.maxAttempts} > 0`),
    check(
      'email_outbox_document_type_chk',
      sql`${t.documentType} in ('purchase_order', 'cfo_report')`,
    ),
  ],
);

/**
 * Goods receipts (Sprint 8b). One row per DELIVERY event against a `sent` purchase
 * order; many receipts per PO model partial deliveries. Posting a receipt books
 * idempotent IN stock movements (F1) and raises the F2 pending cost; a CORRECTION
 * never edits a movement — it `void`s the receipt and posts F1 reversals (the row is
 * retained for history).
 *
 * Idempotency is form-level (B6): `client_mutation_id` is generated once on the
 * client and unique per org; combined with `payload_hash`, re-submitting the SAME id
 * with the SAME payload returns the existing receipt, a DIFFERENT payload conflicts.
 * RULE #1: carries `organization_id`, in `businessTables` → org_isolation RLS.
 */
export const receipts = pgTable(
  'receipts',
  {
    id: id(),
    organizationId: orgId(),
    purchaseOrderId: text('purchase_order_id').notNull(),
    // The delivery day (bare 'YYYY-MM-DD', no tz — like every other calendar date).
    receivedDate: date('received_date', { mode: 'string' }).notNull(),
    notes: text('notes'),
    // `posted` = live (its movements count toward stock + the received rollup);
    // `voided` = corrected (reversed by opposite F1 movements, excluded from rollup).
    status: text('status', { enum: ['posted', 'voided'] })
      .notNull()
      .default('posted'),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    actorUserId: text('actor_user_id'),
    // Form-level idempotency (Sprint 8b D6): the client mints this once per receive
    // form and resends it on retry; `payload_hash` fingerprints the normalized lines.
    clientMutationId: text('client_mutation_id').notNull(),
    payloadHash: text('payload_hash').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('receipts_org_idx').on(t.organizationId),
    index('receipts_org_po_idx').on(t.organizationId, t.purchaseOrderId),
    // FK target for receipt_items' composite (organization_id, receipt_id).
    unique('receipts_org_id_key').on(t.organizationId, t.id),
    // Composite FK target so a receipt line proves it belongs to its receipt's PO
    // (Sprint 8b B5): (organization_id, id, purchase_order_id).
    unique('receipts_org_id_po_key').on(
      t.organizationId,
      t.id,
      t.purchaseOrderId,
    ),
    // Form-level idempotency: one receipt per (org, client_mutation_id).
    unique('receipts_org_client_mutation_key').on(
      t.organizationId,
      t.clientMutationId,
    ),
    check('receipts_status_chk', sql`${t.status} in ('posted', 'voided')`),
    // Composite FK forces same-org link. restrict: a PO with receipts is historical
    // and never hard-deleted (only drafts delete, and a draft has no receipts).
    foreignKey({
      columns: [t.organizationId, t.purchaseOrderId],
      foreignColumns: [purchaseOrders.organizationId, purchaseOrders.id],
      name: 'receipts_po_fk',
    }).onDelete('restrict'),
  ],
);

/**
 * Receipt line items (Sprint 8b). Each line records a received quantity (CANONICAL —
 * g / ml / count, numeric(12,2) to reconcile with the F1 ledger) at a received unit
 * cost (per priced unit — kg / l / piece). The ingredient name + dimension are
 * SNAPSHOT-frozen at receipt time. Booking posts an IN movement (F1) keyed by this
 * row's id; a void posts the opposite reversal.
 *
 * Cross-PO / cross-receipt mixing is impossible at the DB layer (B5): the line
 * carries `purchase_order_id` + `receipt_id` + `purchase_order_item_id`, all NOT
 * NULL, with composite FKs binding the line's PO to BOTH its receipt and its ordered
 * line.
 */
export const receiptItems = pgTable(
  'receipt_items',
  {
    id: id(),
    organizationId: orgId(),
    receiptId: text('receipt_id').notNull(),
    // Denormalized from the receipt so the binding FKs below can enforce same-PO.
    purchaseOrderId: text('purchase_order_id').notNull(),
    purchaseOrderItemId: text('purchase_order_item_id').notNull(),
    ingredientId: text('ingredient_id').notNull(),
    // Ingredient SNAPSHOT, frozen at receipt time (survives a later edit/purge).
    ingredientName: text('ingredient_name').notNull(),
    dimension: text('dimension', {
      enum: ['weight', 'volume', 'count'],
    }).notNull(),
    // Canonical amount received (g / ml / count).
    receivedQuantity: numeric('received_quantity', {
      precision: 12,
      scale: 2,
    }).notNull(),
    // Received cost per priced unit (per kg / litre / piece), integer cents.
    receivedUnitCostCents: integer('received_unit_cost_cents').notNull(),
    // Frozen line total (integer cents): unit cost × qty ÷ canonicalFactor.
    lineTotalCents: integer('line_total_cents').notNull().default(0),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [
    index('receipt_items_org_idx').on(t.organizationId),
    index('receipt_items_org_receipt_idx').on(t.organizationId, t.receiptId),
    // Serves the received rollup (D2) AND the purge-block reference check.
    index('receipt_items_org_po_item_idx').on(
      t.organizationId,
      t.purchaseOrderItemId,
    ),
    index('receipt_items_org_ingredient_idx').on(
      t.organizationId,
      t.ingredientId,
    ),
    check('receipt_items_quantity_chk', sql`${t.receivedQuantity} > 0`),
    check(
      'receipt_items_unit_cost_chk',
      sql`${t.receivedUnitCostCents} >= 0`,
    ),
    // Bind to the parent receipt (cascade) AND to the same receipt's PO (B5).
    foreignKey({
      columns: [t.organizationId, t.receiptId],
      foreignColumns: [receipts.organizationId, receipts.id],
      name: 'receipt_items_receipt_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.organizationId, t.receiptId, t.purchaseOrderId],
      foreignColumns: [
        receipts.organizationId,
        receipts.id,
        receipts.purchaseOrderId,
      ],
      name: 'receipt_items_receipt_po_fk',
    }).onDelete('cascade'),
    // The ordered line must belong to that PO (B5): (org, po_id, po_item_id).
    foreignKey({
      columns: [t.organizationId, t.purchaseOrderId, t.purchaseOrderItemId],
      foreignColumns: [
        purchaseOrderItems.organizationId,
        purchaseOrderItems.purchaseOrderId,
        purchaseOrderItems.id,
      ],
      name: 'receipt_items_po_item_fk',
    }).onDelete('restrict'),
    // Same-tenant ingredient link; restrict so a received ingredient is purge-blocked
    // (F3 Policy B) — the receipt + its IN movement are permanent inventory history.
    foreignKey({
      columns: [t.organizationId, t.ingredientId],
      foreignColumns: [ingredients.organizationId, ingredients.id],
      name: 'receipt_items_ingredient_fk',
    }).onDelete('restrict'),
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
 * Generic provider-backed AI operation ledger (Sprint 2, AI margin roadmap — D1).
 * One row per metered AI call for any NEW feature (Supplier Invoice Reader is the
 * first). Written `pending` BEFORE the provider call, flipped to `succeeded` or
 * `failed` (with an `error_code`). It is the observability + USAGE-METERING ledger:
 * the monthly cap per FEATURE counts `succeeded` (+ in-flight `pending`) rows for the
 * org in the current month, inside the upload route's `withOrg`.
 *
 * DELIBERATELY separate from `ai_extraction_attempts` (the Sprint 4.7 photo ledger),
 * which stays untouched (D1: avoid a risky migration of the working photo import).
 *
 * RULE #1: carries `organization_id`, is in `businessTables` (standard `org_isolation`
 * RLS). `result_type`/`result_id` are a GENERIC, polymorphic provenance pointer to
 * what the operation produced (e.g. a `supplier_invoice_import` row) — nullable, NO
 * FK (the target table varies by feature; RLS + org scoping is the guard, same
 * precedent as `ingredient_price_history.ingredient_supplier_id`). Stores ONLY
 * non-sensitive metadata (provider/model/status, token counts, quality-flag codes,
 * an error code) — NEVER document bytes or raw model prose.
 */
export const aiOperationAttempts = pgTable(
  'ai_operation_attempts',
  {
    id: id(),
    organizationId: orgId(),
    // The Clerk user who ran the operation (never null — operations are authenticated).
    actorUserId: text('actor_user_id').notNull(),
    feature: text('feature', {
      enum: [
        'supplier_invoice_extraction',
        'profit_leak_explanation',
        'menu_engineering_explanation',
        'daily_close_summary',
        'prep_reorder_plan_summary',
        'kitchen_cfo_report',
      ],
    })
      .$type<AiOperationFeature>()
      .notNull(),
    status: text('status', { enum: ['pending', 'succeeded', 'failed'] })
      .$type<AiOperationStatus>()
      .notNull()
      .default('pending'),
    // Vendor + pinned model id, for traceability.
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    // Provider token usage, when reported (NULL otherwise). Cost observability only.
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    // Estimated provider cost in micros; NULL when not computed. Provider spend
    // metadata, NOT tenant money.
    costMicros: integer('cost_micros'),
    // Derived, stable quality-flag codes (feature-specific). Never raw model prose.
    qualityFlags: jsonb('quality_flags').$type<string[]>(),
    // Stable ActionErrorCode/reason on a failed attempt (NULL when succeeded).
    errorCode: text('error_code'),
    // Generic provenance pointer to what this operation produced (nullable, no FK).
    resultType: text('result_type'),
    resultId: text('result_id'),
    createdAt: createdAt(),
  },
  (t) => [
    index('ai_operation_attempts_org_idx').on(t.organizationId),
    // Serves the per-feature monthly usage count: rows per (org, feature), newest-first.
    index('ai_operation_attempts_org_feature_created_idx').on(
      t.organizationId,
      t.feature,
      t.createdAt,
    ),
    // Backs the composite (org, id) FK from `supplier_invoice_imports.ai_attempt_id`.
    unique('ai_operation_attempts_org_id_key').on(t.organizationId, t.id),
  ],
);

/**
 * Supplier invoice import — header (Sprint 2). A manager uploads an invoice
 * (image/PDF); the model extraction becomes a `draft` the manager reviews. Applying
 * turns approved lines into PENDING price observations (never approved-cost changes;
 * see supplier_invoice_import_lines). MVP applies straight from `draft` → `applied`;
 * `void` discards. Dedicated tables (not `import_jobs`) because invoice review is
 * line-level + match-heavy (D2).
 *
 * RULE #1: carries `organization_id`, in `businessTables` → standard `org_isolation`
 * RLS. Composite FKs force same-tenant links to the supplier + the AI attempt.
 * Contact/PII is never stored here; `supplier_name_raw` is the short name string the
 * model read (in GDPR export/deletion scope).
 */
export const supplierInvoiceImports = pgTable(
  'supplier_invoice_imports',
  {
    id: id(),
    organizationId: orgId(),
    // The Clerk user who uploaded the invoice (never null — uploads are authenticated).
    actorUserId: text('actor_user_id').notNull(),
    // Matched supplier (NULL until matched / created at apply). Composite FK below.
    supplierId: text('supplier_id'),
    // The supplier name the model read (short, review-only). NULL when unreadable.
    supplierNameRaw: text('supplier_name_raw'),
    // Invoice header fields the model read — informational, stored as text (never
    // trusted for math). NULL when unreadable.
    invoiceNumber: text('invoice_number'),
    invoiceDate: text('invoice_date'),
    // ISO-4217 currency the model read; MUST equal the org currency to apply (D6).
    currencyCode: text('currency_code'),
    status: text('status', {
      enum: ['draft', 'staged', 'applied', 'void'],
    })
      .$type<SupplierInvoiceImportStatus>()
      .notNull()
      .default('draft'),
    // The AI operation attempt that produced this import (usage/cost trail). Composite
    // FK below so an import can only reference THIS org's attempt.
    aiAttemptId: text('ai_attempt_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('supplier_invoice_imports_org_idx').on(t.organizationId),
    index('supplier_invoice_imports_org_status_idx').on(
      t.organizationId,
      t.status,
    ),
    // FK target for the lines' composite (org, import_id).
    unique('supplier_invoice_imports_org_id_key').on(t.organizationId, t.id),
    // Same-tenant supplier link; suppliers are archived not deleted, so restrict never
    // blocks in practice. NULL supplier_id rows skip the FK (MATCH SIMPLE).
    foreignKey({
      columns: [t.organizationId, t.supplierId],
      foreignColumns: [suppliers.organizationId, suppliers.id],
      name: 'supplier_invoice_imports_supplier_fk',
    }).onDelete('restrict'),
    // Same-tenant AI-attempt link; attempts are never hard-deleted.
    foreignKey({
      columns: [t.organizationId, t.aiAttemptId],
      foreignColumns: [aiOperationAttempts.organizationId, aiOperationAttempts.id],
      name: 'supplier_invoice_imports_attempt_fk',
    }).onDelete('restrict'),
  ],
);

/**
 * Supplier invoice import — line (Sprint 2). One extracted invoice line the manager
 * reviews/edits/matches. Applying a `ready` line records a `source='import'`
 * `ingredient_price_history` observation for `matched_ingredient_id` and raises that
 * ingredient's `pending_price_cents` — it NEVER touches `price_cents`.
 *
 * `matched_ingredient_id` is nullable + NO FK: the match is re-validated at apply
 * time under `withOrg` (RLS + a FOR UPDATE lock on the ingredient), the same
 * precedent as `import_jobs` storing resolutions without an FK. Money is integer
 * cents; `quantity_value`/`pack_size_value` are physical amounts (numeric, not
 * money); `confidence` is the model's per-line certainty in [0,1]. `raw_text` /
 * `item_name_raw` are short customer content — review-only, in GDPR scope, never
 * logged/audited.
 */
export const supplierInvoiceImportLines = pgTable(
  'supplier_invoice_import_lines',
  {
    id: id(),
    organizationId: orgId(),
    importId: text('import_id').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    // The full source line as transcribed — review display only, never logged/audited.
    rawText: text('raw_text'),
    // The item name the model read (review + resolver input).
    itemNameRaw: text('item_name_raw').notNull(),
    // The ingredient this line was matched to (nullable; re-validated at apply).
    matchedIngredientId: text('matched_ingredient_id'),
    // Physical amounts the model read (numeric, NOT money). NULL when unreadable.
    quantityValue: numeric('quantity_value', { precision: 12, scale: 2 }),
    quantityUnit: text('quantity_unit'),
    packSizeValue: numeric('pack_size_value', { precision: 12, scale: 2 }),
    packSizeUnit: text('pack_size_unit'),
    // Prices the model read (integer cents). NULL when unreadable.
    unitPriceCents: integer('unit_price_cents'),
    lineTotalCents: integer('line_total_cents'),
    // The per-priced-unit cost derived at apply (integer cents); NULL until derived.
    derivedPriceCents: integer('derived_price_cents'),
    // The model's per-line certainty in [0,1].
    confidence: numeric('confidence', { precision: 4, scale: 3 }),
    status: text('status', {
      enum: ['ready', 'needs_review', 'ignored', 'applied'],
    })
      .$type<SupplierInvoiceLineStatus>()
      .notNull()
      .default('needs_review'),
    // Stable review issue codes (localized client-side). Never PII.
    issues: jsonb('issues').$type<SupplierInvoiceLineIssueCode[]>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('supplier_invoice_import_lines_org_idx').on(t.organizationId),
    index('supplier_invoice_import_lines_org_import_idx').on(
      t.organizationId,
      t.importId,
    ),
    // Money integrity: non-negative prices when present.
    check(
      'supplier_invoice_import_lines_unit_price_chk',
      sql`${t.unitPriceCents} is null or ${t.unitPriceCents} >= 0`,
    ),
    check(
      'supplier_invoice_import_lines_line_total_chk',
      sql`${t.lineTotalCents} is null or ${t.lineTotalCents} >= 0`,
    ),
    check(
      'supplier_invoice_import_lines_derived_price_chk',
      sql`${t.derivedPriceCents} is null or ${t.derivedPriceCents} >= 0`,
    ),
    // Lines die with their import header (same-tenant composite FK).
    foreignKey({
      columns: [t.organizationId, t.importId],
      foreignColumns: [
        supplierInvoiceImports.organizationId,
        supplierInvoiceImports.id,
      ],
      name: 'supplier_invoice_import_lines_import_fk',
    }).onDelete('cascade'),
  ],
);

/**
 * Profit insight — one deterministic profit-leak finding's AI/triage state (Sprint 4,
 * AI margin roadmap). Keyed by the finding's stable `fingerprint`: findings themselves
 * are RECOMPUTED on every read from the live catalogue (never stored), so this table
 * holds only the *sidecar* state a finding can accumulate — the cached AI explanation
 * (so re-opening never re-calls the paid provider) and a `dismissed_at` triage flag.
 *
 * The explanation can only ever exist for a real finding (the action re-derives the
 * finding by fingerprint before writing here), and a missing row simply means "not yet
 * explained / not dismissed" — a failed or quota-blocked AI call leaves no row and the
 * finding still surfaces. NARROW by design (plan §9): NOT a broad `ai_insights` table.
 *
 * RULE #1: carries `organization_id`, in `businessTables` → standard `org_isolation`
 * RLS. The producing AI attempt is linked from `ai_operation_attempts` via its generic
 * `result_type='profit_insight'` / `result_id` pointer (no FK needed here). No PII:
 * `entity_name`-style raw text is NOT stored — only ids, the finding type, and the
 * model's bounded explanation prose.
 */
export const profitInsights = pgTable(
  'profit_insights',
  {
    id: id(),
    organizationId: orgId(),
    // Stable de-dup key from the deterministic finding (lib/calculations/profit-leaks).
    fingerprint: text('fingerprint').notNull(),
    // Finding descriptors, stored so a dismissed finding can be listed without re-derive.
    findingType: text('finding_type').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    // The cached, schema-validated AI explanation (NULL until explained). Bounded prose
    // + a risk label — never a computed money figure.
    explanation: jsonb('explanation').$type<ProfitLeakExplanationData>(),
    // The model id that produced the cached explanation (NULL until explained).
    explanationModel: text('explanation_model'),
    // Set when the manager dismisses the finding; NULL = active. Restoring nulls it.
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('profit_insights_org_idx').on(t.organizationId),
    // One sidecar row per (org, finding). Backs the upsert on explain/dismiss.
    unique('profit_insights_org_fingerprint_key').on(t.organizationId, t.fingerprint),
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

/**
 * External-food normalized-response cache (Open Food Facts integration plan §6.3).
 * PUBLIC REFERENCE DATA — DELIBERATELY NOT a business table: it carries no
 * `organization_id`, no user data, no search history and no pricing data, so it
 * is absent from `businessTables` and gets NO RLS. Two different orgs looking up
 * the same barcode share one cache row; that is correct and safe because the row
 * is nothing but the public product's normalized nutrition (the same data every
 * org would fetch from the provider). Like `rate_limits`, it is read/written via
 * the untenanted `getDb()` OUTSIDE any `withOrg` — the resolver runs before the
 * org transaction.
 *
 * It stores only the VALIDATED, NORMALIZED payload (an `ExternalFoodSnapshot`),
 * never the raw provider body. `normalization_version` invalidates rows when the
 * mapping logic changes; `payload_hash` is a debug/audit identity. Populated ONLY
 * by user-requested lookups — never preloaded/crawled/bulk-synced (plan §13).
 */
export const externalFoodCache = pgTable(
  'external_food_cache',
  {
    provider: text('provider', {
      enum: ['usda', 'open_food_facts'],
    }).notNull(),
    externalId: text('external_id').notNull(),
    normalizedPayload: jsonb('normalized_payload').notNull(),
    // When the SOURCE last changed the product (for staleness display).
    sourceUpdatedAt: timestamp('source_updated_at', { withTimezone: true }),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    normalizationVersion: integer('normalization_version').notNull(),
    payloadHash: text('payload_hash'),
  },
  (t) => [
    unique('external_food_cache_provider_external_id_key').on(
      t.provider,
      t.externalId,
    ),
  ],
);
export type ExternalFoodCacheRow = InferSelectModel<typeof externalFoodCache>;

export type Ingredient = InferSelectModel<typeof ingredients>;
export type NewIngredient = InferInsertModel<typeof ingredients>;
export type InventoryMovement = InferSelectModel<typeof inventoryMovements>;
export type NewInventoryMovement = InferInsertModel<typeof inventoryMovements>;
export type StorageArea = InferSelectModel<typeof storageAreas>;
export type NewStorageArea = InferInsertModel<typeof storageAreas>;
export type StockCount = InferSelectModel<typeof stockCounts>;
export type NewStockCount = InferInsertModel<typeof stockCounts>;
export type StockCountStatus = StockCount['status'];
export type StockCountItem = InferSelectModel<typeof stockCountItems>;
export type NewStockCountItem = InferInsertModel<typeof stockCountItems>;
export type IngredientPriceHistory = InferSelectModel<typeof ingredientPriceHistory>;
export type NewIngredientPriceHistory = InferInsertModel<typeof ingredientPriceHistory>;
export type Supplier = InferSelectModel<typeof suppliers>;
export type NewSupplier = InferInsertModel<typeof suppliers>;
export type IngredientSupplier = InferSelectModel<typeof ingredientSuppliers>;
export type NewIngredientSupplier = InferInsertModel<typeof ingredientSuppliers>;
export type Recipe = InferSelectModel<typeof recipes>;
export type NewRecipe = InferInsertModel<typeof recipes>;
export type RecipeFolder = InferSelectModel<typeof recipeFolders>;
export type NewRecipeFolder = InferInsertModel<typeof recipeFolders>;
// Recipes 2.0 foundation (Meez-parity plan).
export type RecipeIngredientSection = InferSelectModel<
  typeof recipeIngredientSections
>;
export type RecipeMedia = InferSelectModel<typeof recipeMedia>;
export type RecipeBook = InferSelectModel<typeof recipeBooks>;
export type RecipeBookEntry = InferSelectModel<typeof recipeBookEntries>;
export type RecipeMethodSection = InferSelectModel<typeof recipeMethodSections>;
export type RecipeStep = InferSelectModel<typeof recipeSteps>;
export type RecipeStepMedia = InferSelectModel<typeof recipeStepMedia>;
export type RecipePortionOption = InferSelectModel<typeof recipePortionOptions>;
export type IngredientUomEquivalency = InferSelectModel<
  typeof ingredientUomEquivalencies
>;
export type IngredientPrepAction = InferSelectModel<
  typeof ingredientPrepActions
>;
export type IngredientNutritionProfile = InferSelectModel<
  typeof ingredientNutritionProfiles
>;
export type RecipeIngredient = InferSelectModel<typeof recipeIngredients>;
export type NewRecipeIngredient = InferInsertModel<typeof recipeIngredients>;
export type RecipePreset = InferSelectModel<typeof recipePresets>;
export type NewRecipePreset = InferInsertModel<typeof recipePresets>;
export type RecipeComponent = InferSelectModel<typeof recipeComponents>;
export type NewRecipeComponent = InferInsertModel<typeof recipeComponents>;
export type IngredientAllergen = InferSelectModel<typeof ingredientAllergens>;
export type NewIngredientAllergen = InferInsertModel<typeof ingredientAllergens>;
export type RecipeAllergenOverride = InferSelectModel<typeof recipeAllergenOverrides>;
export type NewRecipeAllergenOverride = InferInsertModel<
  typeof recipeAllergenOverrides
>;
export type Menu = InferSelectModel<typeof menus>;
export type NewMenu = InferInsertModel<typeof menus>;
export type MenuItem = InferSelectModel<typeof menuItems>;
export type NewMenuItem = InferInsertModel<typeof menuItems>;
export type Production = InferSelectModel<typeof productions>;
export type NewProduction = InferInsertModel<typeof productions>;
export type ProductionStatus = Production['status'];
export type ProductionItem = InferSelectModel<typeof productionItems>;
export type NewProductionItem = InferInsertModel<typeof productionItems>;
export type ProductionRecipeSnapshot = InferSelectModel<
  typeof productionRecipeSnapshots
>;
export type NewProductionRecipeSnapshot = InferInsertModel<
  typeof productionRecipeSnapshots
>;
export type ProductionConsumption = InferSelectModel<typeof productionConsumptions>;
export type NewProductionConsumption = InferInsertModel<
  typeof productionConsumptions
>;
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
export type PoCounter = InferSelectModel<typeof poCounters>;
export type PurchaseOrder = InferSelectModel<typeof purchaseOrders>;
export type NewPurchaseOrder = InferInsertModel<typeof purchaseOrders>;
export type PurchaseOrderStatus = PurchaseOrder['status'];
export type PurchaseOrderItem = InferSelectModel<typeof purchaseOrderItems>;
export type NewPurchaseOrderItem = InferInsertModel<typeof purchaseOrderItems>;
export type EmailOutboxRow = InferSelectModel<typeof emailOutbox>;
export type NewEmailOutboxRow = InferInsertModel<typeof emailOutbox>;
export type EmailOutboxStatus = EmailOutboxRow['status'];
export type Receipt = InferSelectModel<typeof receipts>;
export type NewReceipt = InferInsertModel<typeof receipts>;
export type ReceiptStatus = Receipt['status'];
export type ReceiptItem = InferSelectModel<typeof receiptItems>;
export type NewReceiptItem = InferInsertModel<typeof receiptItems>;
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
export type AiOperationAttempt = InferSelectModel<typeof aiOperationAttempts>;
export type NewAiOperationAttempt = InferInsertModel<typeof aiOperationAttempts>;
export type SupplierInvoiceImport = InferSelectModel<typeof supplierInvoiceImports>;
export type NewSupplierInvoiceImport = InferInsertModel<typeof supplierInvoiceImports>;
export type SupplierInvoiceImportLine = InferSelectModel<
  typeof supplierInvoiceImportLines
>;
export type NewSupplierInvoiceImportLine = InferInsertModel<
  typeof supplierInvoiceImportLines
>;
export type ProfitInsight = InferSelectModel<typeof profitInsights>;
export type NewProfitInsight = InferInsertModel<typeof profitInsights>;
export type RateLimitRow = InferSelectModel<typeof rateLimits>;
export type Sale = InferSelectModel<typeof sales>;
export type NewSale = InferInsertModel<typeof sales>;
export type SaleStatus = Sale['status'];
export type SaleItem = InferSelectModel<typeof saleItems>;
export type NewSaleItem = InferInsertModel<typeof saleItems>;
export type SaleItemKind = SaleItem['itemKind'];
export type TaskList = InferSelectModel<typeof taskLists>;
export type NewTaskList = InferInsertModel<typeof taskLists>;
export type Task = InferSelectModel<typeof tasks>;
export type NewTask = InferInsertModel<typeof tasks>;
export type TaskStatus = Task['status'];
export type TaskSourceKind = Task['sourceKind'];

/** All business tables, for applying RLS in bulk. */
export const businessTables = [
  'organization_settings',
  'ingredients',
  'recipe_folders',
  'recipes',
  'recipe_ingredients',
  // Kitchen presets (Recipe-editor parity) — standard org_isolation RLS.
  'recipe_presets',
  // Sub-recipe component lines — standard org_isolation RLS.
  'recipe_components',
  // Allergen tags + recipe overrides (Sprint 9) — standard org_isolation RLS.
  'ingredient_allergens',
  'recipe_allergen_overrides',
  // Menus / combos + their lines (Sprint 10) — standard org_isolation RLS.
  'menus',
  'menu_items',
  // Production plans + their lines (Sprint 11a) — standard org_isolation RLS.
  'productions',
  'production_items',
  // Frozen completion snapshots (Sprint 11b) — standard org_isolation RLS. NOT
  // append-only: immutability is enforced by the data layer, not by RLS.
  'production_recipe_snapshots',
  'production_consumptions',
  // Storage areas + physical counts (Sprint 12c) — standard org_isolation RLS.
  // `inventory_movements` stays append-only; areas/counts are editable config/history.
  'storage_areas',
  'stock_counts',
  'stock_count_items',
  'inventory_movements',
  // Ingredient price history (Sprint F2) — standard org_isolation RLS.
  'ingredient_price_history',
  // Suppliers + ingredient links (Sprint 7) — standard org_isolation RLS.
  'suppliers',
  'ingredient_suppliers',
  'transaction_categories',
  'transactions',
  'customers',
  'invoice_counters',
  // PO reference counter (Sprint F6) — standard org_isolation RLS.
  'po_counters',
  'invoices',
  'invoice_items',
  // Purchase orders + lines + the email outbox (Sprint 8a) — standard
  // org_isolation RLS (the outbox is org data, NOT append-only).
  'purchase_orders',
  'purchase_order_items',
  'email_outbox',
  // Goods receipts + lines (Sprint 8b) — standard org_isolation RLS.
  'receipts',
  'receipt_items',
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
  // Generic AI operation ledger (Sprint 2, AI margin roadmap) — observability +
  // per-feature usage metering, standard org_isolation RLS.
  'ai_operation_attempts',
  // Supplier invoice imports + their lines (Sprint 2) — staged review of an uploaded
  // invoice; apply records pending price observations only. Standard org_isolation RLS.
  'supplier_invoice_imports',
  'supplier_invoice_import_lines',
  // Profit-insight sidecar state (Sprint 4, AI margin roadmap) — cached AI explanation
  // + dismiss flag per deterministic finding. Standard org_isolation RLS.
  'profit_insights',
  // Kitchen task lists + their tasks (Sprint 6) — standard org_isolation RLS.
  // Money-free operational data.
  'task_lists',
  'tasks',
  // Daily-close sales + their lines (Sprint 12a) — standard org_isolation RLS.
  // Financial → manager-only at the app layer; posted/void rows are permanent history.
  'sales',
  'sale_items',
  // Recipes 2.0 foundation (Meez-parity plan, Release A) — all standard
  // org_isolation RLS.
  'recipe_ingredient_sections',
  'recipe_media',
  'recipe_books',
  'recipe_book_entries',
  'recipe_method_sections',
  'recipe_steps',
  'recipe_step_media',
  'recipe_portion_options',
  'ingredient_uom_equivalencies',
  'ingredient_prep_actions',
  'ingredient_nutrition_profiles',
  // NOTE: `rate_limits` is intentionally ABSENT — it is infra, not tenant data,
  // and must work without an org context (see its table comment + lib/db/rls.ts).
] as const;
