import { scaleLineQuantity } from '@/lib/calculations/recipeScale';
import type { KitchenScaleRecipeDocument } from '@/lib/kitchen-scale/prep-document';
import type { PrepCardBasisParam } from '@/lib/validation/kitchen-scale-print';
import type {
  RecipePrepCardBasis,
  RecipePrepCardData,
  RecipePrepCardLabels,
  RecipePrepCardLine,
} from './types';
import { buildSellerIdentity, type SellerSettings } from './seller';
import { formatDocumentQuantity } from './format';

/** A preset the basis caption can name, if the `?sel=` param references it. */
export type PrepCardPreset = { id: string; name: string; targetWeightGrams: number };

/**
 * Resolve the parsed (but not yet named) `?basis=` query param into the
 * printable {@link RecipePrepCardBasis}. Pure — never throws, never blocks the
 * scaling itself. A `basisParam` that no longer resolves (a hand-edited link, a
 * renamed/deleted preset, a removed ingredient line) falls back to the generic
 * `{ kind: 'factor' }` caption: the printed QUANTITIES stay exactly the applied
 * `factor` regardless, only the caption's wording degrades.
 */
export function resolvePrepCardBasis(
  factor: number,
  basisParam: PrepCardBasisParam | null,
  lines: readonly { id: string; name: string; dimension: 'weight' | 'volume' | 'count' }[],
  presets: readonly PrepCardPreset[],
): RecipePrepCardBasis {
  if (factor === 1 && basisParam === null) return { kind: 'original' };
  if (basisParam === null) return { kind: 'factor', factor };

  if (basisParam.kind === 'weight') {
    return { kind: 'weight', grams: basisParam.grams };
  }
  if (basisParam.kind === 'line') {
    const line = lines.find((l) => l.id === basisParam.lineId);
    if (!line) return { kind: 'factor', factor };
    return { kind: 'line', lineName: line.name, amount: basisParam.target, dimension: line.dimension };
  }

  const presetById = new Map(presets.map((p) => [p.id, p]));
  const selections: { name: string; quantity: number }[] = [];
  let totalGrams = basisParam.extraGrams;
  for (const sel of basisParam.selections) {
    const preset = presetById.get(sel.presetId);
    if (!preset) continue;
    selections.push({ name: preset.name, quantity: sel.quantity });
    totalGrams += preset.targetWeightGrams * sel.quantity;
  }
  if (selections.length === 0 && basisParam.extraGrams <= 0) {
    return { kind: 'factor', factor };
  }
  return { kind: 'preset', selections, totalGrams };
}

/**
 * Pure mapping from the money-free Kitchen Scale recipe document → the
 * prep-card view-model. No I/O. Applies `factor` to every line quantity ONCE,
 * from the ORIGINAL saved quantities (never a cumulative/chained scale), so the
 * printed figures always match the on-screen calculator exactly.
 */
export function buildRecipePrepCardData(
  doc: KitchenScaleRecipeDocument,
  settings: SellerSettings,
  /** Clerk organization name, used when `businessName` is blank. */
  orgNameFallback: string | null,
  factor: number,
  basisParam: PrepCardBasisParam | null,
  presets: readonly PrepCardPreset[],
): RecipePrepCardData {
  const lines: RecipePrepCardLine[] = doc.lines.map((l) => ({
    name: l.name,
    dimension: l.dimension,
    quantity: scaleLineQuantity(l.quantity, factor),
    isSubRecipe: l.isSubRecipe,
  }));

  const weightLines = lines.filter((l) => l.dimension === 'weight');
  const totalWeightGrams =
    weightLines.length > 0
      ? Math.round(weightLines.reduce((sum, l) => sum + l.quantity, 0) * 100) / 100
      : null;
  const expectedFinishedWeightGrams =
    totalWeightGrams !== null && doc.yieldPercentage !== 100
      ? Math.round(totalWeightGrams * (doc.yieldPercentage / 100) * 100) / 100
      : null;

  return {
    seller: buildSellerIdentity(settings, orgNameFallback),
    recipeName: doc.name,
    originalYieldPortions: doc.yieldPortions,
    originalYieldWeightGrams: doc.yieldWeightGrams,
    basis: resolvePrepCardBasis(factor, basisParam, doc.lines, presets),
    lines,
    totalWeightGrams,
    yieldPercentage: doc.yieldPercentage,
    expectedFinishedWeightGrams,
    method: doc.method,
    legacyNotes: doc.legacyNotes,
  };
}

/** Filename stem for a downloaded prep card. */
export function recipePrepCardFilename(recipeName: string): string {
  return `prep-${recipeName}`;
}

/**
 * The printed calculation-basis caption text ("Original recipe / ×1", "Target
 * weight: 3.5 kg", "45 × Individual portion + 4 × 18 cm cake — total 3,802.5 g"…),
 * shared by the PDF renderer and the HTML print page so they render identical
 * wording from the same `RecipePrepCardBasis`.
 */
export function basisCaption(
  basis: RecipePrepCardBasis,
  labels: RecipePrepCardLabels,
): string {
  if (basis.kind === 'original') return labels.basisOriginal;
  if (basis.kind === 'weight') {
    return labels.basisWeight(`${formatDocumentQuantity(basis.grams)} ${labels.units.weight}`);
  }
  if (basis.kind === 'line') {
    return labels.basisLine({
      name: basis.lineName,
      amount: `${formatDocumentQuantity(basis.amount)} ${labels.units[basis.dimension]}`,
    });
  }
  if (basis.kind === 'preset') {
    const summary = basis.selections
      .map((s) => labels.presetItem({ quantity: formatDocumentQuantity(s.quantity), name: s.name }))
      .join(' + ');
    return labels.basisPreset({
      summary,
      total: `${formatDocumentQuantity(basis.totalGrams)} ${labels.units.weight}`,
    });
  }
  return labels.basisFactor(formatDocumentQuantity(basis.factor));
}
