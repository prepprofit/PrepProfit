import { and, asc, eq, inArray, isNull, ne } from 'drizzle-orm';
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
import { assertNoRecipeComponentCycle } from '@/lib/data/recipe-components';

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

/** Header fields the workspace save may change. */
export type RecipeWorkspaceHeaderDraft = {
  name?: string;
  subtitle?: string | null;
  yieldQuantity?: number | null;
  yieldUnit?: string | null;
  nutritionServingQuantity?: number | null;
  nutritionServingUnit?: string | null;
  servingsPerContainer?: number | null;
};

/**
 * Structural draft (plan Fase 2): the workspace's ingredient area as ONE
 * document. Sections and lines are FULL-REPLACE sets — a section/line absent
 * from the draft is deleted; array position IS the persisted order
 * (`sort_order` for sections, `display_sort_order` for the merged line
 * sequence). New sections carry a client `tempId`; lines reference their
 * section by `sectionRef` = existing section id OR that tempId (null = the
 * default group). Duplicate ingredients across lines are legal (§6.2).
 */
export type WorkspaceSectionDraft = {
  /** Existing section id — absent for a newly added section. */
  id?: string;
  /** Client-side handle for lines of a NEW section. */
  tempId?: string;
  title: string;
};

export type WorkspaceLineDraft =
  | {
      kind: 'ingredient';
      /** Existing line id — absent for a newly added line. */
      id?: string;
      ingredientId: string;
      /** Canonical amount (g / ml / count), >= 0. */
      quantity: number;
      note?: string | null;
      sectionRef?: string | null;
    }
  | {
      kind: 'component';
      id?: string;
      componentRecipeId: string;
      /** Grams of the component recipe's finished output, > 0. */
      quantityGrams: number;
      note?: string | null;
      sectionRef?: string | null;
    };

export type RecipeWorkspaceStructureDraft = {
  header?: RecipeWorkspaceHeaderDraft;
  /** undefined = leave the structure untouched (header-only save). */
  sections?: WorkspaceSectionDraft[];
  lines?: WorkspaceLineDraft[];
};

export type SaveRecipeWorkspaceResult =
  | { ok: true; version: number }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'version_conflict'; currentVersion: number }
  | {
      ok: false;
      reason: 'invalid_draft';
      detail:
        | 'unknown_section_ref'
        | 'unknown_line_id'
        | 'unknown_section_id'
        | 'ingredient_unavailable'
        | 'component_invalid'
        | 'component_cycle';
    };

/**
 * Atomic, optimistic-concurrency workspace save. MUST run inside a `withOrg`
 * transaction: locks the recipe FOR UPDATE, compares `expectedVersion`,
 * applies the whole draft (header + full-replace sections/lines when
 * provided), increments `version` and writes ONE summarizing audit event
 * (metadata carries versions, changed area names and counts only — no
 * content, no money).
 *
 * `sections`/`lines` undefined = leave the structure untouched (header-only
 * save). Any validation failure returns a typed `invalid_draft` and the
 * transaction caller must roll back (throwing inside `withOrg` does that; the
 * server action wraps this accordingly) — a draft is applied fully or not at
 * all.
 */
export async function saveRecipeWorkspace(
  db: TenantClient,
  organizationId: string,
  recipeId: string,
  expectedVersion: number,
  draft: RecipeWorkspaceStructureDraft,
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

  const changedAreas: string[] = [];
  const invalid = (
    detail: Extract<
      SaveRecipeWorkspaceResult,
      { reason: 'invalid_draft' }
    >['detail'],
  ): SaveRecipeWorkspaceResult => ({
    ok: false,
    reason: 'invalid_draft',
    detail,
  });

  if (draft.sections !== undefined || draft.lines !== undefined) {
    const sections = draft.sections ?? [];
    const lines = draft.lines ?? [];

    // ── existing structure ───────────────────────────────────────────────
    const [existingSections, existingLines, existingComponents] =
      await Promise.all([
        db
          .select({ id: recipeIngredientSections.id })
          .from(recipeIngredientSections)
          .where(
            and(
              eq(recipeIngredientSections.organizationId, organizationId),
              eq(recipeIngredientSections.recipeId, recipeId),
            ),
          ),
        db
          .select({ id: recipeIngredients.id })
          .from(recipeIngredients)
          .where(
            and(
              eq(recipeIngredients.organizationId, organizationId),
              eq(recipeIngredients.recipeId, recipeId),
            ),
          ),
        db
          .select({
            id: recipeComponents.id,
            componentRecipeId: recipeComponents.componentRecipeId,
          })
          .from(recipeComponents)
          .where(
            and(
              eq(recipeComponents.organizationId, organizationId),
              eq(recipeComponents.recipeId, recipeId),
            ),
          ),
      ]);
    const existingSectionIds = new Set(existingSections.map((s) => s.id));
    const existingLineIds = new Set(existingLines.map((l) => l.id));
    const existingComponentIds = new Set(existingComponents.map((c) => c.id));

    // ── validate the draft BEFORE any write ──────────────────────────────
    for (const s of sections) {
      if (s.id !== undefined && !existingSectionIds.has(s.id)) {
        return invalid('unknown_section_id');
      }
    }
    const draftSectionRefs = new Set<string>();
    for (const s of sections) {
      if (s.id) draftSectionRefs.add(s.id);
      if (s.tempId) draftSectionRefs.add(s.tempId);
    }
    for (const line of lines) {
      if (line.sectionRef != null && !draftSectionRefs.has(line.sectionRef)) {
        return invalid('unknown_section_ref');
      }
      if (line.kind === 'ingredient') {
        if (line.id !== undefined && !existingLineIds.has(line.id)) {
          return invalid('unknown_line_id');
        }
      } else if (line.id !== undefined && !existingComponentIds.has(line.id)) {
        return invalid('unknown_line_id');
      }
    }

    const ingredientIds = [
      ...new Set(
        lines
          .filter((l) => l.kind === 'ingredient')
          .map((l) => (l as { ingredientId: string }).ingredientId),
      ),
    ];
    if (ingredientIds.length > 0) {
      const found = await db
        .select({ id: ingredients.id })
        .from(ingredients)
        .where(
          and(
            eq(ingredients.organizationId, organizationId),
            inArray(ingredients.id, ingredientIds),
            isNull(ingredients.deletedAt),
          ),
        );
      if (found.length !== ingredientIds.length) {
        return invalid('ingredient_unavailable');
      }
    }

    const componentLines = lines.filter((l) => l.kind === 'component') as
      Extract<WorkspaceLineDraft, { kind: 'component' }>[];
    const componentRecipeIds = componentLines.map((l) => l.componentRecipeId);
    // The DB keeps one component line per (parent, component) pair.
    if (new Set(componentRecipeIds).size !== componentRecipeIds.length) {
      return invalid('component_invalid');
    }
    if (componentRecipeIds.length > 0) {
      const found = await db
        .select({ id: recipes.id })
        .from(recipes)
        .where(
          and(
            eq(recipes.organizationId, organizationId),
            inArray(recipes.id, componentRecipeIds),
            isNull(recipes.deletedAt),
          ),
        );
      if (found.length !== new Set(componentRecipeIds).size) {
        return invalid('component_invalid');
      }
      for (const componentRecipeId of new Set(componentRecipeIds)) {
        const check = await assertNoRecipeComponentCycle(
          db,
          organizationId,
          recipeId,
          componentRecipeId,
        );
        if (!check.ok) return invalid('component_cycle');
      }
    }

    // ── apply: sections first (upsert + temp-id resolution) ─────────────
    const sectionIdByRef = new Map<string, string>();
    const keptSectionIds = new Set<string>();
    for (const [index, s] of sections.entries()) {
      if (s.id) {
        await db
          .update(recipeIngredientSections)
          .set({ title: s.title, sortOrder: index })
          .where(
            and(
              eq(recipeIngredientSections.organizationId, organizationId),
              eq(recipeIngredientSections.id, s.id),
            ),
          );
        sectionIdByRef.set(s.id, s.id);
        keptSectionIds.add(s.id);
      } else {
        const [insertedSection] = await db
          .insert(recipeIngredientSections)
          .values({
            organizationId,
            recipeId,
            title: s.title,
            sortOrder: index,
          })
          .returning({ id: recipeIngredientSections.id });
        if (s.tempId) sectionIdByRef.set(s.tempId, insertedSection!.id);
        keptSectionIds.add(insertedSection!.id);
      }
    }

    // ── lines: upsert with merged display order = array index ───────────
    const keptIngredientLineIds = new Set<string>();
    const keptComponentLineIds = new Set<string>();
    for (const [index, line] of lines.entries()) {
      const sectionId =
        line.sectionRef != null
          ? (sectionIdByRef.get(line.sectionRef) ?? null)
          : null;
      if (line.kind === 'ingredient') {
        if (line.id) {
          await db
            .update(recipeIngredients)
            .set({
              ingredientId: line.ingredientId,
              quantity: String(line.quantity),
              note: line.note ?? null,
              sectionId,
              displaySortOrder: index,
            })
            .where(
              and(
                eq(recipeIngredients.organizationId, organizationId),
                eq(recipeIngredients.id, line.id),
              ),
            );
          keptIngredientLineIds.add(line.id);
        } else {
          const [insertedLine] = await db
            .insert(recipeIngredients)
            .values({
              organizationId,
              recipeId,
              ingredientId: line.ingredientId,
              quantity: String(line.quantity),
              note: line.note ?? null,
              sectionId,
              displaySortOrder: index,
              sortOrder: index,
            })
            .returning({ id: recipeIngredients.id });
          keptIngredientLineIds.add(insertedLine!.id);
        }
      } else if (line.id) {
        await db
          .update(recipeComponents)
          .set({
            componentRecipeId: line.componentRecipeId,
            quantityGrams: line.quantityGrams,
            note: line.note ?? null,
            sectionId,
            displaySortOrder: index,
          })
          .where(
            and(
              eq(recipeComponents.organizationId, organizationId),
              eq(recipeComponents.id, line.id),
            ),
          );
        keptComponentLineIds.add(line.id);
      } else {
        const [insertedComponent] = await db
          .insert(recipeComponents)
          .values({
            organizationId,
            recipeId,
            componentRecipeId: line.componentRecipeId,
            quantityGrams: line.quantityGrams,
            note: line.note ?? null,
            sectionId,
            displaySortOrder: index,
            sortOrder: index,
          })
          .returning({ id: recipeComponents.id });
        keptComponentLineIds.add(insertedComponent!.id);
      }
    }

    // ── deletions: lines absent from the draft, then emptied sections ───
    const removedLineIds = [...existingLineIds].filter(
      (id) => !keptIngredientLineIds.has(id),
    );
    if (removedLineIds.length > 0) {
      await db
        .delete(recipeIngredients)
        .where(
          and(
            eq(recipeIngredients.organizationId, organizationId),
            inArray(recipeIngredients.id, removedLineIds),
          ),
        );
    }
    const removedComponentIds = [...existingComponentIds].filter(
      (id) => !keptComponentLineIds.has(id),
    );
    if (removedComponentIds.length > 0) {
      await db
        .delete(recipeComponents)
        .where(
          and(
            eq(recipeComponents.organizationId, organizationId),
            inArray(recipeComponents.id, removedComponentIds),
          ),
        );
    }
    const removedSectionIds = [...existingSectionIds].filter(
      (id) => !keptSectionIds.has(id),
    );
    if (removedSectionIds.length > 0) {
      await db
        .delete(recipeIngredientSections)
        .where(
          and(
            eq(recipeIngredientSections.organizationId, organizationId),
            inArray(recipeIngredientSections.id, removedSectionIds),
          ),
        );
    }

    changedAreas.push('structure');
  }

  const header = draft.header ?? {};
  const changedFields = Object.keys(header).filter(
    (k) => header[k as keyof RecipeWorkspaceHeaderDraft] !== undefined,
  );
  if (changedFields.length > 0) changedAreas.push('header');
  const newVersion = expectedVersion + 1;

  await db
    .update(recipes)
    .set({ ...header, version: newVersion })
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
      changedAreas,
      changedFields,
      sectionCount: draft.sections?.length,
      lineCount: draft.lines?.length,
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
