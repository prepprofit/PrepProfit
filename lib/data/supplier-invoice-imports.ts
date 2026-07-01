import { and, asc, eq, isNull } from 'drizzle-orm';
import {
  ingredients,
  suppliers,
  supplierInvoiceImports,
  supplierInvoiceImportLines,
} from '@/lib/db/schema';
import type {
  SupplierInvoiceImport,
  SupplierInvoiceImportLine,
} from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';
import { normalizeSupplierName } from '@/lib/suppliers/normalize';
import { resolveIngredient, type IngredientCandidate } from '@/lib/import/resolveIngredient';
import { recordPriceObservation } from '@/lib/data/ingredient-pricing';
import { findOrCreateSupplierByName } from '@/lib/data/suppliers';
import { parseUnitToken } from '@/lib/units/token';
import type { Dimension } from '@/lib/units';
import {
  deriveInvoiceLineIssues,
  invoiceLineStatusFromIssues,
  type InvoiceDraft,
} from '@/lib/ai/invoice-draft';
import type {
  SupplierInvoiceLineIssueCode,
  SupplierInvoiceLineStatus,
} from '@/lib/ai/operation-types';

/**
 * Supplier invoice import data layer (Sprint 2, AI margin roadmap). ALWAYS org-scoped
 * (RULE #1); RLS is the second layer. MANAGER-ONLY at the action layer.
 *
 * THE SAFETY CONTRACT: applying an import records `source='import'` PENDING price
 * observations only (via `recordPriceObservation`), which raise
 * `ingredients.pending_price_cents` and NEVER touch `price_cents`. No inventory, no
 * receipts, no transactions. Promotion of pending → approved is a separate manager
 * action (Sprint 3).
 */

/** Load active ingredients as resolver candidates + a dimension lookup. */
async function loadIngredientCandidates(
  db: TenantClient,
  organizationId: string,
): Promise<{ candidates: IngredientCandidate[]; dimensionById: Map<string, Dimension> }> {
  const rows = await db
    .select({ id: ingredients.id, name: ingredients.name, dimension: ingredients.dimension })
    .from(ingredients)
    .where(
      and(eq(ingredients.organizationId, organizationId), isNull(ingredients.deletedAt)),
    );
  return {
    candidates: rows.map((r) => ({ id: r.id, name: r.name })),
    dimensionById: new Map(rows.map((r) => [r.id, r.dimension])),
  };
}

export type CreateInvoiceImportInput = {
  actorUserId: string;
  aiAttemptId: string | null;
  draft: InvoiceDraft;
};

export type CreateInvoiceImportResult = {
  importId: string;
  total: number;
  ready: number;
  needsReview: number;
};

/**
 * Persist an extraction draft as a `draft` import + its lines. Pre-resolves each line
 * to an EXACT existing ingredient (fuzzy/new stay unmatched for the manager to pick)
 * and pre-links an EXISTING supplier by normalized name (never creates one here —
 * creation is an explicit apply-time action). Recomputes each line's status/issues
 * with the matched ingredient's dimension. Runs in the caller's `withOrg` tx.
 */
export async function createInvoiceImport(
  db: TenantClient,
  organizationId: string,
  input: CreateInvoiceImportInput,
): Promise<CreateInvoiceImportResult> {
  const { candidates, dimensionById } = await loadIngredientCandidates(db, organizationId);

  // Read-only supplier pre-match (creation happens at apply, if needed).
  let supplierId: string | null = null;
  const normalizedSupplier = input.draft.supplierNameRaw
    ? normalizeSupplierName(input.draft.supplierNameRaw)
    : '';
  if (normalizedSupplier !== '') {
    const [existing] = await db
      .select({ id: suppliers.id })
      .from(suppliers)
      .where(
        and(
          eq(suppliers.organizationId, organizationId),
          eq(suppliers.normalizedName, normalizedSupplier),
          eq(suppliers.active, true),
        ),
      )
      .limit(1);
    supplierId = existing?.id ?? null;
  }

  const [header] = await db
    .insert(supplierInvoiceImports)
    .values({
      organizationId,
      actorUserId: input.actorUserId,
      supplierId,
      supplierNameRaw: input.draft.supplierNameRaw,
      invoiceNumber: input.draft.invoiceNumber,
      invoiceDate: input.draft.invoiceDate,
      currencyCode: input.draft.currencyCode,
      status: 'draft',
      aiAttemptId: input.aiAttemptId,
    })
    .returning();
  if (!header) throw new Error('Failed to create supplier invoice import.');

  let ready = 0;
  let needsReview = 0;
  for (const line of input.draft.lines) {
    const outcome = resolveIngredient(line.itemNameRaw, candidates);
    const matchedIngredientId = outcome.kind === 'exact' ? outcome.ingredientId : null;
    const matchedDimension = matchedIngredientId
      ? (dimensionById.get(matchedIngredientId) ?? null)
      : null;

    const issues = deriveInvoiceLineIssues(
      { ...line, matchedIngredientId },
      { matchedDimension },
    );
    const status = invoiceLineStatusFromIssues(issues);
    if (status === 'ready') ready++;
    else needsReview++;

    await db.insert(supplierInvoiceImportLines).values({
      organizationId,
      importId: header.id,
      sortOrder: line.sortOrder,
      rawText: line.rawText,
      itemNameRaw: line.itemNameRaw,
      matchedIngredientId,
      quantityValue: line.quantityValue?.toString() ?? null,
      quantityUnit: line.quantityUnit,
      packSizeValue: line.packSizeValue?.toString() ?? null,
      packSizeUnit: line.packSizeUnit,
      unitPriceCents: line.unitPriceCents,
      lineTotalCents: line.lineTotalCents,
      confidence: line.confidence.toString(),
      status,
      issues,
    });
  }

  return { importId: header.id, total: input.draft.lines.length, ready, needsReview };
}

export type InvoiceImportView = {
  header: SupplierInvoiceImport;
  lines: SupplierInvoiceImportLine[];
};

/** Load one import + its lines (org-scoped; RLS is the second layer). Null if absent. */
export async function getInvoiceImport(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<InvoiceImportView | null> {
  const [header] = await db
    .select()
    .from(supplierInvoiceImports)
    .where(
      and(
        eq(supplierInvoiceImports.organizationId, organizationId),
        eq(supplierInvoiceImports.id, id),
      ),
    )
    .limit(1);
  if (!header) return null;

  const lines = await db
    .select()
    .from(supplierInvoiceImportLines)
    .where(
      and(
        eq(supplierInvoiceImportLines.organizationId, organizationId),
        eq(supplierInvoiceImportLines.importId, id),
      ),
    )
    .orderBy(asc(supplierInvoiceImportLines.sortOrder));
  return { header, lines };
}

/** Numeric-or-null coercion for a stored numeric column (driver returns a string). */
function numOrNull(value: string | null): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Fields the manager may edit on a draft line, plus an explicit ignore toggle. */
export type UpdateInvoiceLinePatch = {
  itemNameRaw?: string;
  matchedIngredientId?: string | null;
  quantityValue?: number | null;
  quantityUnit?: string | null;
  packSizeValue?: number | null;
  packSizeUnit?: string | null;
  unitPriceCents?: number | null;
  lineTotalCents?: number | null;
  /** When true, exclude the line from apply (`ignored`); false restores it to review. */
  ignored?: boolean;
};

export type UpdateInvoiceLineResult =
  | { status: 'ok'; line: SupplierInvoiceImportLine }
  | { status: 'not_found' }
  | { status: 'not_editable' };

/**
 * Edit / match / ignore one draft line, then recompute its issues + status against the
 * matched ingredient's dimension. Only a `draft` import is editable. A matched
 * ingredient is re-validated to be an ACTIVE ingredient of this org. Runs in `withOrg`.
 */
export async function updateInvoiceLine(
  db: TenantClient,
  organizationId: string,
  importId: string,
  lineId: string,
  patch: UpdateInvoiceLinePatch,
): Promise<UpdateInvoiceLineResult> {
  const [header] = await db
    .select({ status: supplierInvoiceImports.status })
    .from(supplierInvoiceImports)
    .where(
      and(
        eq(supplierInvoiceImports.organizationId, organizationId),
        eq(supplierInvoiceImports.id, importId),
      ),
    )
    .for('update')
    .limit(1);
  if (!header) return { status: 'not_found' };
  if (header.status !== 'draft') return { status: 'not_editable' };

  const [current] = await db
    .select()
    .from(supplierInvoiceImportLines)
    .where(
      and(
        eq(supplierInvoiceImportLines.organizationId, organizationId),
        eq(supplierInvoiceImportLines.id, lineId),
        eq(supplierInvoiceImportLines.importId, importId),
      ),
    )
    .limit(1);
  if (!current) return { status: 'not_found' };

  // Merge the patch over the current values.
  const itemNameRaw = patch.itemNameRaw ?? current.itemNameRaw;
  const matchedIngredientId =
    patch.matchedIngredientId !== undefined
      ? patch.matchedIngredientId
      : current.matchedIngredientId;
  const quantityValue =
    patch.quantityValue !== undefined ? patch.quantityValue : numOrNull(current.quantityValue);
  const quantityUnit =
    patch.quantityUnit !== undefined ? patch.quantityUnit : current.quantityUnit;
  const packSizeValue =
    patch.packSizeValue !== undefined ? patch.packSizeValue : numOrNull(current.packSizeValue);
  const packSizeUnit =
    patch.packSizeUnit !== undefined ? patch.packSizeUnit : current.packSizeUnit;
  const unitPriceCents =
    patch.unitPriceCents !== undefined ? patch.unitPriceCents : current.unitPriceCents;
  const lineTotalCents =
    patch.lineTotalCents !== undefined ? patch.lineTotalCents : current.lineTotalCents;

  // Re-validate a matched ingredient belongs to this org and is active; capture its
  // dimension for the pack-unit compatibility check.
  let matchedDimension: Dimension | null = null;
  let validMatchId: string | null = null;
  if (matchedIngredientId) {
    const [ing] = await db
      .select({ id: ingredients.id, dimension: ingredients.dimension })
      .from(ingredients)
      .where(
        and(
          eq(ingredients.organizationId, organizationId),
          eq(ingredients.id, matchedIngredientId),
          isNull(ingredients.deletedAt),
        ),
      )
      .limit(1);
    if (ing) {
      validMatchId = ing.id;
      matchedDimension = ing.dimension;
    }
  }

  const issues = deriveInvoiceLineIssues(
    {
      itemNameRaw,
      quantityValue,
      quantityUnit,
      packSizeValue,
      packSizeUnit,
      unitPriceCents,
      lineTotalCents,
      matchedIngredientId: validMatchId,
    },
    { matchedDimension },
  );

  const status: SupplierInvoiceLineStatus = patch.ignored
    ? 'ignored'
    : invoiceLineStatusFromIssues(issues);
  // An ignored line keeps its data but is excluded from apply; a re-included line
  // recomputes to ready/needs_review.
  const persistedIssues: SupplierInvoiceLineIssueCode[] = patch.ignored ? [] : issues;

  const [row] = await db
    .update(supplierInvoiceImportLines)
    .set({
      itemNameRaw,
      matchedIngredientId: validMatchId,
      quantityValue: quantityValue?.toString() ?? null,
      quantityUnit,
      packSizeValue: packSizeValue?.toString() ?? null,
      packSizeUnit,
      unitPriceCents,
      lineTotalCents,
      status,
      issues: persistedIssues,
    })
    .where(
      and(
        eq(supplierInvoiceImportLines.organizationId, organizationId),
        eq(supplierInvoiceImportLines.id, lineId),
        eq(supplierInvoiceImportLines.importId, importId),
      ),
    )
    .returning();
  if (!row) return { status: 'not_found' };
  return { status: 'ok', line: row };
}

export type ApplyInvoiceImportResult =
  | { status: 'ok'; applied: number; skipped: number }
  | { status: 'not_found' }
  | { status: 'not_editable' }
  | { status: 'currency_mismatch' }
  | { status: 'empty' };

/**
 * Apply a draft import: for each `ready` line, record a `source='import'` PENDING price
 * observation (derives per-unit cost, raises `pending_price_cents`, NEVER touches
 * `price_cents`) and flip the line to `applied`. Guards:
 *  - only a `draft` import applies (status flip + FOR UPDATE lock ⇒ idempotent);
 *  - the invoice currency MUST equal the org currency (D6), else `currency_mismatch`;
 *  - at least one `ready` line is required, else `empty`.
 * A ready line whose ingredient vanished (trashed since draft) is skipped and reverts
 * to `needs_review`. Runs in the caller's `withOrg` tx.
 */
export async function applyInvoiceImport(
  db: TenantClient,
  organizationId: string,
  actorUserId: string,
  id: string,
  orgCurrency: string,
): Promise<ApplyInvoiceImportResult> {
  const [header] = await db
    .select()
    .from(supplierInvoiceImports)
    .where(
      and(
        eq(supplierInvoiceImports.organizationId, organizationId),
        eq(supplierInvoiceImports.id, id),
      ),
    )
    .for('update')
    .limit(1);
  if (!header) return { status: 'not_found' };
  if (header.status !== 'draft') return { status: 'not_editable' };
  if (header.currencyCode == null || header.currencyCode !== orgCurrency) {
    return { status: 'currency_mismatch' };
  }

  const readyLines = await db
    .select()
    .from(supplierInvoiceImportLines)
    .where(
      and(
        eq(supplierInvoiceImportLines.organizationId, organizationId),
        eq(supplierInvoiceImportLines.importId, id),
        eq(supplierInvoiceImportLines.status, 'ready'),
      ),
    )
    .orderBy(asc(supplierInvoiceImportLines.sortOrder));
  if (readyLines.length === 0) return { status: 'empty' };

  // Ensure a supplier record exists for provenance/display (best-effort; never blocks
  // apply — a price observation does not require a supplier link).
  if (header.supplierId == null && header.supplierNameRaw) {
    const found = await findOrCreateSupplierByName(db, organizationId, header.supplierNameRaw);
    if (found.status === 'ok') {
      await db
        .update(supplierInvoiceImports)
        .set({ supplierId: found.supplier.id })
        .where(
          and(
            eq(supplierInvoiceImports.organizationId, organizationId),
            eq(supplierInvoiceImports.id, id),
          ),
        );
    }
  }

  let applied = 0;
  let skipped = 0;
  for (const line of readyLines) {
    const packSize = numOrNull(line.packSizeValue);
    const parsedUnit = line.packSizeUnit ? parseUnitToken(line.packSizeUnit) : null;
    // A ready line has already passed these checks, but re-validate defensively.
    if (
      line.matchedIngredientId == null ||
      packSize == null ||
      packSize <= 0 ||
      parsedUnit == null ||
      'error' in parsedUnit ||
      line.unitPriceCents == null
    ) {
      await db
        .update(supplierInvoiceImportLines)
        .set({ status: 'needs_review' })
        .where(eq(supplierInvoiceImportLines.id, line.id));
      skipped++;
      continue;
    }

    const result = await recordPriceObservation(db, organizationId, {
      ingredientId: line.matchedIngredientId,
      source: 'import',
      packSize,
      packUnit: parsedUnit.unit,
      packPriceCents: line.unitPriceCents,
      actorUserId,
    });
    if (!result.ok) {
      // The matched ingredient was trashed since the draft — revert for re-matching.
      await db
        .update(supplierInvoiceImportLines)
        .set({ status: 'needs_review', matchedIngredientId: null })
        .where(eq(supplierInvoiceImportLines.id, line.id));
      skipped++;
      continue;
    }

    await db
      .update(supplierInvoiceImportLines)
      .set({ status: 'applied', derivedPriceCents: result.derivedPriceCents })
      .where(eq(supplierInvoiceImportLines.id, line.id));
    applied++;
  }

  if (applied === 0) return { status: 'empty' };

  await db
    .update(supplierInvoiceImports)
    .set({ status: 'applied' })
    .where(
      and(
        eq(supplierInvoiceImports.organizationId, organizationId),
        eq(supplierInvoiceImports.id, id),
      ),
    );
  return { status: 'ok', applied, skipped };
}

export type VoidInvoiceImportResult =
  | { status: 'ok' }
  | { status: 'not_found' }
  | { status: 'not_editable' };

/** Discard a draft import (`void`). Only a `draft` import can be voided. */
export async function voidInvoiceImport(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<VoidInvoiceImportResult> {
  const [header] = await db
    .select({ status: supplierInvoiceImports.status })
    .from(supplierInvoiceImports)
    .where(
      and(
        eq(supplierInvoiceImports.organizationId, organizationId),
        eq(supplierInvoiceImports.id, id),
      ),
    )
    .for('update')
    .limit(1);
  if (!header) return { status: 'not_found' };
  if (header.status !== 'draft') return { status: 'not_editable' };

  await db
    .update(supplierInvoiceImports)
    .set({ status: 'void' })
    .where(
      and(
        eq(supplierInvoiceImports.organizationId, organizationId),
        eq(supplierInvoiceImports.id, id),
      ),
    );
  return { status: 'ok' };
}
