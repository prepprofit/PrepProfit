import { and, asc, count, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import {
  ingredients,
  productionItems,
  productions,
  recipeIngredients,
  recipes,
} from '@/lib/db/schema';
import type { Production } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';
import type { Dimension } from '@/lib/units';
import { recipeCost, type RecipeCostLine } from '@/lib/calculations/recipeCost';
import { componentCost } from '@/lib/calculations/componentCost';
import {
  explodeProduction,
  shortfallVsStock,
  type ProductionExplosion,
  type ProductionRecipeInput,
} from '@/lib/calculations/production';

/**
 * Production-planning data layer (Sprint 11a). Every function is org-scoped (RULE
 * #1) and runs inside the caller's `withOrg` transaction so RLS is active. Nothing
 * derived is stored: the explosion (mise-en-place), shortfall and — manager only —
 * cost all DERIVE ON READ from the current recipes/ingredients. 11a writes ZERO
 * inventory movements and never touches `ingredients.stock_quantity` (that is 11b).
 *
 * F4 BY CONSTRUCTION: two loader families with EXPLICIT projections. `*Kitchen*`
 * selects identity/composition/availability + the operational explosion/shortfall
 * only — it never selects ingredient prices or recipe money and never calls a cost
 * helper. `*Manager*` additionally selects the financial columns and computes the
 * production cost. The kitchen DTO types cannot structurally hold money.
 *
 * Optimistic concurrency: every state/edit/delete mutation takes `expectedUpdatedAt`,
 * locks the row `FOR UPDATE`, compares it, and returns `stale` BEFORE any write/audit
 * on mismatch — so a kitchen and a manager editing the same plan can't silently
 * clobber each other.
 */

// ── Shared (money-free) line + requirement views ─────────────────────────────

/** One production line as both roles see it (no money). */
export type ProductionLineBase = {
  /** production_items row id. */
  id: string;
  recipeId: string;
  recipeName: string;
  plannedQty: number;
  sortOrder: number;
  /** False when the recipe is trashed/missing → the explosion is incomplete. */
  available: boolean;
};

/** One aggregated requirement with display fields + stock position (complete only). */
export type ProductionRequirementView = {
  ingredientId: string;
  ingredientName: string;
  dimension: Dimension;
  neededCanonical: number;
  onHandCanonical: number;
  /** max(0, needed − onHand). Advisory only — NOT a reservation. */
  shortfallCanonical: number;
};

/** One requirement in an INCOMPLETE preview — needed only, never a stock/shortfall. */
export type PartialRequirementView = {
  ingredientId: string;
  ingredientName: string;
  dimension: Dimension;
  neededCanonical: number;
};

/** The explosion as the detail DTO carries it (money-free, shared by both roles). */
export type ProductionExplosionView = {
  complete: boolean;
  /** Populated only when complete (carries on-hand + shortfall). */
  requirements: ProductionRequirementView[];
  /** A clearly-labelled preview when incomplete (needed quantities only). */
  partialRequirements: PartialRequirementView[];
  unavailableRecipeIds: string[];
  incompleteReason: 'recipe_unavailable' | 'invalid_math' | 'overflow' | null;
  /** When the explosion/shortfall was computed (the values are not stored). */
  calculatedAt: string;
  /** Shortfall is an instantaneous advisory, never an allocation/reservation. */
  isReservation: false;
};

// ── Kitchen DTOs (money keys are structurally absent) ─────────────────────────

export type KitchenProductionListItem = {
  id: string;
  reference: string | null;
  notes: string | null;
  status: Production['status'];
  plannedFor: string | null;
  itemCount: number;
  /** True when every referenced recipe is available (cheap availability check). */
  complete: boolean;
};

export type KitchenProductionDetail = {
  id: string;
  reference: string | null;
  notes: string | null;
  status: Production['status'];
  plannedFor: string | null;
  /** ISO timestamp the client echoes back as `expectedUpdatedAt` (optimistic lock). */
  updatedAt: string;
  lines: ProductionLineBase[];
  explosion: ProductionExplosionView;
};

// ── Manager DTOs (carry the financial fields) ─────────────────────────────────

export type ManagerProductionLine = ProductionLineBase & {
  /** This recipe's current cost per portion (cents); null when unavailable. */
  costPerPortionCents: number | null;
  /** costPerPortionCents × plannedQty; null when unavailable. */
  lineCostCents: number | null;
};

/** The production's derived cost — null when any component recipe is unavailable. */
export type ProductionCost = {
  costCents: number | null;
  unavailableRecipeIds: string[];
};

export type ManagerProductionListItem = KitchenProductionListItem & {
  /** Current estimated production cost (cents); null when incomplete. */
  costCents: number | null;
};

export type ManagerProductionDetail = {
  id: string;
  reference: string | null;
  notes: string | null;
  status: Production['status'];
  plannedFor: string | null;
  updatedAt: string;
  lines: ManagerProductionLine[];
  explosion: ProductionExplosionView;
  cost: ProductionCost;
};

// ── Base reads ────────────────────────────────────────────────────────────────

/** Active productions (newest first), identity rows only. */
export async function listProductions(
  db: TenantClient,
  organizationId: string,
): Promise<Production[]> {
  return db
    .select()
    .from(productions)
    .where(
      and(eq(productions.organizationId, organizationId), isNull(productions.deletedAt)),
    )
    .orderBy(desc(productions.createdAt));
}

/** One active production by id, or null. */
export async function getProductionById(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<Production | null> {
  const rows = await db
    .select()
    .from(productions)
    .where(
      and(
        eq(productions.organizationId, organizationId),
        eq(productions.id, id),
        isNull(productions.deletedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function listTrashedProductions(
  db: TenantClient,
  organizationId: string,
): Promise<Production[]> {
  return db
    .select()
    .from(productions)
    .where(
      and(
        eq(productions.organizationId, organizationId),
        isNotNull(productions.deletedAt),
      ),
    )
    .orderBy(desc(productions.deletedAt));
}

type ProductionItemRow = {
  id: string;
  productionId: string;
  recipeId: string;
  plannedQty: number;
  sortOrder: number;
};

/** Raw production_items rows for a set of productions, ordered by (production, sort). */
async function loadProductionItems(
  db: TenantClient,
  organizationId: string,
  productionIds: string[],
): Promise<ProductionItemRow[]> {
  if (productionIds.length === 0) return [];
  return db
    .select({
      id: productionItems.id,
      productionId: productionItems.productionId,
      recipeId: productionItems.recipeId,
      plannedQty: productionItems.plannedQty,
      sortOrder: productionItems.sortOrder,
    })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.organizationId, organizationId),
        inArray(productionItems.productionId, productionIds),
      ),
    )
    .orderBy(asc(productionItems.productionId), asc(productionItems.sortOrder));
}

// ── Recipe / ingredient resolution for the explosion (money-free) ─────────────

type RecipeExplosionInfo = {
  name: string;
  available: boolean;
  yieldPortions: number;
  yieldPercentage: number;
  lines: { ingredientId: string; quantity: number }[];
};

type IngredientInfo = {
  name: string;
  dimension: Dimension;
  stockCanonical: number;
};

/**
 * Resolve every referenced recipe's name + availability + yield + ingredient lines,
 * INCLUDING trashed recipes (so an unavailable line keeps its name and the explosion
 * is correctly incomplete, never silently dropped). Money-free — no ingredient
 * prices are selected. Also returns per-ingredient name/dimension/stock for the
 * requirement + shortfall views. The ingredient join is NOT `deleted_at`-filtered,
 * mirroring recipe costing. Two batched queries (recipes, then all their lines) — no
 * N+1.
 */
async function loadExplosionInputs(
  db: TenantClient,
  organizationId: string,
  recipeIds: string[],
): Promise<{
  recipes: Map<string, RecipeExplosionInfo>;
  ingredients: Map<string, IngredientInfo>;
}> {
  const recipeMap = new Map<string, RecipeExplosionInfo>();
  const ingredientMap = new Map<string, IngredientInfo>();
  if (recipeIds.length === 0) return { recipes: recipeMap, ingredients: ingredientMap };

  const recipeRows = await db
    .select({
      id: recipes.id,
      name: recipes.name,
      deletedAt: recipes.deletedAt,
      yieldPortions: recipes.yieldPortions,
      yieldPercentage: recipes.yieldPercentage,
    })
    .from(recipes)
    .where(
      and(eq(recipes.organizationId, organizationId), inArray(recipes.id, recipeIds)),
    );

  for (const r of recipeRows) {
    recipeMap.set(r.id, {
      name: r.name,
      available: r.deletedAt === null,
      yieldPortions: r.yieldPortions,
      yieldPercentage: r.yieldPercentage,
      lines: [],
    });
  }

  const lineRows = await db
    .select({
      recipeId: recipeIngredients.recipeId,
      ingredientId: recipeIngredients.ingredientId,
      quantity: recipeIngredients.quantity,
      ingredientName: ingredients.name,
      dimension: ingredients.dimension,
      stockQuantity: ingredients.stockQuantity,
    })
    .from(recipeIngredients)
    .innerJoin(
      ingredients,
      and(
        eq(recipeIngredients.ingredientId, ingredients.id),
        eq(ingredients.organizationId, organizationId),
      ),
    )
    .where(
      and(
        eq(recipeIngredients.organizationId, organizationId),
        inArray(recipeIngredients.recipeId, recipeIds),
      ),
    );

  for (const l of lineRows) {
    const recipe = recipeMap.get(l.recipeId);
    if (recipe) {
      recipe.lines.push({
        ingredientId: l.ingredientId,
        quantity: Number(l.quantity),
      });
    }
    if (!ingredientMap.has(l.ingredientId)) {
      ingredientMap.set(l.ingredientId, {
        name: l.ingredientName,
        dimension: l.dimension,
        stockCanonical: Number(l.stockQuantity),
      });
    }
  }

  return { recipes: recipeMap, ingredients: ingredientMap };
}

/**
 * Resolve recipe name + availability + current cost per portion for a set of recipe
 * ids, INCLUDING trashed rows. A trashed/missing recipe yields `costPerPortionCents
 * = null` (never zero, D5). Batched (recipes, then all their lines + ingredient
 * prices), then `recipeCost` once per recipe. For MANAGER loaders only — carries money.
 */
async function costRecipesByIds(
  db: TenantClient,
  organizationId: string,
  recipeIds: string[],
): Promise<Map<string, number | null>> {
  const map = new Map<string, number | null>();
  if (recipeIds.length === 0) return map;

  const recipeRows = await db
    .select()
    .from(recipes)
    .where(
      and(eq(recipes.organizationId, organizationId), inArray(recipes.id, recipeIds)),
    );

  const lineRows = await db
    .select({
      recipeId: recipeIngredients.recipeId,
      quantity: recipeIngredients.quantity,
      dimension: ingredients.dimension,
      priceCents: ingredients.priceCents,
    })
    .from(recipeIngredients)
    .innerJoin(
      ingredients,
      and(
        eq(recipeIngredients.ingredientId, ingredients.id),
        eq(ingredients.organizationId, organizationId),
      ),
    )
    .where(
      and(
        eq(recipeIngredients.organizationId, organizationId),
        inArray(recipeIngredients.recipeId, recipeIds),
      ),
    );

  const linesByRecipe = new Map<string, RecipeCostLine[]>();
  for (const r of lineRows) {
    const line: RecipeCostLine = {
      dimension: r.dimension,
      priceCents: r.priceCents,
      quantity: Number(r.quantity),
    };
    const existing = linesByRecipe.get(r.recipeId);
    if (existing) existing.push(line);
    else linesByRecipe.set(r.recipeId, [line]);
  }

  for (const recipe of recipeRows) {
    const available = recipe.deletedAt === null;
    map.set(
      recipe.id,
      available
        ? recipeCost({
            yieldPortions: recipe.yieldPortions,
            yieldPercentage: recipe.yieldPercentage,
            laborCostCents: recipe.laborCostCents,
            energyCostCents: recipe.energyCostCents,
            packagingCostCents: recipe.packagingCostCents,
            lines: linesByRecipe.get(recipe.id) ?? [],
          }).costPerPortionCents
        : null,
    );
  }
  return map;
}

// ── Explosion assembly (shared core) ──────────────────────────────────────────

/** Build the discriminated explosion for a production's items from resolved inputs. */
function buildExplosion(
  items: ProductionItemRow[],
  recipeMap: Map<string, RecipeExplosionInfo>,
): ProductionExplosion {
  const inputs: ProductionRecipeInput[] = items.map((item) => {
    const recipe = recipeMap.get(item.recipeId);
    // A recipe id with no resolved row is missing/corrupt → unavailable (never
    // dropped). yield defaults are placeholders; an unavailable recipe never
    // contributes to the requirement.
    return {
      recipeId: item.recipeId,
      plannedQty: item.plannedQty,
      available: recipe?.available ?? false,
      yieldPortions: recipe?.yieldPortions ?? 1,
      yieldPercentage: recipe?.yieldPercentage ?? 100,
      lines: recipe?.lines ?? [],
    };
  });
  return explodeProduction(inputs);
}

/** Project the explosion into the money-free DTO view (requirements + shortfall). */
function explosionView(
  explosion: ProductionExplosion,
  ingredientMap: Map<string, IngredientInfo>,
): ProductionExplosionView {
  const calculatedAt = new Date().toISOString();
  const fallbackDimension: Dimension = 'weight';

  if (explosion.complete) {
    const onHandById = new Map<string, number>();
    for (const req of explosion.requirements) {
      onHandById.set(
        req.ingredientId,
        ingredientMap.get(req.ingredientId)?.stockCanonical ?? 0,
      );
    }
    const shortfall = shortfallVsStock(explosion.requirements, onHandById);
    const requirements: ProductionRequirementView[] = shortfall.map((s) => {
      const info = ingredientMap.get(s.ingredientId);
      return {
        ingredientId: s.ingredientId,
        ingredientName: info?.name ?? '',
        dimension: info?.dimension ?? fallbackDimension,
        neededCanonical: s.neededCanonical,
        onHandCanonical: s.onHandCanonical,
        shortfallCanonical: s.shortfallCanonical,
      };
    });
    return {
      complete: true,
      requirements,
      partialRequirements: [],
      unavailableRecipeIds: [],
      incompleteReason: null,
      calculatedAt,
      isReservation: false,
    };
  }

  const partialRequirements: PartialRequirementView[] =
    explosion.partialRequirements.map((req) => {
      const info = ingredientMap.get(req.ingredientId);
      return {
        ingredientId: req.ingredientId,
        ingredientName: info?.name ?? '',
        dimension: info?.dimension ?? fallbackDimension,
        neededCanonical: req.quantityCanonical,
      };
    });
  return {
    complete: false,
    requirements: [],
    partialRequirements,
    unavailableRecipeIds: explosion.unavailableRecipeIds,
    incompleteReason: explosion.reason,
    calculatedAt,
    isReservation: false,
  };
}

// ── Kitchen loaders ───────────────────────────────────────────────────────────

/** Money-free production list for the kitchen role (composition completeness only). */
export async function listKitchenProductions(
  db: TenantClient,
  organizationId: string,
): Promise<KitchenProductionListItem[]> {
  const rows = await listProductions(db, organizationId);
  if (rows.length === 0) return [];

  const items = await loadProductionItems(
    db,
    organizationId,
    rows.map((p) => p.id),
  );
  const recipeIds = [...new Set(items.map((i) => i.recipeId))];
  const availability = await loadRecipeAvailability(db, organizationId, recipeIds);

  const itemsByProduction = groupItems(items);
  return rows.map((production) => {
    const list = itemsByProduction.get(production.id) ?? [];
    const complete = list.every((l) => availability.get(l.recipeId) ?? false);
    return {
      id: production.id,
      reference: production.reference,
      notes: production.notes,
      status: production.status,
      plannedFor: production.plannedFor,
      itemCount: list.length,
      complete,
    };
  });
}

/** Money-free production detail for the kitchen role (explosion + shortfall, no cost). */
export async function getKitchenProduction(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<KitchenProductionDetail | null> {
  const production = await getProductionById(db, organizationId, id);
  if (!production) return null;

  const items = await loadProductionItems(db, organizationId, [production.id]);
  const recipeIds = [...new Set(items.map((i) => i.recipeId))];
  const inputs = await loadExplosionInputs(db, organizationId, recipeIds);
  const explosion = buildExplosion(items, inputs.recipes);

  return {
    id: production.id,
    reference: production.reference,
    notes: production.notes,
    status: production.status,
    plannedFor: production.plannedFor,
    updatedAt: production.updatedAt.toISOString(),
    lines: toLines(items, inputs.recipes),
    explosion: explosionView(explosion, inputs.ingredients),
  };
}

// ── Manager loaders ───────────────────────────────────────────────────────────

/** Full production list for the manager role (adds current estimated cost). */
export async function listManagerProductions(
  db: TenantClient,
  organizationId: string,
): Promise<ManagerProductionListItem[]> {
  const rows = await listProductions(db, organizationId);
  if (rows.length === 0) return [];

  const items = await loadProductionItems(
    db,
    organizationId,
    rows.map((p) => p.id),
  );
  const recipeIds = [...new Set(items.map((i) => i.recipeId))];
  const costs = await costRecipesByIds(db, organizationId, recipeIds);

  const itemsByProduction = groupItems(items);
  return rows.map((production) => {
    const list = itemsByProduction.get(production.id) ?? [];
    const complete = list.every((l) => costs.get(l.recipeId) != null);
    const cost = componentCost(
      list.map((l) => ({
        id: l.recipeId,
        costPerPortionCents: costs.get(l.recipeId) ?? null,
        quantity: l.plannedQty,
      })),
    );
    return {
      id: production.id,
      reference: production.reference,
      notes: production.notes,
      status: production.status,
      plannedFor: production.plannedFor,
      itemCount: list.length,
      complete,
      costCents: cost.complete ? cost.costCents : null,
    };
  });
}

/** Full production detail for the manager role (explosion/shortfall + cost). */
export async function getManagerProduction(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<ManagerProductionDetail | null> {
  const production = await getProductionById(db, organizationId, id);
  if (!production) return null;

  const items = await loadProductionItems(db, organizationId, [production.id]);
  const recipeIds = [...new Set(items.map((i) => i.recipeId))];
  const [inputs, costs] = await Promise.all([
    loadExplosionInputs(db, organizationId, recipeIds),
    costRecipesByIds(db, organizationId, recipeIds),
  ]);
  const explosion = buildExplosion(items, inputs.recipes);

  const lines: ManagerProductionLine[] = items.map((item) => {
    const recipe = inputs.recipes.get(item.recipeId);
    const costPerPortionCents = costs.get(item.recipeId) ?? null;
    return {
      id: item.id,
      recipeId: item.recipeId,
      recipeName: recipe?.name ?? '',
      plannedQty: item.plannedQty,
      sortOrder: item.sortOrder,
      available: recipe?.available ?? false,
      costPerPortionCents,
      lineCostCents:
        costPerPortionCents === null ? null : costPerPortionCents * item.plannedQty,
    };
  });

  const cost = componentCost(
    items.map((item) => ({
      id: item.recipeId,
      costPerPortionCents: costs.get(item.recipeId) ?? null,
      quantity: item.plannedQty,
    })),
  );

  return {
    id: production.id,
    reference: production.reference,
    notes: production.notes,
    status: production.status,
    plannedFor: production.plannedFor,
    updatedAt: production.updatedAt.toISOString(),
    lines,
    explosion: explosionView(explosion, inputs.ingredients),
    cost: {
      costCents: cost.complete ? cost.costCents : null,
      unavailableRecipeIds: cost.complete ? [] : cost.unavailableIds,
    },
  };
}

/** An active recipe the production editor can add (money-free — both roles). */
export type ProductionRecipeOption = { id: string; name: string };

/** Active recipes as production-editor options (id + name only, no money). */
export async function listProductionRecipeOptions(
  db: TenantClient,
  organizationId: string,
): Promise<ProductionRecipeOption[]> {
  return db
    .select({ id: recipes.id, name: recipes.name })
    .from(recipes)
    .where(and(eq(recipes.organizationId, organizationId), isNull(recipes.deletedAt)))
    .orderBy(asc(recipes.name));
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function groupItems(
  items: ProductionItemRow[],
): Map<string, ProductionItemRow[]> {
  const map = new Map<string, ProductionItemRow[]>();
  for (const item of items) {
    const existing = map.get(item.productionId);
    if (existing) existing.push(item);
    else map.set(item.productionId, [item]);
  }
  return map;
}

function toLines(
  items: ProductionItemRow[],
  recipeMap: Map<string, RecipeExplosionInfo>,
): ProductionLineBase[] {
  return items.map((item) => {
    const recipe = recipeMap.get(item.recipeId);
    return {
      id: item.id,
      recipeId: item.recipeId,
      recipeName: recipe?.name ?? '',
      plannedQty: item.plannedQty,
      sortOrder: item.sortOrder,
      available: recipe?.available ?? false,
    };
  });
}

/** Cheap recipe-availability map (id → active?), INCLUDING trashed rows. */
async function loadRecipeAvailability(
  db: TenantClient,
  organizationId: string,
  recipeIds: string[],
): Promise<Map<string, boolean>> {
  const map = new Map<string, boolean>();
  if (recipeIds.length === 0) return map;
  const rows = await db
    .select({ id: recipes.id, deletedAt: recipes.deletedAt })
    .from(recipes)
    .where(
      and(eq(recipes.organizationId, organizationId), inArray(recipes.id, recipeIds)),
    );
  for (const r of rows) map.set(r.id, r.deletedAt === null);
  return map;
}

// ── Mutations ─────────────────────────────────────────────────────────────────

/** A validated production line for create/update (recipe + planned portions). */
export type ProductionItemInput = { recipeId: string; plannedQty: number };

/** The production's own fields (no items) for create/update. */
export type ProductionFields = {
  reference: string | null;
  notes: string | null;
  plannedFor: string | null;
};

export type CreateProductionOutcome =
  | { status: 'ok'; production: Production }
  | { status: 'recipe_invalid' };

export type UpdateProductionOutcome =
  | { status: 'ok'; production: Production }
  | { status: 'not_found' }
  | { status: 'stale' }
  | { status: 'not_editable' }
  | { status: 'recipe_invalid' };

export type PlanProductionOutcome =
  | { status: 'ok'; production: Production }
  | { status: 'not_found' }
  | { status: 'stale' }
  | { status: 'not_editable' }
  | { status: 'incomplete' };

export type ReopenProductionOutcome =
  | { status: 'ok'; production: Production }
  | { status: 'not_found' }
  | { status: 'stale' }
  | { status: 'not_editable' };

export type DeleteProductionOutcome =
  | { status: 'ok'; production: Production }
  | { status: 'not_found' }
  | { status: 'stale' };

/**
 * Lock the supplied recipe ids FOR UPDATE in id-ascending order (deadlock-free),
 * returning true only when EVERY id resolves to an ACTIVE, same-org recipe. The lock
 * serializes against a concurrent recipe trash, so a draft can never capture a recipe
 * being trashed in a racing transaction. `recipeIds` must already be distinct.
 */
async function lockActiveRecipes(
  db: TenantClient,
  organizationId: string,
  recipeIds: string[],
): Promise<boolean> {
  if (recipeIds.length === 0) return false;
  const locked = await db
    .select({ id: recipes.id })
    .from(recipes)
    .where(
      and(
        eq(recipes.organizationId, organizationId),
        inArray(recipes.id, recipeIds),
        isNull(recipes.deletedAt),
      ),
    )
    .orderBy(asc(recipes.id))
    .for('update');
  return locked.length === recipeIds.length;
}

/**
 * Lock ALL referenced recipe rows (active OR trashed) FOR UPDATE in id order, so a
 * concurrent recipe trash serializes against the planning transaction (which then
 * recomputes completeness). Used by `planProduction`.
 */
async function lockReferencedRecipes(
  db: TenantClient,
  organizationId: string,
  recipeIds: string[],
): Promise<void> {
  if (recipeIds.length === 0) return;
  await db
    .select({ id: recipes.id })
    .from(recipes)
    .where(
      and(eq(recipes.organizationId, organizationId), inArray(recipes.id, recipeIds)),
    )
    .orderBy(asc(recipes.id))
    .for('update');
}

async function insertProductionItems(
  db: TenantClient,
  organizationId: string,
  productionId: string,
  items: ProductionItemInput[],
): Promise<void> {
  await db.insert(productionItems).values(
    items.map((item, index) => ({
      organizationId,
      productionId,
      recipeId: item.recipeId,
      plannedQty: item.plannedQty,
      sortOrder: index,
    })),
  );
}

/**
 * Lock the active production row (FOR UPDATE) and enforce the optimistic-concurrency
 * guard. Returns the locked row, or a discriminated reason (`not_found`/`stale`).
 * The caller layers the status-transition check on top.
 */
async function lockProductionForUpdate(
  db: TenantClient,
  organizationId: string,
  id: string,
  expectedUpdatedAt: Date,
): Promise<
  | { status: 'ok'; row: Production }
  | { status: 'not_found' }
  | { status: 'stale' }
> {
  const [row] = await db
    .select()
    .from(productions)
    .where(
      and(
        eq(productions.organizationId, organizationId),
        eq(productions.id, id),
        isNull(productions.deletedAt),
      ),
    )
    .for('update');
  if (!row) return { status: 'not_found' };
  if (row.updatedAt.getTime() !== expectedUpdatedAt.getTime()) {
    return { status: 'stale' };
  }
  return { status: 'ok', row };
}

/**
 * Create a draft production + its lines in one transaction. The caller has validated
 * non-empty DISTINCT items; here we lock + assert every recipe is active/same-org
 * (else `recipe_invalid`, no write), then insert. A new production is always `draft`.
 */
export async function createProduction(
  db: TenantClient,
  organizationId: string,
  fields: ProductionFields,
  items: ProductionItemInput[],
): Promise<CreateProductionOutcome> {
  const recipeIds = items.map((i) => i.recipeId);
  if (!(await lockActiveRecipes(db, organizationId, recipeIds))) {
    return { status: 'recipe_invalid' };
  }

  const [production] = await db
    .insert(productions)
    .values({
      organizationId,
      reference: fields.reference,
      notes: fields.notes,
      plannedFor: fields.plannedFor,
      status: 'draft',
    })
    .returning();
  if (!production) throw new Error('Failed to create production.');

  await insertProductionItems(db, organizationId, production.id, items);
  return { status: 'ok', production };
}

/**
 * Replace a DRAFT production's fields + lines in one transaction. Locks the row,
 * enforces the optimistic-concurrency guard (`stale`), refuses a non-draft
 * (`not_editable`), then locks/validates the recipes (`recipe_invalid`) before
 * rewriting the header + full item set.
 */
export async function updateDraftProduction(
  db: TenantClient,
  organizationId: string,
  id: string,
  expectedUpdatedAt: Date,
  fields: ProductionFields,
  items: ProductionItemInput[],
): Promise<UpdateProductionOutcome> {
  const lock = await lockProductionForUpdate(db, organizationId, id, expectedUpdatedAt);
  if (lock.status !== 'ok') return { status: lock.status };
  if (lock.row.status !== 'draft') return { status: 'not_editable' };

  const recipeIds = items.map((i) => i.recipeId);
  if (!(await lockActiveRecipes(db, organizationId, recipeIds))) {
    return { status: 'recipe_invalid' };
  }

  const [production] = await db
    .update(productions)
    .set({
      reference: fields.reference,
      notes: fields.notes,
      plannedFor: fields.plannedFor,
    })
    .where(
      and(
        eq(productions.organizationId, organizationId),
        eq(productions.id, id),
        isNull(productions.deletedAt),
      ),
    )
    .returning();
  if (!production) return { status: 'not_found' };

  await db
    .delete(productionItems)
    .where(
      and(
        eq(productionItems.organizationId, organizationId),
        eq(productionItems.productionId, id),
      ),
    );
  await insertProductionItems(db, organizationId, id, items);

  return { status: 'ok', production };
}

/**
 * `draft → planned`. Locks the row + referenced recipes, enforces the concurrency
 * guard, refuses a non-draft, then RECOMPUTES completeness under the locks: a planned
 * production must have `planned_for` AND a complete explosion (all recipes active,
 * finite in-domain math). Anything short → `incomplete` (no write). Stores no
 * calculation.
 */
export async function planProduction(
  db: TenantClient,
  organizationId: string,
  id: string,
  expectedUpdatedAt: Date,
): Promise<PlanProductionOutcome> {
  const lock = await lockProductionForUpdate(db, organizationId, id, expectedUpdatedAt);
  if (lock.status !== 'ok') return { status: lock.status };
  if (lock.row.status !== 'draft') return { status: 'not_editable' };

  const items = await loadProductionItems(db, organizationId, [id]);
  const recipeIds = [...new Set(items.map((i) => i.recipeId))];
  await lockReferencedRecipes(db, organizationId, recipeIds);

  const inputs = await loadExplosionInputs(db, organizationId, recipeIds);
  const explosion = buildExplosion(items, inputs.recipes);
  if (lock.row.plannedFor === null || !explosion.complete) {
    return { status: 'incomplete' };
  }

  const [production] = await db
    .update(productions)
    .set({ status: 'planned' })
    .where(
      and(
        eq(productions.organizationId, organizationId),
        eq(productions.id, id),
        isNull(productions.deletedAt),
      ),
    )
    .returning();
  if (!production) return { status: 'not_found' };
  return { status: 'ok', production };
}

/** `planned → draft` (reopen for editing). No stock effect. */
export async function reopenProduction(
  db: TenantClient,
  organizationId: string,
  id: string,
  expectedUpdatedAt: Date,
): Promise<ReopenProductionOutcome> {
  const lock = await lockProductionForUpdate(db, organizationId, id, expectedUpdatedAt);
  if (lock.status !== 'ok') return { status: lock.status };
  if (lock.row.status !== 'planned') return { status: 'not_editable' };

  const [production] = await db
    .update(productions)
    .set({ status: 'draft' })
    .where(
      and(
        eq(productions.organizationId, organizationId),
        eq(productions.id, id),
        isNull(productions.deletedAt),
      ),
    )
    .returning();
  if (!production) return { status: 'not_found' };
  return { status: 'ok', production };
}

/**
 * Soft-delete (trash) an active production — allowed in either pre-post state
 * (draft/planned). Enforces the concurrency guard. Restore preserves the prior status
 * because soft-delete only sets `deleted_at`.
 */
export async function softDeleteProduction(
  db: TenantClient,
  organizationId: string,
  id: string,
  expectedUpdatedAt: Date,
): Promise<DeleteProductionOutcome> {
  const lock = await lockProductionForUpdate(db, organizationId, id, expectedUpdatedAt);
  if (lock.status !== 'ok') return { status: lock.status };

  const [production] = await db
    .update(productions)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(productions.organizationId, organizationId),
        eq(productions.id, id),
        isNull(productions.deletedAt),
      ),
    )
    .returning();
  if (!production) return { status: 'not_found' };
  return { status: 'ok', production };
}

/** Bring a trashed production back (manager-only). Returns null if not in the trash. */
export async function restoreProduction(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<Production | null> {
  const [row] = await db
    .update(productions)
    .set({ deletedAt: null })
    .where(
      and(
        eq(productions.organizationId, organizationId),
        eq(productions.id, id),
        isNotNull(productions.deletedAt),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Permanently delete a trashed production; its lines cascade via the composite FK
 * (which frees any recipe those lines pinned via the restrict FK). Only trashed rows
 * are eligible.
 */
export async function purgeProduction(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<void> {
  await db
    .delete(productions)
    .where(
      and(
        eq(productions.organizationId, organizationId),
        eq(productions.id, id),
        isNotNull(productions.deletedAt),
      ),
    );
}

/**
 * How many production_items rows reference a recipe — across ALL productions
 * regardless of status or Trash state (the restrict FK blocks the recipe purge
 * either way, D4). The recipe-purge guard reads this BEFORE any side effect.
 */
export async function countProductionsUsingRecipe(
  db: TenantClient,
  organizationId: string,
  recipeId: string,
): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.organizationId, organizationId),
        eq(productionItems.recipeId, recipeId),
      ),
    );
  return rows[0]?.value ?? 0;
}
