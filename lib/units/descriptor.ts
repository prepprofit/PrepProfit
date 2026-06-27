import { type Unit } from './index';
import { parseUnitToken } from './token';

/**
 * Recipe-line unit resolution that distinguishes TRUE measurable units from package
 * DESCRIPTORS (Sprint 4.7 improvement, RC-1/§5.2). The deterministic spreadsheet
 * import keeps using {@link parseUnitToken} (a recipe column is either a known unit
 * or an error); photo extraction needs the richer three-way result because a chef
 * writes "1 pkt walnuts" or "3 cloves garlic" — tokens that are entry descriptors,
 * not physical units.
 *
 * The three outcomes:
 *  - `canonical`: a real unit (`g`, `cup`, `tsp`, …) → canonicalize the quantity now.
 *  - `descriptor`: a package/count word (`pkt`, `block`, `clove`, `sheet`, …) → keep
 *    the line VISIBLE for review (never dropped). It canonicalizes only from a
 *    package size (`1 pkt (300 g)`) or stays `needs_review`; the original token is
 *    preserved so the UI can show "3 cloves", not a bare "3".
 *  - `unknown`: anything else → `INVALID_UNIT`, but the caller STILL keeps the line
 *    visible as `needs_review` (G1: no silent data loss).
 *
 * Pure and dependency-free, so it is fully unit-testable from fixtures.
 */
export type RecipeUnitParseResult =
  | { kind: 'canonical'; unit: Unit }
  | { kind: 'descriptor'; descriptor: string; impliedDimension: 'count' }
  | { kind: 'unknown'; code: 'INVALID_UNIT' };

/**
 * Package/entry descriptor tokens (normalized: lowercased, whitespace-stripped).
 * These are NOT physical units — they imply a countable pack/piece and must never
 * be coerced into canonical `count`, which would mis-cost weight/volume ingredients.
 */
const DESCRIPTORS = new Set<string>([
  'pkt', 'packet', 'packets', 'pack', 'packs',
  'bag', 'bags', 'sack', 'sacks',
  'box', 'boxes', 'carton', 'cartons',
  'block', 'blocks', 'bar', 'bars',
  'can', 'cans', 'tin', 'tins', 'jar', 'jars', 'bottle', 'bottles', 'tub', 'tubs',
  'bunch', 'bunches', 'stalk', 'stalks', 'sprig', 'sprigs', 'stem', 'stems',
  'clove', 'cloves', 'head', 'heads', 'bulb', 'bulbs',
  'slice', 'slices', 'sheet', 'sheets', 'leaf', 'leaves', 'strip', 'strips',
  'stick', 'sticks', 'knob', 'knobs', 'cube', 'cubes',
  'pinch', 'pinches', 'dash', 'dashes', 'drop', 'drops', 'splash', 'splashes',
  'handful', 'handfuls', 'glug', 'glugs',
]);

/** Lower/trim a token for descriptor lookup (mirrors `parseUnitToken`'s normalization). */
const normalizeToken = (raw: string): string =>
  raw.trim().toLowerCase().replace(/\s+/g, '');

/**
 * Resolve a recipe-line unit token to a canonical unit, a known descriptor, or an
 * unknown token. A blank token is `count` (a bare "6 eggs"), matching the parser.
 */
export function parseRecipeUnit(raw: string): RecipeUnitParseResult {
  const parsed = parseUnitToken(raw);
  if ('unit' in parsed) return { kind: 'canonical', unit: parsed.unit };

  if (DESCRIPTORS.has(normalizeToken(raw))) {
    // Preserve a readable token for the review UI (e.g. "cloves", not "cloves ").
    return { kind: 'descriptor', descriptor: raw.trim().toLowerCase(), impliedDimension: 'count' };
  }

  return { kind: 'unknown', code: 'INVALID_UNIT' };
}
