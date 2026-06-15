import { sql, type InferSelectModel, type InferInsertModel } from 'drizzle-orm';
import {
  pgTable,
  text,
  integer,
  numeric,
  timestamp,
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
  },
  (t) => [
    index('ingredients_org_idx').on(t.organizationId),
    index('ingredients_org_name_idx').on(t.organizationId, t.name),
    // FK target for the composite (organization_id, ingredient_id) reference.
    unique('ingredients_org_id_key').on(t.organizationId, t.id),
  ],
);

export const recipes = pgTable(
  'recipes',
  {
    id: id(),
    organizationId: orgId(),
    name: text('name').notNull(),
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
  },
  (t) => [
    index('recipes_org_idx').on(t.organizationId),
    index('recipes_org_name_idx').on(t.organizationId, t.name),
    // FK target for the composite (organization_id, recipe_id) reference.
    unique('recipes_org_id_key').on(t.organizationId, t.id),
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

export type Ingredient = InferSelectModel<typeof ingredients>;
export type NewIngredient = InferInsertModel<typeof ingredients>;
export type InventoryMovement = InferSelectModel<typeof inventoryMovements>;
export type NewInventoryMovement = InferInsertModel<typeof inventoryMovements>;
export type Recipe = InferSelectModel<typeof recipes>;
export type NewRecipe = InferInsertModel<typeof recipes>;
export type RecipeIngredient = InferSelectModel<typeof recipeIngredients>;
export type NewRecipeIngredient = InferInsertModel<typeof recipeIngredients>;
export type OrganizationSettings = InferSelectModel<typeof organizationSettings>;
export type NewOrganizationSettings = InferInsertModel<typeof organizationSettings>;
export type MeasurementSystem = OrganizationSettings['measurementSystem'];

/** All business tables, for applying RLS in bulk. */
export const businessTables = [
  'organization_settings',
  'ingredients',
  'recipes',
  'recipe_ingredients',
  'inventory_movements',
] as const;
