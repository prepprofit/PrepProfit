import {
  ALLERGEN_ORDER,
  PRESENCE_ORDER,
  type AllergenSlug,
  type Presence,
} from '@/lib/allergens/catalog';

/**
 * Recipe allergen rollup — derive-on-read, mirroring `recipeCost` (no I/O, no
 * stored result). A recipe's allergens are computed live from its ingredients'
 * allergen tags plus the recipe's own overrides, so editing an ingredient's
 * allergens reflects on every recipe the next read.
 *
 * SAFETY DIRECTION IS THE WHOLE POINT (Sprint 9 §10):
 *  - An override can only ADD or ESCALATE: `effective = max(derived, override)`,
 *    so `effective >= derived` ALWAYS. This guarantee comes from `max()` at read
 *    time + the action guard (lib/data/allergens.ts), NOT "by construction" — the
 *    DB never stores the derived rollup.
 *  - Derived and override are returned SEPARATELY (never a single `source` flag),
 *    so the UI can show provenance ("from ingredients" vs "added on this recipe").
 *  - Callers MUST include ALL referenced ingredients regardless of `deleted_at`
 *    (mirror the recipe-cost ingredient join): a trashed ingredient must never
 *    silently drop an allergen.
 *  - Results are sorted by the fixed catalog order so UI/PDF are deterministic.
 */

/** One ingredient line's allergen tags, as fed to the rollup. */
export type AllergenLine = {
  /** Whether THIS line's ingredient has had its allergens reviewed (provenance). */
  reviewed: boolean;
  allergens: { allergen: AllergenSlug; presence: Presence }[];
};

/** A recipe-level add/escalate override. */
export type AllergenOverride = { allergen: AllergenSlug; presence: Presence };

/** One allergen on a recipe, keeping derived and override presence separate. */
export type RecipeAllergen = {
  allergen: AllergenSlug;
  /** Strongest presence contributed by the ingredients, or null if none. */
  derivedPresence: Presence | null;
  /** Recipe-level added/escalated presence, or null if no override row. */
  overridePresence: Presence | null;
  /** What the kitchen acts on: `max(derived, override)`. Never below derived. */
  effectivePresence: Presence;
};

export type RecipeAllergenRollup = {
  allergens: RecipeAllergen[];
  /**
   * True when at least one referenced ingredient has NOT had its allergens
   * reviewed — the recipe warns the kitchen. NEVER implies "allergen-free".
   */
  hasUnreviewedIngredient: boolean;
};

/** Compare two presence levels (negative if a < b). */
export function comparePresence(a: Presence, b: Presence): number {
  return PRESENCE_ORDER[a] - PRESENCE_ORDER[b];
}

/** The stronger of two presence levels (`contains` beats `may_contain`). */
export function maxPresence(a: Presence, b: Presence): Presence {
  return comparePresence(a, b) >= 0 ? a : b;
}

/** Combine a possibly-null presence with another, taking the stronger. */
function combine(current: Presence | null, next: Presence): Presence {
  return current === null ? next : maxPresence(current, next);
}

/**
 * Roll up the allergens of a recipe from its ingredient lines and its overrides.
 * Returns one entry per allergen present anywhere, sorted by catalog order, with
 * derived/override/effective kept separate and the invariant `effective >= derived`.
 */
export function recipeAllergens(
  lines: AllergenLine[],
  overrides: AllergenOverride[],
  /**
   * Effective rollups of the recipe's sub-recipe components (sub-recipes plan).
   * Inherited allergens count as DERIVED: they feed the same max() and the same
   * no-downgrade guarantee, so a parent override can never suppress a component
   * allergen. A component subtree's unreviewed flag bubbles up.
   */
  inheritedComponentRollups: RecipeAllergenRollup[] = [],
): RecipeAllergenRollup {
  // Accumulate the strongest derived presence per allergen across all lines.
  const derived = new Map<AllergenSlug, Presence>();
  for (const line of lines) {
    for (const tag of line.allergens) {
      derived.set(tag.allergen, combine(derived.get(tag.allergen) ?? null, tag.presence));
    }
  }
  // Component EFFECTIVE presences (their own overrides included) join as derived.
  for (const rollup of inheritedComponentRollups) {
    for (const entry of rollup.allergens) {
      derived.set(
        entry.allergen,
        combine(derived.get(entry.allergen) ?? null, entry.effectivePresence),
      );
    }
  }

  // Accumulate overrides (an allergen could in theory appear twice — take the max).
  const override = new Map<AllergenSlug, Presence>();
  for (const o of overrides) {
    override.set(o.allergen, combine(override.get(o.allergen) ?? null, o.presence));
  }

  const slugs = new Set<AllergenSlug>([...derived.keys(), ...override.keys()]);

  const allergens: RecipeAllergen[] = [...slugs]
    .map((allergen) => {
      const derivedPresence = derived.get(allergen) ?? null;
      const overridePresence = override.get(allergen) ?? null;
      // effective = max(derived, override); at least one is non-null here.
      let effectivePresence: Presence;
      if (derivedPresence !== null && overridePresence !== null) {
        effectivePresence = maxPresence(derivedPresence, overridePresence);
      } else {
        effectivePresence = (derivedPresence ?? overridePresence) as Presence;
      }
      return { allergen, derivedPresence, overridePresence, effectivePresence };
    })
    .sort((a, b) => ALLERGEN_ORDER[a.allergen] - ALLERGEN_ORDER[b.allergen]);

  return {
    allergens,
    hasUnreviewedIngredient:
      lines.some((line) => !line.reviewed) ||
      inheritedComponentRollups.some((r) => r.hasUnreviewedIngredient),
  };
}
