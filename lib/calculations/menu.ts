import {
  ALLERGEN_ORDER,
  type AllergenSlug,
  type Presence,
} from '@/lib/allergens/catalog';
import { maxPresence } from '@/lib/calculations/allergens';
import type { RecipeAllergenRollup } from '@/lib/calculations/allergens';

/**
 * Dish allergen aggregation. Pure, no I/O. Dish COST lives in
 * `lib/calculations/dish.ts`; this module only rolls allergens up across a dish's
 * components.
 */

/** One allergen on a menu: the strongest presence across all component recipes. */
export type MenuAllergen = {
  allergen: AllergenSlug;
  presence: Presence;
};

/**
 * A menu's rolled-up allergens. The union of every component recipe's effective
 * allergens at their MAX presence, plus an OR of the components' unreviewed flags.
 * NEVER implies "allergen-free"; a trashed-but-retained component still contributes
 * (the caller must pass that recipe's rollup in).
 */
export type MenuAllergenRollup = {
  allergens: MenuAllergen[];
  hasUnreviewedIngredient: boolean;
};

/**
 * Merge component-recipe rollups into one menu rollup (pure). Union by allergen
 * keeping the strongest effective presence, sorted by the fixed catalog order so
 * UI/PDF are deterministic; `hasUnreviewedIngredient` is the OR across components.
 */
export function mergeMenuAllergens(
  rollups: RecipeAllergenRollup[],
): MenuAllergenRollup {
  const byAllergen = new Map<AllergenSlug, Presence>();
  let hasUnreviewedIngredient = false;

  for (const rollup of rollups) {
    if (rollup.hasUnreviewedIngredient) hasUnreviewedIngredient = true;
    for (const a of rollup.allergens) {
      const current = byAllergen.get(a.allergen);
      byAllergen.set(
        a.allergen,
        current ? maxPresence(current, a.effectivePresence) : a.effectivePresence,
      );
    }
  }

  const allergens: MenuAllergen[] = [...byAllergen.entries()]
    .map(([allergen, presence]) => ({ allergen, presence }))
    .sort((x, y) => ALLERGEN_ORDER[x.allergen] - ALLERGEN_ORDER[y.allergen]);

  return { allergens, hasUnreviewedIngredient };
}
