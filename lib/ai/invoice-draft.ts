import type { Dimension } from '@/lib/units';
import { dimensionOf } from '@/lib/units';
import { parseUnitToken } from '@/lib/units/token';
import type {
  SupplierInvoiceLineIssueCode,
  SupplierInvoiceLineStatus,
} from '@/lib/ai/operation-types';
import type { SupplierInvoiceExtraction } from '@/lib/ai/invoice-extraction';

/**
 * Pure mapping (no DB, no SDK) from a validated {@link SupplierInvoiceExtraction} to an
 * editable review draft (Sprint 2, AI margin roadmap). Every line the model read is
 * KEPT — a line missing the data needed to derive a per-unit cost (quantity / pack /
 * unit / price) or without a matched ingredient is `needs_review`, NEVER dropped
 * (CLAUDE.md: AI output is untrusted, staged, human-confirmed).
 *
 * A model price is captured but NEVER treated as final: applying a line records a
 * PENDING observation only (see `lib/data/supplier-invoice-imports.ts`).
 */

/** Confidence at/below which we surface a low-confidence quality flag. */
export const LOW_CONFIDENCE_THRESHOLD = 0.6;

/** The subset of a line the completeness rules read (DB-agnostic + match info). */
export type InvoiceDraftLineData = {
  itemNameRaw: string;
  quantityValue: number | null;
  quantityUnit: string | null;
  packSizeValue: number | null;
  packSizeUnit: string | null;
  unitPriceCents: number | null;
  lineTotalCents: number | null;
  matchedIngredientId: string | null;
};

/**
 * The stable review issues for one line. Pure and shared by the mapper AND the
 * update/apply paths so "why is this line not ready" is computed ONE way. When the
 * matched ingredient's dimension is known, an incompatible pack unit is flagged.
 */
export function deriveInvoiceLineIssues(
  line: InvoiceDraftLineData,
  opts: { matchedDimension?: Dimension | null } = {},
): SupplierInvoiceLineIssueCode[] {
  const issues: SupplierInvoiceLineIssueCode[] = [];

  if (line.quantityValue == null || line.quantityValue <= 0) {
    issues.push('MISSING_QUANTITY');
  }

  const hasPack =
    line.packSizeValue != null &&
    line.packSizeValue > 0 &&
    line.packSizeUnit != null &&
    line.packSizeUnit.trim() !== '';
  if (!hasPack) {
    issues.push('MISSING_PACK');
  } else {
    const parsed = parseUnitToken(line.packSizeUnit!);
    if ('error' in parsed) {
      issues.push('UNKNOWN_UNIT');
    } else if (
      opts.matchedDimension != null &&
      dimensionOf(parsed.unit) !== opts.matchedDimension
    ) {
      issues.push('PACK_UNIT_MISMATCH');
    }
  }

  if (line.unitPriceCents == null) {
    issues.push('MISSING_PRICE');
  }

  if (line.matchedIngredientId == null) {
    issues.push('NO_INGREDIENT_MATCH');
  }

  return issues;
}

/** A line with no issues is `ready` to apply; otherwise it stays `needs_review`. */
export function invoiceLineStatusFromIssues(
  issues: readonly SupplierInvoiceLineIssueCode[],
): Extract<SupplierInvoiceLineStatus, 'ready' | 'needs_review'> {
  return issues.length === 0 ? 'ready' : 'needs_review';
}

/** One draft line, ready to persist into `supplier_invoice_import_lines`. */
export type InvoiceDraftLine = {
  sortOrder: number;
  rawText: string | null;
  itemNameRaw: string;
  quantityValue: number | null;
  quantityUnit: string | null;
  packSizeValue: number | null;
  packSizeUnit: string | null;
  unitPriceCents: number | null;
  lineTotalCents: number | null;
  confidence: number;
  matchedIngredientId: string | null;
  status: SupplierInvoiceLineStatus;
  issues: SupplierInvoiceLineIssueCode[];
};

/** The draft header + lines the route persists and the workbench renders. */
export type InvoiceDraft = {
  supplierNameRaw: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  currencyCode: string | null;
  lines: InvoiceDraftLine[];
  qualityFlags: string[];
};

/** Round a currency code to an upper-cased 3-letter code, or null. */
function normalizeCurrency(raw: string | null): string | null {
  if (raw == null) return null;
  const v = raw.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(v) ? v : null;
}

/**
 * Map a validated extraction to a draft. Ingredient matching is done later (needs the
 * org's ingredient list from the DB), so every line starts unmatched (`NO_INGREDIENT_
 * MATCH`) — the route re-derives status after matching. Quality flags are the model's
 * own flags plus derived, PII-free ones.
 */
export function mapInvoiceExtractionToDraft(
  extraction: SupplierInvoiceExtraction,
): InvoiceDraft {
  const lines: InvoiceDraftLine[] = extraction.lines.map((l, i) => {
    const data: InvoiceDraftLineData = {
      itemNameRaw: l.itemName,
      quantityValue: l.quantityValue,
      quantityUnit: l.quantityUnit,
      packSizeValue: l.packSizeValue,
      packSizeUnit: l.packSizeUnit,
      unitPriceCents: l.unitPriceCents,
      lineTotalCents: l.lineTotalCents,
      matchedIngredientId: null,
    };
    const issues = deriveInvoiceLineIssues(data);
    return {
      sortOrder: i,
      rawText: l.rawText,
      itemNameRaw: l.itemName,
      quantityValue: l.quantityValue,
      quantityUnit: l.quantityUnit,
      packSizeValue: l.packSizeValue,
      packSizeUnit: l.packSizeUnit,
      unitPriceCents: l.unitPriceCents,
      lineTotalCents: l.lineTotalCents,
      confidence: l.confidence,
      matchedIngredientId: null,
      status: invoiceLineStatusFromIssues(issues),
      issues,
    };
  });

  const currency = normalizeCurrency(extraction.invoice.currency);
  const flags = new Set<string>(extraction.qualityFlags);
  if (extraction.supplier.confidence <= LOW_CONFIDENCE_THRESHOLD) {
    flags.add('low_supplier_confidence');
  }
  if (lines.some((l) => l.confidence <= LOW_CONFIDENCE_THRESHOLD)) {
    flags.add('low_line_confidence');
  }
  if (currency == null) flags.add('currency_missing');

  return {
    supplierNameRaw: extraction.supplier.name,
    invoiceNumber: extraction.invoice.number,
    invoiceDate: extraction.invoice.date,
    currencyCode: currency,
    lines,
    // Cap so a hostile response can't bloat the persisted metadata.
    qualityFlags: [...flags].slice(0, 20),
  };
}
