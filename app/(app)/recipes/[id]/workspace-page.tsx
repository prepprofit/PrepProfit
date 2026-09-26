import { notFound } from 'next/navigation';
import { and, eq, inArray } from 'drizzle-orm';
import { ingredients } from '@/lib/db/schema';
import { canSeeRecipeCosts, getUserRole } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { getRecipeWorkspace } from '@/lib/data/recipe-workspace';
import { listIngredients } from '@/lib/data/ingredients';
import { listComponentPickerRecipes } from '@/lib/data/recipe-components';
import { resolveRecipeCostTree } from '@/lib/data/recipe-cost-tree';
import { loadRecipeIngredientCostDetails } from '@/lib/data/recipe-cost-details';
import { costPerKgCents, recipeInputWeightGrams } from '@/lib/calculations/recipeCost';
import { loadRecipeFinishedWeights } from '@/lib/data/recipe-yield';
import { listRecipePresets } from '@/lib/data/recipe-presets';
import { listFolders } from '@/lib/data/recipe-folders';
import { AddToTaskListMenu } from '@/components/app/tasks/add-to-task-list-menu';
import { loadRecipeAllergenRollup } from '@/lib/data/allergens';
import { resolveRecipeNutritionTree } from '@/lib/data/recipe-nutrition-tree';
import { getProfilesForIngredients } from '@/lib/data/ingredient-nutrition';
import { toNutritionView } from '@/lib/nutrition/profile-view';
import { nutritionLabelRows } from '@/lib/calculations/nutritionLabel';
import type { NutritionTabData } from '@/components/app/recipes/workspace/recipe-nutrition-tab';
import { loadIngredientUomByIngredient } from '@/lib/data/ingredient-uom';
import { getOrgSettings } from '@/lib/data/org-settings';
import { getRecipeMediaStorage } from '@/lib/media/recipe-media-storage';
import { logError } from '@/lib/observability';
import { RecipeAllergenPanel } from '@/components/app/recipes/recipe-allergen-panel';
import {
  RecipeWorkspace,
  type WorkspaceClientData,
} from '@/components/app/recipes/workspace/recipe-workspace';
import type { DraftLine } from '@/components/app/recipes/workspace/recipe-input-list';
import type { UomTabItem } from '@/components/app/recipes/workspace/recipe-workspace-tabs';
import { dimensionOf, type Unit } from '@/lib/units';
import {
  missingAnchorsByIngredient,
  type UomAnchors,
} from '@/lib/calculations/uom';

const UNIT_LABEL: Record<'weight' | 'volume' | 'count', string> = {
  weight: 'g',
  volume: 'ml',
  count: 'pcs',
};

/**
 * Server side of the Recipes 2.0 workspace (plan §5): ONE DTO load, mapped to
 * the serializable client payload. Role separation happens HERE — the kitchen
 * DTO carries no financial keys, so `cost` ships as null and no price can
 * reach the client.
 */
export async function RecipeWorkspacePage({
  recipeId,
  organizationId,
}: {
  recipeId: string;
  organizationId: string;
}) {
  const role = await getUserRole();
  const workspaceRole = canSeeRecipeCosts(role) ? 'manager' : 'kitchen';

  const [dto, ingredientRows, pickerRecipes, allergenRollup, settings, presets, folders] =
    await Promise.all([
      withOrg(organizationId, (tx) =>
        getRecipeWorkspace(tx, organizationId, recipeId, workspaceRole),
      ),
      withOrg(organizationId, (tx) => listIngredients(tx, organizationId)),
      withOrg(organizationId, (tx) =>
        listComponentPickerRecipes(tx, organizationId, recipeId),
      ),
      withOrg(organizationId, (tx) =>
        loadRecipeAllergenRollup(tx, organizationId, recipeId),
      ),
      getOrgSettings(),
      withOrg(organizationId, (tx) => listRecipePresets(tx, organizationId, recipeId)),
      withOrg(organizationId, (tx) => listFolders(tx, organizationId)),
    ]);
  if (!dto) notFound();

  // Yield calculator inputs + the ONE finished-weight source used for cost per kg.
  const inputWeightGrams = recipeInputWeightGrams(
    dto.ingredientLines.map((l) => ({ dimension: l.ingredient.dimension, quantity: l.quantity })),
    dto.componentLines.map((l) => l.quantityGrams),
  );
  const finishedWeights = await withOrg(organizationId, (tx) =>
    loadRecipeFinishedWeights(tx, organizationId, [dto.recipe]),
  );
  const finishedWeightGrams = finishedWeights.get(dto.recipe.id) ?? null;

  // Merged visual sequence: ingredient + component lines by display order.
  type OrderedLine = DraftLine & { displaySortOrder: number };
  const ingredientLines: OrderedLine[] = dto.ingredientLines.map((l) => ({
    key: l.id,
    kind: 'ingredient' as const,
    id: l.id,
    ingredientId: l.ingredientId,
    name: l.ingredient.name,
    unitLabel: UNIT_LABEL[l.ingredient.dimension],
    dimension: l.ingredient.dimension,
    quantity: l.quantity,
    enteredQuantity: l.enteredQuantity,
    // Stored as text; writes only ever persist the lib/units Unit union.
    enteredUnit: (l.enteredUnit as Unit | null) ?? null,
    prepActionId: l.prepActionId,
    prepName: null,
    note: l.note ?? '',
    sectionRef: l.sectionId,
    displaySortOrder: l.displaySortOrder,
  }));
  const componentLines: OrderedLine[] = dto.componentLines.map((l) => ({
    key: l.id,
    kind: 'component' as const,
    id: l.id,
    componentRecipeId: l.componentRecipeId,
    name: l.componentRecipeName,
    quantityGrams: l.quantityGrams,
    note: l.note ?? '',
    sectionRef: l.sectionId,
    displaySortOrder: l.displaySortOrder,
  }));
  // Strip the sort key after ordering — the client model orders by position.
  const lines: DraftLine[] = [...ingredientLines, ...componentLines]
    .sort((a, b) => a.displaySortOrder - b.displaySortOrder)
    .map(({ displaySortOrder: _order, ...line }) => line as DraftLine);

  // Signed short-lived download URLs for READY media (cover + step photos).
  // Fail-soft: without blob credentials (e.g. local dev) the page renders
  // without media instead of crashing — media is never load-bearing.
  const readyMedia = dto.media.filter((m) => m.status === 'ready');
  const mediaById = new Map(readyMedia.map((m) => [m.id, m]));
  let mediaUrls = new Map<string, string>();
  if (readyMedia.length > 0) {
    try {
      const storage = getRecipeMediaStorage();
      const entries = await Promise.all(
        readyMedia.map(
          async (m) =>
            [
              m.id,
              await storage.createDownloadUrl(m.storageKey, {
                expiresMs: 15 * 60 * 1000,
              }),
            ] as const,
        ),
      );
      mediaUrls = new Map(entries);
    } catch (error) {
      logError({ action: 'recipeWorkspaceMediaUrls', orgId: organizationId }, error);
      mediaUrls = new Map();
    }
  }
  const mediaView = (mediaId: string) => {
    const media = mediaById.get(mediaId);
    if (!media) return null;
    return {
      mediaId,
      url: mediaUrls.get(mediaId) ?? null,
      kind: media.kind,
    };
  };

  // Method view: steps grouped under their section (default section = '').
  const stepsBySection = new Map<string | null, typeof dto.steps>();
  for (const step of dto.steps) {
    const list = stepsBySection.get(step.sectionId) ?? [];
    list.push(step);
    stepsBySection.set(step.sectionId, list);
  }
  const methodSections = [
    ...(stepsBySection.has(null)
      ? [
          {
            id: '__default',
            title: '',
            steps: (stepsBySection.get(null) ?? []).map((s) => ({
              id: s.id,
              instruction: s.instruction,
              media: s.media
                .map((link) => mediaView(link.mediaId))
                .filter((m) => m !== null),
            })),
          },
        ]
      : []),
    ...dto.methodSections.map((section) => ({
      id: section.id,
      title: section.title,
      steps: (stepsBySection.get(section.id) ?? []).map((s) => ({
        id: s.id,
        instruction: s.instruction,
        media: s.media
          .map((link) => mediaView(link.mediaId))
          .filter((m) => m !== null),
      })),
    })),
  ];

  // UoM tab (Fase 4): equivalency + prep state for the recipe's UNIQUE
  // ingredients, in first-appearance order. Operational — both roles get it.
  // `missingAnchorDimensions` is filled by the missing-equivalency pass once
  // entered units land on lines (Fase 4 slice 6).
  const uomIngredientIds = [...new Set(dto.ingredientLines.map((l) => l.ingredientId))];
  const uomByIngredient = await withOrg(organizationId, (tx) =>
    loadIngredientUomByIngredient(tx, organizationId, uomIngredientIds),
  );
  const ingredientNameById = new Map(
    dto.ingredientLines.map((l) => [l.ingredientId, l.ingredient]),
  );
  // For each ingredient, the anchor dimensions its OWN lines still can't
  // convert to weight (§7.2): a line entered in ml/each whose equivalency (or
  // the line's prep override) lacks a required anchor. This is the actionable
  // "add a weight anchor" signal — never a silent unconvertible line.
  const prepAnchorsById = new Map<string, UomAnchors>();
  for (const state of uomByIngredient.values()) {
    for (const p of state.prepActions) {
      prepAnchorsById.set(p.id, {
        weightGrams: p.weightGrams,
        volumeMl: p.volumeMl,
        eachCount: p.eachCount,
      });
    }
  }
  const missingByIngredient = missingAnchorsByIngredient(
    dto.ingredientLines.map((line) => {
      const equivalency = uomByIngredient.get(line.ingredientId)?.equivalency ?? null;
      return {
        ingredientId: line.ingredientId,
        targetDimension: line.ingredient.dimension,
        enteredDimension:
          line.enteredUnit != null ? dimensionOf(line.enteredUnit as Unit) : null,
        baseAnchors: equivalency
          ? {
              weightGrams: equivalency.weightGrams,
              volumeMl: equivalency.volumeMl,
              eachCount: equivalency.eachCount,
            }
          : null,
        prepAnchors:
          line.prepActionId != null
            ? (prepAnchorsById.get(line.prepActionId) ?? null)
            : null,
      };
    }),
  );

  const uom: UomTabItem[] = uomIngredientIds.map((ingredientId) => {
    const state = uomByIngredient.get(ingredientId);
    const ingredient = ingredientNameById.get(ingredientId)!;
    return {
      ingredientId,
      name: ingredient.name,
      dimension: ingredient.dimension,
      equivalency: state?.equivalency
        ? {
            weightGrams: state.equivalency.weightGrams,
            volumeMl: state.equivalency.volumeMl,
            eachCount: state.equivalency.eachCount,
            source: state.equivalency.source,
          }
        : null,
      prepActions: (state?.prepActions ?? []).map((p) => ({
        id: p.id,
        name: p.name,
        yieldBps: p.yieldBps,
        weightGrams: p.weightGrams,
        volumeMl: p.volumeMl,
        eachCount: p.eachCount,
        sortOrder: p.sortOrder,
      })),
      missingAnchorDimensions: missingByIngredient.get(ingredientId) ?? [],
    };
  });

  // Resolve display-only prep names onto the view lines.
  const prepNameById = new Map<string, string>();
  for (const item of uom) {
    for (const p of item.prepActions) prepNameById.set(p.id, p.name);
  }
  for (const line of lines) {
    if (line.kind === 'ingredient' && line.prepActionId) {
      line.prepName = prepNameById.get(line.prepActionId) ?? null;
    }
  }

  // Nutrition tab payload (Fase 6, §9.6) — OPERATIONAL, both roles see it;
  // editing is manager-only (D5). All math is server-side: the client receives
  // pre-rounded label rows and provenance, never re-derives nutrition.
  const nutritionMap = await withOrg(organizationId, (tx) =>
    resolveRecipeNutritionTree(tx, organizationId, [recipeId]),
  );
  const nutritionRes = nutritionMap.get(recipeId);
  // Seed-catalogue USDA suggestion hints (plan D3): one batch lookup of
  // suggested_fdc_id for the lines still missing a profile — a HINT only, the
  // save path re-fetches USDA server-side as always.
  const lineIngredientIds = [
    ...new Set((nutritionRes?.lines ?? []).map((l) => l.ingredientId)),
  ];
  const suggestedRows = lineIngredientIds.length
    ? await withOrg(organizationId, (tx) =>
        tx
          .select({
            id: ingredients.id,
            suggestedFdcId: ingredients.suggestedFdcId,
          })
          .from(ingredients)
          .where(
            and(
              eq(ingredients.organizationId, organizationId),
              inArray(ingredients.id, lineIngredientIds),
            ),
          ),
      )
    : [];
  const suggestedByIngredient = new Map(
    suggestedRows.map((r) => [r.id, r.suggestedFdcId]),
  );
  // The ingredient-owned profiles, as the shared editor's view (one batch read).
  const profileRows = await withOrg(organizationId, (tx) =>
    getProfilesForIngredients(tx, organizationId, lineIngredientIds),
  );
  const nutrition: NutritionTabData = {
    status: nutritionRes?.result.status ?? 'incomplete',
    issues: nutritionRes?.result.issues ?? [],
    rows: nutritionRes?.result.perServing
      ? nutritionLabelRows(nutritionRes.result.perServing).map((r) => ({
          key: r.key,
          rounded: r.rounded,
          lessThan: r.lessThan,
          dvPercent: r.dvPercent,
        }))
      : null,
    servingGrams: nutritionRes?.servingGrams ?? null,
    lines: (nutritionRes?.lines ?? []).map((l) => {
      const profile = profileRows.get(l.ingredientId);
      return {
        ingredientId: l.ingredientId,
        ingredientName: l.ingredientName,
        edibleWeightGrams: l.edibleWeightGrams,
        suggestedFdcId: suggestedByIngredient.get(l.ingredientId) ?? null,
        profile: profile ? toNutritionView(profile) : null,
      };
    }),
    allergens: {
      contains: allergenRollup.allergens
        .filter((a) => a.effectivePresence === 'contains')
        .map((a) => a.allergen),
      mayContain: allergenRollup.allergens
        .filter((a) => a.effectivePresence === 'may_contain')
        .map((a) => a.allergen),
    },
    canEdit: workspaceRole === 'manager',
  };

  // Manager-only costs from the shared resolver (kitchen: null): the line cost beside
  // each ingredient, cost per batch and cost per kg — nothing per serving/portion.
  let cost: WorkspaceClientData['cost'] = null;
  if (dto.role === 'manager') {
    const [resolutionMap, lineDetails] = await withOrg(organizationId, async (tx) =>
      Promise.all([
        resolveRecipeCostTree(tx, organizationId, [recipeId]),
        loadRecipeIngredientCostDetails(tx, organizationId, recipeId),
      ]),
    );
    const resolution = resolutionMap.get(recipeId);
    const lineCosts: Record<string, number | null> = {};
    const unpricedLineKeys: string[] = [];
    for (const d of lineDetails) {
      lineCosts[d.lineId] = d.needsPricing ? null : d.lineCostCents;
      if (d.needsPricing) unpricedLineKeys.push(d.lineId);
    }
    if (resolution?.complete) {
      for (const l of dto.componentLines) {
        lineCosts[l.id] = resolution.componentLineCostsCents.get(l.id) ?? null;
      }
    }
    // Labour / energy saved by the retired editor stay inside the batch cost until
    // the manager removes them — shown for review, never hidden or double-counted.
    const legacy = {
      labourCents: dto.recipe.laborCostCents,
      energyCents: dto.recipe.energyCostCents,
    };
    cost =
      resolution?.complete && unpricedLineKeys.length === 0
        ? {
            complete: true,
            batchCostCents: resolution.cost.totalCostCents,
            costPerKgCents: costPerKgCents(resolution.cost.totalCostCents, finishedWeightGrams),
            lineCosts,
            legacy,
          }
        : { complete: false, lineCosts, unpricedLineKeys, legacy };
  }

  const data: WorkspaceClientData = {
    recipe: {
      id: dto.recipe.id,
      name: dto.recipe.name,
      subtitle: dto.recipe.subtitle,
      version: dto.recipe.version,
      yieldQuantity: dto.recipe.yieldQuantity,
      yieldUnit: dto.recipe.yieldUnit,
      yieldPortions: dto.recipe.yieldPortions,
      yieldWeightGrams: dto.recipe.yieldWeightGrams,
      yieldPercentage: dto.recipe.yieldPercentage,
      yieldWeightSource: dto.recipe.yieldWeightSource,
      yieldReviewNeeded: dto.recipe.yieldReviewNeeded,
      inputWeightGrams,
      finishedWeightGrams,
      folderId: dto.recipe.folderId,
      displayUnit: dto.recipe.displayUnit,
      notes: dto.recipe.notes,
      coverMediaId: dto.recipe.coverMediaId,
      coverUrl: dto.recipe.coverMediaId
        ? (mediaUrls.get(dto.recipe.coverMediaId) ?? null)
        : null,
    },
    sections: dto.ingredientSections.map((s) => ({
      ref: s.id,
      id: s.id,
      title: s.title,
    })),
    lines,
    methodSections,
    methodDraftSections: dto.methodSections.map((s) => ({
      ref: s.id,
      id: s.id,
      title: s.title,
    })),
    methodDraftSteps: dto.steps.map((s) => ({
      key: s.id,
      id: s.id,
      instruction: s.instruction,
      sectionRef: s.sectionId,
      media: s.media
        .map((link) => {
          const view = mediaView(link.mediaId);
          return view ? { mediaId: view.mediaId, url: view.url } : null;
        })
        .filter((m) => m !== null),
    })),
    books: dto.books,
    ingredientOptions: ingredientRows.map((i) => ({
      id: i.id,
      name: i.name,
      dimension: i.dimension,
    })),
    componentOptions: pickerRecipes
      .filter((p) => p.selectable)
      .map((p) => ({ id: p.id, name: p.name })),
    cost,
    currency: settings.currency,
    measurementSystem: settings.measurementSystem,
    presets: presets.map((p) => ({
      id: p.id,
      name: p.name,
      targetWeightGrams: p.targetWeightGrams,
      sortOrder: p.sortOrder,
    })),
    uom,
    nutrition,
    folders: folders.map((f) => ({ id: f.id, name: f.name, parentId: f.parentId })),
  };

  return (
    <div className="flex w-full flex-col gap-6">
      {/* Allergens are OPERATIONAL (both roles) and render below the recipe, like
          every supporting section. */}
      <RecipeWorkspace
        data={data}
        allergenPanel={
          <RecipeAllergenPanel recipeId={recipeId} initialRollup={allergenRollup} />
        }
        taskMenu={<AddToTaskListMenu kind="prep" sourceId={recipeId} />}
      />
    </div>
  );
}
