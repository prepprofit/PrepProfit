import { normalizeIngredientName } from '@/lib/import/resolveIngredient';
import { parseRecipeUnit } from '@/lib/units/descriptor';
import type { PhotoDraftLine, PhotoExtractionDraft } from '@/lib/ai/types';

/**
 * Pure, deterministic scoring for the AI photo-extraction eval harness
 * (improvement plan Phase 5 / §9). Given a SANITIZED golden ({@link ExpectedRecipe})
 * and the {@link PhotoExtractionDraft} the mapper produced from a real provider call,
 * it computes the launch metrics (§9.1) and checks them against the launch thresholds
 * (§9.3 / gate G5).
 *
 * No DB, no SDK, no network, no image bytes — only the golden's text and the produced
 * draft, so it is fully unit-testable from fixtures and safe to run in CI. The live
 * runner (`scripts/eval-extraction.ts`) calls the provider, maps to a draft, then
 * feeds the draft here.
 *
 * Matching is by normalized ingredient name (with optional golden-side `aliases` for
 * the names a model legitimately varies, e.g. "phyllo" vs "filo"). Each expected line
 * pairs with at most one draft line and vice versa, so a duplicate can never inflate
 * recall.
 */

/* -------------------------------------------------------------------------- */
/* Golden (expected) shape — sanitized, committed, image-free.                */
/* -------------------------------------------------------------------------- */

/** What the draft SHOULD classify a line as. `ignored` = a crossed-out source line. */
export type ExpectedLineStatus = 'ready' | 'needs_review' | 'ignored';

/**
 * One expected ingredient line in a golden fixture. `ignored` lines (a struck-through
 * source line) are NOT counted in the recall denominators — they are "active expected
 * lines" exclusions — but are still checked for correct `ignored` classification.
 */
export type ExpectedLine = {
  name: string;
  /** Alternate names the model may legitimately produce (matched, normalized). */
  aliases?: string[];
  section: string | null;
  /** The expected parsed numeric quantity, or null for a genuinely quantity-less line. */
  quantityValue: number | null;
  /** The expected raw unit/descriptor token (`g`, `tbsp`, `pkt`), or null. */
  unitToken: string | null;
  expectedStatus: ExpectedLineStatus;
};

export type ExpectedRecipe = {
  /** Stable fixture slug (also the image basename in `eval/extraction/images/`). */
  slug: string;
  name: string;
  /** Coarse provenance, for slicing the report (handwritten/printed/…); free text. */
  category?: string;
  language?: string;
  yieldPortions: number | null;
  lines: ExpectedLine[];
};

/* -------------------------------------------------------------------------- */
/* Raw counts — aggregated by micro-average so multi-fixture rates are honest. */
/* -------------------------------------------------------------------------- */

export type FieldCounts = { correct: number; total: number };

/**
 * The additive counts a single scored draft contributes. Rates are derived from the
 * SUM of these across fixtures ({@link aggregate}), never an average of per-fixture
 * rates — a 2-line recipe must not weigh the same as a 20-line one.
 */
export type EvalCounts = {
  /** Active expected lines (expectedStatus !== 'ignored') — recall denominator. */
  expectedActive: number;
  /** Active expected lines paired to ANY draft line — line-recall numerator. */
  visible: number;
  /** Active expected lines paired to a ready|needs_review draft line. */
  correctable: number;
  /** Active expected lines with NO matching draft line at all (must be 0). */
  silentLoss: number;
  /** Active draft lines (status !== 'ignored') classified `ready`. */
  readyTotal: number;
  /** Ready draft lines paired to an expected line with every field correct. */
  readyCorrect: number;
  /** Active draft lines (status !== 'ignored') — hallucination denominator. */
  activeDraftLines: number;
  /** Active draft lines paired to NO expected line — hallucination numerator. */
  hallucinated: number;
  /** Expected `ignored` lines, and how many the draft correctly classified ignored. */
  expectedIgnored: number;
  ignoredCorrect: number;
  /** Per-field correctness over PAIRED lines (diagnostics, not a launch gate). */
  fields: { name: FieldCounts; quantity: FieldCounts; unit: FieldCounts; section: FieldCounts };
};

/** Per-line outcome, for the runner's human-readable table (not used in aggregation). */
export type LineOutcome = {
  expectedName: string;
  matched: boolean;
  draftStatus: PhotoDraftLine['status'] | null;
  expectedStatus: ExpectedLineStatus;
  fieldErrors: Array<'quantity' | 'unit' | 'section'>;
};

export type EvalScore = {
  slug: string;
  counts: EvalCounts;
  lines: LineOutcome[];
  /** Active draft lines that matched no expected line (the hallucinated names). */
  hallucinatedNames: string[];
};

/* -------------------------------------------------------------------------- */
/* Field comparison helpers.                                                  */
/* -------------------------------------------------------------------------- */

const isBlank = (s: string | null | undefined): boolean => s == null || s.trim() === '';

/** Quantities are equal up to a small relative tolerance; null == null. */
function quantityEqual(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
}

/**
 * Unit tokens are compared SEMANTICALLY, not by raw string: `cup`/`cups` and any
 * canonical synonyms collapse to the same unit; two descriptors compare by descriptor;
 * unknown tokens fall back to a normalized string compare. Blank == blank.
 */
function unitEqual(a: string | null, b: string | null): boolean {
  if (isBlank(a) && isBlank(b)) return true;
  if (isBlank(a) || isBlank(b)) return false;
  const pa = parseRecipeUnit(a!);
  const pb = parseRecipeUnit(b!);
  if (pa.kind !== pb.kind) return false;
  if (pa.kind === 'canonical' && pb.kind === 'canonical') return pa.unit === pb.unit;
  if (pa.kind === 'descriptor' && pb.kind === 'descriptor') return pa.descriptor === pb.descriptor;
  return a!.trim().toLowerCase() === b!.trim().toLowerCase();
}

/** Section labels compare case-insensitively; blank/null are the same "no section". */
function sectionEqual(a: string | null, b: string | null): boolean {
  if (isBlank(a) && isBlank(b)) return true;
  if (isBlank(a) || isBlank(b)) return false;
  return a!.trim().toLowerCase() === b!.trim().toLowerCase();
}

/** Every normalized name an expected line can match (its name plus any aliases). */
function expectedKeys(line: ExpectedLine): string[] {
  return [line.name, ...(line.aliases ?? [])]
    .map(normalizeIngredientName)
    .filter((k) => k !== '');
}

/* -------------------------------------------------------------------------- */
/* Scoring.                                                                   */
/* -------------------------------------------------------------------------- */

const emptyFields = (): EvalCounts['fields'] => ({
  name: { correct: 0, total: 0 },
  quantity: { correct: 0, total: 0 },
  unit: { correct: 0, total: 0 },
  section: { correct: 0, total: 0 },
});

/**
 * Score one produced draft against its golden. Greedy 1:1 name matching: each draft
 * line is consumed by the first expected line that claims its normalized name, so a
 * model emitting a duplicate cannot be counted twice.
 */
export function scoreDraft(expected: ExpectedRecipe, draft: PhotoExtractionDraft): EvalScore {
  const counts: EvalCounts = {
    expectedActive: 0,
    visible: 0,
    correctable: 0,
    silentLoss: 0,
    readyTotal: 0,
    readyCorrect: 0,
    activeDraftLines: 0,
    hallucinated: 0,
    expectedIgnored: 0,
    ignoredCorrect: 0,
    fields: emptyFields(),
  };

  // Index draft lines by normalized name; each is consumable at most once. When an
  // ingredient legitimately repeats across sections (e.g. sugar in both Filling and
  // Syrup, or a crossed-out duplicate), a same-section match is preferred before a
  // name-only fallback so the two expected lines pair to the right draft lines.
  const draftLines = draft.recipe.lines;
  const consumed = new Set<number>();
  const findDraftLine = (keys: string[], section: string | null): number => {
    let nameOnly = -1;
    for (let i = 0; i < draftLines.length; i++) {
      if (consumed.has(i)) continue;
      if (!keys.includes(normalizeIngredientName(draftLines[i]!.ingredientName))) continue;
      if (sectionEqual(draftLines[i]!.section, section)) return i;
      if (nameOnly === -1) nameOnly = i;
    }
    return nameOnly;
  };

  const lines: LineOutcome[] = [];
  // The expected line each draft index actually paired with — reused for ready
  // accuracy / hallucination so a repeated name is scored against the RIGHT line.
  const pairedExpected = new Map<number, ExpectedLine>();

  for (const exp of expected.lines) {
    const idx = findDraftLine(expectedKeys(exp), exp.section);
    const match = idx >= 0 ? draftLines[idx]! : null;
    if (idx >= 0) {
      consumed.add(idx);
      pairedExpected.set(idx, exp);
    }

    const isActive = exp.expectedStatus !== 'ignored';
    if (!isActive) {
      counts.expectedIgnored += 1;
      if (match && match.status === 'ignored') counts.ignoredCorrect += 1;
    }

    const fieldErrors: LineOutcome['fieldErrors'] = [];

    if (isActive) {
      counts.expectedActive += 1;
      if (match) {
        counts.visible += 1;
        if (match.status === 'ready' || match.status === 'needs_review') counts.correctable += 1;
      } else {
        counts.silentLoss += 1;
      }
    }

    if (match) {
      // Field accuracy over paired lines (a paired line's name is correct by construction).
      counts.fields.name.total += 1;
      counts.fields.name.correct += 1;
      counts.fields.quantity.total += 1;
      const qOk = quantityEqual(match.quantityValue, exp.quantityValue);
      if (qOk) counts.fields.quantity.correct += 1;
      else fieldErrors.push('quantity');
      counts.fields.unit.total += 1;
      const uOk = unitEqual(match.unitToken, exp.unitToken);
      if (uOk) counts.fields.unit.correct += 1;
      else fieldErrors.push('unit');
      counts.fields.section.total += 1;
      const sOk = sectionEqual(match.section, exp.section);
      if (sOk) counts.fields.section.correct += 1;
      else fieldErrors.push('section');
    }

    lines.push({
      expectedName: exp.name,
      matched: match !== null,
      draftStatus: match ? match.status : null,
      expectedStatus: exp.expectedStatus,
      fieldErrors,
    });
  }

  // Ready accuracy + hallucinations are computed over the DRAFT's active lines, so a
  // ready line invented by the model (no expected match) counts as both active and
  // (since unpaired) NOT ready-correct — penalizing confident hallucinations.
  const hallucinatedNames: string[] = [];
  draftLines.forEach((line, i) => {
    if (line.status === 'ignored') return;
    counts.activeDraftLines += 1;

    const exp = pairedExpected.get(i);
    if (!exp) {
      counts.hallucinated += 1;
      hallucinatedNames.push(line.ingredientName);
    }

    if (line.status === 'ready') {
      counts.readyTotal += 1;
      const allFieldsOk =
        exp != null &&
        exp.expectedStatus === 'ready' &&
        quantityEqual(line.quantityValue, exp.quantityValue) &&
        unitEqual(line.unitToken, exp.unitToken) &&
        sectionEqual(line.section, exp.section);
      if (allFieldsOk) counts.readyCorrect += 1;
    }
  });

  return { slug: expected.slug, counts, lines, hallucinatedNames };
}

/* -------------------------------------------------------------------------- */
/* Aggregation + rates.                                                       */
/* -------------------------------------------------------------------------- */

const addFields = (a: FieldCounts, b: FieldCounts): FieldCounts => ({
  correct: a.correct + b.correct,
  total: a.total + b.total,
});

/** Micro-average: sum every count across fixtures (NOT an average of per-fixture rates). */
export function aggregate(scores: EvalScore[]): EvalCounts {
  const total: EvalCounts = {
    expectedActive: 0,
    visible: 0,
    correctable: 0,
    silentLoss: 0,
    readyTotal: 0,
    readyCorrect: 0,
    activeDraftLines: 0,
    hallucinated: 0,
    expectedIgnored: 0,
    ignoredCorrect: 0,
    fields: emptyFields(),
  };
  for (const { counts: c } of scores) {
    total.expectedActive += c.expectedActive;
    total.visible += c.visible;
    total.correctable += c.correctable;
    total.silentLoss += c.silentLoss;
    total.readyTotal += c.readyTotal;
    total.readyCorrect += c.readyCorrect;
    total.activeDraftLines += c.activeDraftLines;
    total.hallucinated += c.hallucinated;
    total.expectedIgnored += c.expectedIgnored;
    total.ignoredCorrect += c.ignoredCorrect;
    total.fields.name = addFields(total.fields.name, c.fields.name);
    total.fields.quantity = addFields(total.fields.quantity, c.fields.quantity);
    total.fields.unit = addFields(total.fields.unit, c.fields.unit);
    total.fields.section = addFields(total.fields.section, c.fields.section);
  }
  return total;
}

export type EvalRates = {
  lineRecall: number;
  correctableRecall: number;
  readyAccuracy: number;
  hallucinationRate: number;
  silentLossRate: number;
  ignoredAccuracy: number;
  fieldAccuracy: { name: number; quantity: number; unit: number; section: number };
};

/** A rate over a possibly-zero denominator: an empty set is treated as a perfect 1. */
const ratio = (num: number, den: number): number => (den === 0 ? 1 : num / den);

export function rates(c: EvalCounts): EvalRates {
  return {
    lineRecall: ratio(c.visible, c.expectedActive),
    correctableRecall: ratio(c.correctable, c.expectedActive),
    readyAccuracy: ratio(c.readyCorrect, c.readyTotal),
    // An empty draft cannot hallucinate; hence ratio over activeDraftLines (0 → 0 here).
    hallucinationRate: c.activeDraftLines === 0 ? 0 : c.hallucinated / c.activeDraftLines,
    silentLossRate: c.expectedActive === 0 ? 0 : c.silentLoss / c.expectedActive,
    ignoredAccuracy: ratio(c.ignoredCorrect, c.expectedIgnored),
    fieldAccuracy: {
      name: ratio(c.fields.name.correct, c.fields.name.total),
      quantity: ratio(c.fields.quantity.correct, c.fields.quantity.total),
      unit: ratio(c.fields.unit.correct, c.fields.unit.total),
      section: ratio(c.fields.section.correct, c.fields.section.total),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Launch thresholds (§9.3 / gate G5).                                        */
/* -------------------------------------------------------------------------- */

export const LAUNCH_THRESHOLDS = {
  silentLossRate: 0, // hard: must be exactly 0
  correctableRecall: 0.98,
  lineRecall: 0.95,
  readyAccuracy: 0.85,
  hallucinationRate: 0.02,
} as const;

export type ThresholdFailure = {
  metric: keyof typeof LAUNCH_THRESHOLDS;
  value: number;
  threshold: number;
  comparator: '<=' | '>=' | '==';
};

/**
 * Check aggregate rates against the §9.3 launch gate. Recalls/accuracy are floors
 * (`>=`); hallucination is a ceiling (`<=`); silent loss must be exactly 0. Returns
 * the failing metrics so the runner can print and exit non-zero (G5).
 */
export function checkThresholds(r: EvalRates): { passed: boolean; failures: ThresholdFailure[] } {
  const failures: ThresholdFailure[] = [];
  if (r.silentLossRate !== LAUNCH_THRESHOLDS.silentLossRate) {
    failures.push({ metric: 'silentLossRate', value: r.silentLossRate, threshold: 0, comparator: '==' });
  }
  if (r.correctableRecall < LAUNCH_THRESHOLDS.correctableRecall) {
    failures.push({ metric: 'correctableRecall', value: r.correctableRecall, threshold: LAUNCH_THRESHOLDS.correctableRecall, comparator: '>=' });
  }
  if (r.lineRecall < LAUNCH_THRESHOLDS.lineRecall) {
    failures.push({ metric: 'lineRecall', value: r.lineRecall, threshold: LAUNCH_THRESHOLDS.lineRecall, comparator: '>=' });
  }
  if (r.readyAccuracy < LAUNCH_THRESHOLDS.readyAccuracy) {
    failures.push({ metric: 'readyAccuracy', value: r.readyAccuracy, threshold: LAUNCH_THRESHOLDS.readyAccuracy, comparator: '>=' });
  }
  if (r.hallucinationRate > LAUNCH_THRESHOLDS.hallucinationRate) {
    failures.push({ metric: 'hallucinationRate', value: r.hallucinationRate, threshold: LAUNCH_THRESHOLDS.hallucinationRate, comparator: '<=' });
  }
  return { passed: failures.length === 0, failures };
}
