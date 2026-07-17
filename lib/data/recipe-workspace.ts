import { and, asc, eq, isNull, ne } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  ingredients,
  recipes,
  recipeIngredients,
  recipeIngredientSections,
  recipeComponents,
  recipeMethodSections,
  recipeSteps,
  recipeStepMedia,
  recipeMedia,
  recipeBooks,
  recipeBookEntries,
  recipePortionOptions,
  type Recipe,
  type Ingredient,
  type RecipeIngredientSection,
  type RecipeMethodSection,
  type RecipeStep,
  type RecipeStepMedia,
  type RecipeMedia,
  type RecipePortionOption,
} from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';
import {
  writeAuditEvent,
  type AuditActor,
} from '@/lib/data/audit';

/**
 * Recipes 2.0 workspace facade (Meez-parity plan §10). ONE loader produces the
 * whole workspace DTO; each tab receives only its slice. The DTO comes in two
 * role-specific shapes:
 *
 * - MANAGER: full, including money (recipe costs, selling price, per-line
 *   ingredient price, portion-option prices).
 * - KITCHEN: the financial keys are LITERALLY ABSENT from the types and the
 *   payload (Sprint F4 contract) — never zeroed, never CSS-hidden. Structure,
 *   method, media, yield and books are operational and visible to both roles.
 *
 * Saves are optimistic-concurrency protected: every workspace save carries the
 * `expectedVersion` it was loaded with; the server locks the recipe row
 * FOR UPDATE, compares versions, applies, increments and audits — a mismatch
 * is a typed conflict, never a silent overwrite (plan decision 2/3).
 */

export type WorkspaceRole = 'manager' | 'kitchen';

/** Recipe money keys the kitchen payload must never contain. */
type RecipeMoneyKeys =
  | 'laborCostCents'
  | 'energyCostCents'
  | 'packagingCostCents'
  | 'sellingPriceCents';

export type WorkspaceIngredientLine = {
  id: string;
  ingredientId: string;
  quantity: number;
  sectionId: string | null;
  displaySortOrder: number;
  sortOrder: number;
  note: string | null;
  prepActionId: string | null;
  enteredQuantity: number | null;
  enteredUnit: string | null;
  ingredient: {
    name: string;
    dimension: Ingredient['dimension'];
  };
};

export type ManagerWorkspaceIngredientLine = WorkspaceIngredientLine & {
  ingredient: WorkspaceIngredientLine['ingredient'] & {
    priceCents: number;
    needsPricing: boolean;
  };
};

export type WorkspaceComponentLine = {
  id: string;
  componentRecipeId: string;
  componentRecipeName: string;
  quantityGrams: number;
  sectionId: string | null;
  displaySortOrder: number;
  sortOrder: number;
  note: string | null;
};

export type WorkspaceStep = RecipeStep & { media: RecipeStepMedia[] };

export type WorkspaceBookMembership = {
  bookId: string;
  bookName: string;
};

export type KitchenPortionOption = Omit<
  RecipePortionOption,
  'sellingPriceCents' | 'targetFoodCostBps'
>;

type WorkspaceShared = {
  ingredientSections: RecipeIngredientSection[];
  componentLines: WorkspaceComponentLine[];
  methodSections: RecipeMethodSection[];
  steps: WorkspaceStep[];
  media: RecipeMedia[];
  books: WorkspaceBookMembership[];
};

export type ManagerRecipeWorkspaceDTO = WorkspaceShared & {
  role: 'manager';
  recipe: Recipe;
  ingredientLines: ManagerWorkspaceIngredientLine[];
  portionOptions: RecipePortionOption[];
};

export type KitchenRecipeWorkspaceDTO = WorkspaceShared & {
  role: 'kitchen';
  recipe: Omit<Recipe, RecipeMoneyKeys>;
  ingredientLines: WorkspaceIngredientLine[];
  portionOptions: KitchenPortionOption[];
};

export type RecipeWorkspaceDTO =
  | ManagerRecipeWorkspaceDTO
  | KitchenRecipeWorkspaceDTO;

export async function getRecipeWorkspace(
  db: TenantClient,
  organizationId: string,
  recipeId: string,
  role: WorkspaceRole,
): Promise<RecipeWorkspaceDTO | null> {
  const [recipe] = await db
    .select()
    .from(recipes)
    .where(
      and(
        eq(recipes.organizationId, organizationId),
        eq(recipes.id, recipeId),
        isNull(recipes.deletedAt),
      ),
    )
    .limit(1);
  if (!recipe) return null;

  const componentRecipe = alias(recipes, 'component_recipe');
  const [
    ingredientSections,
    lineRows,
    componentRows,
    methodSections,
    stepRows,
    stepMediaRows,
    mediaRows,
    bookRows,
    portionRows,
  ] = await Promise.all([
    db
      .select()
      .from(recipeIngredientSections)
      .where(
        and(
          eq(recipeIngredientSections.organizationId, organizationId),
          eq(recipeIngredientSections.recipeId, recipeId),
        ),
      )
      .orderBy(asc(recipeIngredientSections.sortOrder)),
    db
      .select({
        line: recipeIngredients,
        name: ingredients.name,
        dimension: ingredients.dimension,
        priceCents: ingredients.priceCents,
        needsPricing: ingredients.needsPricing,
      })
      .from(recipeIngredients)
      .innerJoin(
        ingredients,
        and(
          eq(ingredients.organizationId, recipeIngredients.organizationId),
          eq(ingredients.id, recipeIngredients.ingredientId),
        ),
      )
      .where(
        and(
          eq(recipeIngredients.organizationId, organizationId),
          eq(recipeIngredients.recipeId, recipeId),
        ),
      )
      .orderBy(asc(recipeIngredients.displaySortOrder)),
    db
      .select({
        component: recipeComponents,
        componentName: componentRecipe.name,
      })
      .from(recipeComponents)
      .innerJoin(
        componentRecipe,
        and(
          eq(componentRecipe.organizationId, recipeComponents.organizationId),
          eq(componentRecipe.id, recipeComponents.componentRecipeId),
        ),
      )
      .where(
        and(
          eq(recipeComponents.organizationId, organizationId),
          eq(recipeComponents.recipeId, recipeId),
        ),
      )
      .orderBy(asc(recipeComponents.displaySortOrder)),
    db
      .select()
      .from(recipeMethodSections)
      .where(
        and(
          eq(recipeMethodSections.organizationId, organizationId),
          eq(recipeMethodSections.recipeId, recipeId),
        ),
      )
      .orderBy(asc(recipeMethodSections.sortOrder)),
    db
      .select()
      .from(recipeSteps)
      .where(
        and(
          eq(recipeSteps.organizationId, organizationId),
          eq(recipeSteps.recipeId, recipeId),
        ),
      )
      .orderBy(asc(recipeSteps.sortOrder)),
    db
      .select()
      .from(recipeStepMedia)
      .where(
        and(
          eq(recipeStepMedia.organizationId, organizationId),
          eq(recipeStepMedia.recipeId, recipeId),
        ),
      )
      .orderBy(asc(recipeStepMedia.sortOrder)),
    db
      .select()
      .from(recipeMedia)
      .where(
        and(
          eq(recipeMedia.organizationId, organizationId),
          eq(recipeMedia.recipeId, recipeId),
          ne(recipeMedia.status, 'deleted'),
        ),
      ),
    db
      .select({ bookId: recipeBooks.id, bookName: recipeBooks.name })
      .from(recipeBookEntries)
      .innerJoin(
        recipeBooks,
        and(
          eq(recipeBooks.organizationId, recipeBookEntries.organizationId),
          eq(recipeBooks.id, recipeBookEntries.recipeBookId),
        ),
      )
      .where(
        and(
          eq(recipeBookEntries.organizationId, organizationId),
          eq(recipeBookEntries.recipeId, recipeId),
        ),
      )
      .orderBy(asc(recipeBooks.sortOrder)),
    db
      .select()
      .from(recipePortionOptions)
      .where(
        and(
          eq(recipePortionOptions.organizationId, organizationId),
          eq(recipePortionOptions.recipeId, recipeId),
        ),
      )
      .orderBy(asc(recipePortionOptions.sortOrder)),
  ]);

  const mediaByStep = new Map<string, RecipeStepMedia[]>();
  for (const link of stepMediaRows) {
    const list = mediaByStep.get(link.stepId) ?? [];
    list.push(link);
    mediaByStep.set(link.stepId, list);
  }

  const shared: WorkspaceShared = {
    ingredientSections,
    componentLines: componentRows.map((r) => ({
      id: r.component.id,
      componentRecipeId: r.component.componentRecipeId,
      componentRecipeName: r.componentName,
      quantityGrams: r.component.quantityGrams,
      sectionId: r.component.sectionId,
      displaySortOrder: r.component.displaySortOrder,
      sortOrder: r.component.sortOrder,
      note: r.component.note,
    })),
    methodSections,
    steps: stepRows.map((s) => ({ ...s, media: mediaByStep.get(s.id) ?? [] })),
    media: mediaRows,
    books: bookRows,
  };

  const baseLine = (r: (typeof lineRows)[number]): WorkspaceIngredientLine => ({
    id: r.line.id,
    ingredientId: r.line.ingredientId,
    quantity: Number(r.line.quantity),
    sectionId: r.line.sectionId,
    displaySortOrder: r.line.displaySortOrder,
    sortOrder: r.line.sortOrder,
    note: r.line.note,
    prepActionId: r.line.prepActionId,
    enteredQuantity: r.line.enteredQuantity,
    enteredUnit: r.line.enteredUnit,
    ingredient: { name: r.name, dimension: r.dimension },
  });

  if (role === 'manager') {
    return {
      role: 'manager',
      recipe,
      ingredientLines: lineRows.map((r) => ({
        ...baseLine(r),
        ingredient: {
          name: r.name,
          dimension: r.dimension,
          priceCents: r.priceCents,
          needsPricing: r.needsPricing,
        },
      })),
      portionOptions: portionRows,
      ...shared,
    };
  }

  const {
    laborCostCents: _labor,
    energyCostCents: _energy,
    packagingCostCents: _packaging,
    sellingPriceCents: _selling,
    ...kitchenRecipe
  } = recipe;
  return {
    role: 'kitchen',
    recipe: kitchenRecipe,
    ingredientLines: lineRows.map(baseLine),
    portionOptions: portionRows.map((o) => {
      const {
        sellingPriceCents: _price,
        targetFoodCostBps: _target,
        ...rest
      } = o;
      return rest;
    }),
    ...shared,
  };
}

/**
 * Header fields the workspace save may change in this foundation slice. The
 * full structural save (sections/lines/method in one transaction) lands with
 * the workspace UI (plan Fase 2); the concurrency contract is identical.
 */
export type RecipeWorkspaceHeaderDraft = {
  name?: string;
  subtitle?: string | null;
  yieldQuantity?: number | null;
  yieldUnit?: string | null;
  nutritionServingQuantity?: number | null;
  nutritionServingUnit?: string | null;
  servingsPerContainer?: number | null;
};

export type SaveRecipeWorkspaceResult =
  | { ok: true; version: number }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'version_conflict'; currentVersion: number };

/**
 * Atomic, optimistic-concurrency workspace save. MUST run inside a `withOrg`
 * transaction: locks the recipe FOR UPDATE, compares `expectedVersion`,
 * applies the draft, increments `version` and writes ONE summarizing audit
 * event (metadata carries versions + changed field NAMES only — no content,
 * no money).
 */
export async function saveRecipeWorkspace(
  db: TenantClient,
  organizationId: string,
  recipeId: string,
  expectedVersion: number,
  draft: RecipeWorkspaceHeaderDraft,
  actor: AuditActor,
): Promise<SaveRecipeWorkspaceResult> {
  const locked = await db
    .select({ id: recipes.id, version: recipes.version })
    .from(recipes)
    .where(
      and(
        eq(recipes.organizationId, organizationId),
        eq(recipes.id, recipeId),
        isNull(recipes.deletedAt),
      ),
    )
    .for('update')
    .limit(1);
  const current = locked[0];
  if (!current) return { ok: false, reason: 'not_found' };
  if (Number(current.version) !== expectedVersion) {
    return {
      ok: false,
      reason: 'version_conflict',
      currentVersion: Number(current.version),
    };
  }

  const changedFields = Object.keys(draft).filter(
    (k) => draft[k as keyof RecipeWorkspaceHeaderDraft] !== undefined,
  );
  const newVersion = expectedVersion + 1;

  await db
    .update(recipes)
    .set({ ...draft, version: newVersion })
    .where(
      and(eq(recipes.organizationId, organizationId), eq(recipes.id, recipeId)),
    );

  await writeAuditEvent(db, organizationId, actor, {
    action: 'recipe.workspaceSave',
    entityType: 'recipe',
    entityId: recipeId,
    metadata: {
      fromVersion: expectedVersion,
      toVersion: newVersion,
      changedFields,
    },
  });

  return { ok: true, version: newVersion };
}

/** Narrow helper for tests/consumers: current version of a recipe (or null). */
export async function getRecipeVersion(
  db: TenantClient,
  organizationId: string,
  recipeId: string,
): Promise<number | null> {
  const [row] = await db
    .select({ version: recipes.version })
    .from(recipes)
    .where(
      and(eq(recipes.organizationId, organizationId), eq(recipes.id, recipeId)),
    )
    .limit(1);
  return row ? row.version : null;
}
