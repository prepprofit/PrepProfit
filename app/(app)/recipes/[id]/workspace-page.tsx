import { notFound } from 'next/navigation';
import { canSeeRecipeCosts, getUserRole } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { getRecipeWorkspace } from '@/lib/data/recipe-workspace';
import { listIngredients } from '@/lib/data/ingredients';
import { listComponentPickerRecipes } from '@/lib/data/recipe-components';
import { resolveRecipeCostTree } from '@/lib/data/recipe-cost-tree';
import { loadRecipeAllergenRollup } from '@/lib/data/allergens';
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
import type { UomTabItem } from '@/components/app/recipes/workspace/recipe-uom-tab';
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

  const [dto, ingredientRows, pickerRecipes, allergenRollup, settings] =
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
    ]);
  if (!dto) notFound();

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

  // Manager-only cost summary from the shared resolver (kitchen: null).
  let cost: WorkspaceClientData['cost'] = null;
  if (dto.role === 'manager') {
    const resolution = (
      await withOrg(organizationId, (tx) =>
        resolveRecipeCostTree(tx, organizationId, [recipeId]),
      )
    ).get(recipeId);
    cost = resolution?.complete
      ? { complete: true, cost: resolution.cost }
      : { complete: false };
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
    uom,
  };

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <RecipeWorkspace data={data} />
      {/* Allergens stay OPERATIONAL and shared with the legacy page. */}
      <RecipeAllergenPanel recipeId={recipeId} initialRollup={allergenRollup} />
    </div>
  );
}
