import type {
  ProfitLeakFinding,
  ProfitLeakFindingType,
} from './profit-leaks';

/**
 * Profit-leak explanation facts — the compact, structured input the AI explainer
 * receives (Sprint 4, AI margin roadmap).
 *
 * The whole safety contract of Sprint 4 (CLAUDE.md §AI, plan §9): the model NEVER
 * calculates money. It only *explains* numbers PrepProfit already computed
 * deterministically. So this pure module distills a {@link ProfitLeakFinding} — itself
 * produced by the tested `detectProfitLeaks` engine — into a small, honest fact set.
 * No DB rows, no full records, no free-form prose: just the finding's own fields plus
 * optional named price drivers the caller assembled.
 *
 * Honesty rules carried over from the detector:
 *   - A null margin/cost on the finding (e.g. an unpriced ingredient) stays null here.
 *     We never invent a margin so the model can't "explain" a fabricated number.
 *   - Money is integer cents throughout.
 */

/** One ingredient whose price move drives a margin finding. Optional context. */
export type ExplanationDriver = {
  name: string;
  /** Percentage change in the ingredient's price (positive = rose). Rounded to 1dp. */
  priceChangePercent: number;
};

/**
 * The exact payload sent to the model. Deliberately compact and schema-shaped (plan
 * §9 example): only descriptors + already-computed figures, never DB records or PII.
 */
export type ExplanationFacts = {
  findingType: ProfitLeakFindingType;
  entityType: ProfitLeakFinding['entityType'];
  entityName: string;
  currentMarginPercent: number | null;
  targetMarginPercent: number | null;
  currentCostCents: number | null;
  pendingCostCents: number | null;
  suggestedPriceCents: number | null;
  /** How many active recipes/menus this finding touches (0 for entity-scoped ones). */
  affectedCount: number;
  /** Named price drivers, when the caller has them; empty otherwise (never invented). */
  mainDrivers: ExplanationDriver[];
};

/**
 * Distill a deterministic finding into the model's fact input. Pure and self-contained:
 * every figure comes straight off the finding (so it is exactly what PrepProfit already
 * showed the manager), and `mainDrivers` is passed through untouched — this function
 * never derives or fabricates a price. Defaults to no drivers.
 */
export function buildExplanationFacts(
  finding: ProfitLeakFinding,
  drivers: ExplanationDriver[] = [],
): ExplanationFacts {
  return {
    findingType: finding.type,
    entityType: finding.entityType,
    entityName: finding.entityName,
    currentMarginPercent: finding.currentMarginPercent,
    targetMarginPercent: finding.targetMarginPercent,
    currentCostCents: finding.currentCostCents,
    pendingCostCents: finding.pendingCostCents,
    suggestedPriceCents: finding.suggestedPriceCents,
    affectedCount: finding.affectedEntityIds.length,
    mainDrivers: drivers,
  };
}
