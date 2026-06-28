import { parseMoneyToCents } from '@/lib/format/money';
import { dateStringSchema } from '@/lib/validation/transactions';
import {
  INGREDIENT_COLUMNS,
  INGREDIENT_REQUIRED_COLUMNS,
  TRANSACTION_COLUMNS,
  TRANSACTION_REQUIRED_COLUMNS,
  RECIPE_COLUMNS,
  RECIPE_REQUIRED_COLUMNS,
  RECIPE_LIMITS,
  SALES_COLUMNS,
  SALES_REQUIRED_COLUMNS,
  SALES_LIMITS,
  IMPORT_LIMITS,
  MAX_IMPORT_ROWS,
} from '@/lib/validation/import';
import { type Dimension, dimensionOf, toCanonical } from '@/lib/units';
import { parseUnitToken } from '@/lib/units/token';
import { percentToBps } from '@/lib/calculations/tax';
import { NUMERIC_12_2_MAX } from '@/lib/calculations/production';
import { normalizeIngredientName } from './resolveIngredient';
import { parseCsv } from './csv';
import { parseXlsx } from './xlsx';
import type {
  ImportFormat,
  ImportIngredientRecord,
  ImportRowIssue,
  ImportSaleItemKind,
} from './types';

/**
 * Pure, deterministic parsing of a spreadsheet matrix into typed draft rows +
 * per-row issues (Sprint 4.5). NO database access — DB-dependent checks (category
 * resolution, duplicate ingredient names) happen later in the data-layer planner,
 * inside `withOrg`. This keeps the parser fully unit-testable from fixtures.
 *
 * Rows with a HARD issue produce `draft: null` (not importable); SOFT issues
 * (`NEEDS_PRICING`) keep the draft. Line numbers are 1-based spreadsheet lines.
 */

/** File-level rejection reasons (vs per-row issues). */
export type ImportFileError =
  | 'EMPTY_FILE'
  | 'NO_DATA_ROWS'
  | 'TOO_MANY_ROWS'
  | 'MISSING_COLUMNS'
  | 'UNKNOWN_COLUMNS'
  | 'DUPLICATE_COLUMNS';

/** A transaction draft whose category is still a NAME (resolved at the DB step). */
export type DraftTransactionRow = {
  type: 'income' | 'expense';
  categoryName: string;
  occurredOn: string;
  amountCents: number;
  note: string | null;
};

export type ParsedRow<TDraft> = {
  line: number;
  draft: TDraft | null;
  issues: ImportRowIssue[];
};

export type ParseResult<TDraft> =
  | { ok: false; error: ImportFileError }
  | { ok: true; rows: ParsedRow<TDraft>[] };

/** Read raw file bytes into a string matrix by format (Node runtime). */
export async function readImportMatrix(
  format: ImportFormat,
  bytes: Buffer,
): Promise<string[][]> {
  if (format === 'csv') return parseCsv(bytes.toString('utf8'));
  return parseXlsx(bytes);
}

/* -------------------------------------------------------------------------- */
/* Shared header/cell helpers                                                 */
/* -------------------------------------------------------------------------- */

const normalize = (s: string): string => s.trim().toLowerCase();

/** Coerce a raw cell to the ingredient dimension union, or null when invalid. */
function asDimension(raw: string): 'weight' | 'volume' | 'count' | null {
  const v = normalize(raw);
  return v === 'weight' || v === 'volume' || v === 'count' ? v : null;
}

/** Coerce a raw cell to the transaction type union, or null when invalid. */
function asTransactionType(raw: string): 'income' | 'expense' | null {
  const v = normalize(raw);
  return v === 'income' || v === 'expense' ? v : null;
}

/** True when every cell in the row is blank after trimming. */
const isBlankRow = (cells: string[]): boolean =>
  cells.every((c) => c.trim() === '');

type HeaderPlan = {
  /** Map from known column name → its index in the matrix. */
  index: Record<string, number>;
  /** The 0-based matrix index of the header row. */
  headerRowIndex: number;
};

/**
 * Locate + validate the header row against a column contract. Rejects unknown
 * columns, missing required columns, and duplicate known columns.
 */
function planHeader(
  matrix: string[][],
  known: readonly string[],
  required: readonly string[],
): { ok: true; plan: HeaderPlan } | { ok: false; error: ImportFileError } {
  const headerRowIndex = matrix.findIndex((row) => !isBlankRow(row));
  if (headerRowIndex === -1) return { ok: false, error: 'EMPTY_FILE' };

  const headers = matrix[headerRowIndex]!.map(normalize);
  const knownSet = new Set(known);
  const index: Record<string, number> = {};

  for (let i = 0; i < headers.length; i++) {
    const h = headers[i]!;
    if (h === '') continue; // ignore trailing empty header cells
    if (!knownSet.has(h)) return { ok: false, error: 'UNKNOWN_COLUMNS' };
    if (h in index) return { ok: false, error: 'DUPLICATE_COLUMNS' };
    index[h] = i;
  }

  for (const col of required) {
    if (!(col in index)) return { ok: false, error: 'MISSING_COLUMNS' };
  }

  return { ok: true, plan: { index, headerRowIndex } };
}

/** Read a cell by column name from a row, trimmed; '' when the column is absent. */
function cell(row: string[], plan: HeaderPlan, column: string): string {
  const idx = plan.index[column];
  if (idx === undefined) return '';
  return (row[idx] ?? '').trim();
}

/**
 * Parse a money/amount cell strictly: a non-blank value must look numeric (no
 * letters). Returns integer cents or an issue code. Distinguishes "unparseable"
 * from a legitimate 0 (which `parseMoneyToCents` would also return).
 */
function parseAmountCell(
  raw: string,
): { cents: number } | { error: 'INVALID_NUMBER' } {
  const trimmed = raw.trim();
  if (!/\d/.test(trimmed) || /[A-Za-z]/.test(trimmed)) {
    return { error: 'INVALID_NUMBER' };
  }
  const cents = parseMoneyToCents(trimmed);
  if (!Number.isFinite(cents)) return { error: 'INVALID_NUMBER' };
  return { cents };
}

/* -------------------------------------------------------------------------- */
/* Ingredients                                                                */
/* -------------------------------------------------------------------------- */

export function parseIngredients(
  matrix: string[][],
): ParseResult<ImportIngredientRecord> {
  const planned = planHeader(
    matrix,
    INGREDIENT_COLUMNS,
    INGREDIENT_REQUIRED_COLUMNS,
  );
  if (!planned.ok) return planned;
  const { plan } = planned;

  const rows: ParsedRow<ImportIngredientRecord>[] = [];
  let dataRows = 0;

  for (let i = plan.headerRowIndex + 1; i < matrix.length; i++) {
    const raw = matrix[i]!;
    if (isBlankRow(raw)) continue;
    dataRows += 1;
    if (dataRows > MAX_IMPORT_ROWS) return { ok: false, error: 'TOO_MANY_ROWS' };

    const line = i + 1;
    const issues: ImportRowIssue[] = [];
    const add = (column: string, code: ImportRowIssue['code']) =>
      issues.push({ line, column, code });

    const name = cell(raw, plan, 'name');
    if (name === '') add('name', 'MISSING_REQUIRED');
    else if (name.length > IMPORT_LIMITS.name) add('name', 'TOO_LONG');

    const dimensionRaw = cell(raw, plan, 'dimension');
    const dimension = asDimension(dimensionRaw);
    if (dimensionRaw === '') add('dimension', 'MISSING_REQUIRED');
    else if (!dimension) add('dimension', 'INVALID_DIMENSION');

    const priceRaw = cell(raw, plan, 'price');
    let priceCents = 0;
    if (priceRaw !== '') {
      const parsed = parseAmountCell(priceRaw);
      if ('error' in parsed) add('price', 'INVALID_NUMBER');
      else if (parsed.cents < 0) add('price', 'NEGATIVE_AMOUNT');
      else priceCents = parsed.cents;
    }

    const supplierRaw = cell(raw, plan, 'supplier');
    if (supplierRaw.length > IMPORT_LIMITS.supplier) add('supplier', 'TOO_LONG');
    const supplier = supplierRaw === '' ? null : supplierRaw;

    const hardIssues = issues.length > 0;
    // A blank/zero price is a SOFT flag, not a rejection (CLAUDE.md: import at 0,
    // flagged as needing pricing).
    const needsPricing = priceCents === 0;
    if (needsPricing && !hardIssues) add('price', 'NEEDS_PRICING');

    const draft =
      hardIssues || !dimension
        ? null
        : { name, dimension, priceCents, supplier, needsPricing };

    rows.push({ line, draft, issues });
  }

  if (dataRows === 0) return { ok: false, error: 'NO_DATA_ROWS' };
  return { ok: true, rows };
}

/* -------------------------------------------------------------------------- */
/* Recipes (Sprint 4.6)                                                       */
/* -------------------------------------------------------------------------- */

/** A parsed recipe line (pre-resolution): a canonical quantity of an ingredient. */
export type DraftRecipeLine = {
  /** Raw ingredient name (first occurrence) — display + create-new label. */
  ingredientName: string;
  /** Normalized name — the dedupe key within a recipe and the resolution key. */
  normalizedName: string;
  /** Quantity in the line unit's canonical amount (g / ml / count). */
  quantityCanonical: number;
  /** Dimension inferred from the line's unit. */
  dimension: Dimension;
};

/** A parsed recipe (pre-resolution): a header + its grouped ingredient lines. */
export type DraftRecipe = {
  /** Display name (first occurrence's casing). */
  name: string;
  /** Lower/trimmed key used to group rows and detect org duplicates. */
  normalizedKey: string;
  yieldPortions: number;
  yieldPercentage: number;
  /**
   * Recipe instructions/notes, normalized to the recipe-editor bound. Null for a
   * spreadsheet import (no method column); populated by the photo-import path.
   */
  notes: string | null;
  /** 1-based line of the recipe's first row (for ordering / messages). */
  firstLine: number;
  lines: DraftRecipeLine[];
};

export type ParseRecipesResult =
  | { ok: false; error: ImportFileError }
  | { ok: true; recipes: DraftRecipe[]; issues: ImportRowIssue[] };

/** Parse a plain positive quantity (decimal comma tolerated). Not money. */
function parseQuantityCell(
  raw: string,
): { value: number } | { error: 'INVALID_NUMBER' | 'NEGATIVE_AMOUNT' } {
  const trimmed = raw.trim();
  if (!/\d/.test(trimmed) || /[A-Za-z]/.test(trimmed)) return { error: 'INVALID_NUMBER' };
  const value = Number(trimmed.replace(',', '.'));
  if (!Number.isFinite(value)) return { error: 'INVALID_NUMBER' };
  if (value <= 0) return { error: 'NEGATIVE_AMOUNT' };
  return { value };
}

/** Parse an optional positive integer cell within [min, max]; blank ⇒ fallback. */
function parseIntCell(
  raw: string,
  fallback: number,
  min: number,
  max: number,
): { value: number } | { error: 'INVALID_NUMBER' } {
  const trimmed = raw.trim();
  if (trimmed === '') return { value: fallback };
  if (!/^\d+$/.test(trimmed)) return { error: 'INVALID_NUMBER' };
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < min || n > max) return { error: 'INVALID_NUMBER' };
  return { value: n };
}

/** Lower/trim group key for a recipe name (matches the DB duplicate check). */
const recipeKey = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Parse a LONG-format recipe matrix (one row per ingredient line, grouped by the
 * `recipe` column — D1). Pure, no DB. Reads `yield_*` from the FIRST row of each
 * group (blank → 1 / 100). Validates quantity + unit per line; merges repeated
 * ingredient lines within one recipe by SUMMING canonical quantities (refinement:
 * the recipe_ingredients unique key is per ingredient), flagging a conflicting
 * dimension. Ingredient NAME→id resolution and org duplicate-recipe detection are
 * the data layer's job (they need org data).
 */
export function parseRecipes(matrix: string[][]): ParseRecipesResult {
  const planned = planHeader(matrix, RECIPE_COLUMNS, RECIPE_REQUIRED_COLUMNS);
  if (!planned.ok) return planned;
  const { plan } = planned;

  const groups = new Map<string, DraftRecipe>();
  const order: string[] = [];
  const issues: ImportRowIssue[] = [];
  let dataRows = 0;

  for (let i = plan.headerRowIndex + 1; i < matrix.length; i++) {
    const raw = matrix[i]!;
    if (isBlankRow(raw)) continue;
    dataRows += 1;
    if (dataRows > MAX_IMPORT_ROWS) return { ok: false, error: 'TOO_MANY_ROWS' };

    const line = i + 1;
    const add = (column: string, code: ImportRowIssue['code']) =>
      issues.push({ line, column, code });

    const recipeRaw = cell(raw, plan, 'recipe');
    if (recipeRaw === '') {
      add('recipe', 'MISSING_REQUIRED');
      continue; // cannot assign a line to a recipe group without a name
    }
    if (recipeRaw.length > RECIPE_LIMITS.recipeName) add('recipe', 'TOO_LONG');

    const key = recipeKey(recipeRaw);
    let group = groups.get(key);
    if (!group) {
      // Yield is read from the FIRST row of the group; invalid → default + issue.
      const yp = parseIntCell(cell(raw, plan, 'yield_portions'), 1, 1, 1_000_000);
      const ypct = parseIntCell(cell(raw, plan, 'yield_percentage'), 100, 1, 100);
      if ('error' in yp) add('yield_portions', 'INVALID_NUMBER');
      if ('error' in ypct) add('yield_percentage', 'INVALID_NUMBER');
      if (order.length >= RECIPE_LIMITS.maxRecipes) {
        return { ok: false, error: 'TOO_MANY_ROWS' };
      }
      group = {
        name: recipeRaw.slice(0, RECIPE_LIMITS.recipeName),
        normalizedKey: key,
        yieldPortions: 'error' in yp ? 1 : yp.value,
        yieldPercentage: 'error' in ypct ? 100 : ypct.value,
        // Spreadsheet recipes carry no method column (D7 out of scope).
        notes: null,
        firstLine: line,
        lines: [],
      };
      groups.set(key, group);
      order.push(key);
    }

    const ingredientRaw = cell(raw, plan, 'ingredient');
    if (ingredientRaw === '') add('ingredient', 'MISSING_REQUIRED');
    else if (ingredientRaw.length > RECIPE_LIMITS.ingredientName) add('ingredient', 'TOO_LONG');

    const qtyRaw = cell(raw, plan, 'quantity');
    const qty = qtyRaw === '' ? { error: 'INVALID_NUMBER' as const } : parseQuantityCell(qtyRaw);
    if ('error' in qty) add('quantity', qty.error);

    const unitParsed = parseUnitToken(cell(raw, plan, 'unit'));
    if ('error' in unitParsed) add('unit', unitParsed.error);

    // A line needs a valid ingredient name, quantity, and unit to be importable.
    if (
      ingredientRaw === '' ||
      ingredientRaw.length > RECIPE_LIMITS.ingredientName ||
      'error' in qty ||
      'error' in unitParsed
    ) {
      continue;
    }

    const unit = unitParsed.unit;
    const dimension = dimensionOf(unit);
    const quantityCanonical = toCanonical(qty.value, unit);
    const normalizedName = normalizeIngredientName(ingredientRaw);

    const existing = group.lines.find((l) => l.normalizedName === normalizedName);
    if (existing) {
      // Same ingredient twice in one recipe → sum (refinement #2), unless the two
      // lines use incompatible dimensions (e.g. grams then millilitres).
      if (existing.dimension !== dimension) {
        add('unit', 'UNIT_MISMATCH');
      } else {
        existing.quantityCanonical += quantityCanonical;
      }
      continue;
    }
    if (group.lines.length >= RECIPE_LIMITS.maxLines) {
      add('ingredient', 'TOO_LONG');
      continue;
    }
    group.lines.push({ ingredientName: ingredientRaw, normalizedName, quantityCanonical, dimension });
  }

  if (dataRows === 0) return { ok: false, error: 'NO_DATA_ROWS' };
  return { ok: true, recipes: order.map((k) => groups.get(k)!), issues };
}

/* -------------------------------------------------------------------------- */
/* Transactions                                                               */
/* -------------------------------------------------------------------------- */

export function parseTransactions(
  matrix: string[][],
): ParseResult<DraftTransactionRow> {
  const planned = planHeader(
    matrix,
    TRANSACTION_COLUMNS,
    TRANSACTION_REQUIRED_COLUMNS,
  );
  if (!planned.ok) return planned;
  const { plan } = planned;

  const rows: ParsedRow<DraftTransactionRow>[] = [];
  let dataRows = 0;

  for (let i = plan.headerRowIndex + 1; i < matrix.length; i++) {
    const raw = matrix[i]!;
    if (isBlankRow(raw)) continue;
    dataRows += 1;
    if (dataRows > MAX_IMPORT_ROWS) return { ok: false, error: 'TOO_MANY_ROWS' };

    const line = i + 1;
    const issues: ImportRowIssue[] = [];
    const add = (column: string, code: ImportRowIssue['code']) =>
      issues.push({ line, column, code });

    const dateRaw = cell(raw, plan, 'date');
    const validDate = dateStringSchema.safeParse(dateRaw).success;
    if (dateRaw === '') add('date', 'MISSING_REQUIRED');
    else if (!validDate) add('date', 'INVALID_DATE');

    const typeRaw = cell(raw, plan, 'type');
    const type = asTransactionType(typeRaw);
    if (typeRaw === '') add('type', 'MISSING_REQUIRED');
    else if (!type) add('type', 'INVALID_TYPE');

    const categoryName = cell(raw, plan, 'category');
    if (categoryName === '') add('category', 'MISSING_REQUIRED');
    else if (categoryName.length > IMPORT_LIMITS.category) add('category', 'TOO_LONG');

    const amountRaw = cell(raw, plan, 'amount');
    let amountCents = 0;
    if (amountRaw === '') add('amount', 'MISSING_REQUIRED');
    else {
      const parsed = parseAmountCell(amountRaw);
      if ('error' in parsed) add('amount', 'INVALID_NUMBER');
      else if (parsed.cents <= 0) add('amount', 'NEGATIVE_AMOUNT');
      else amountCents = parsed.cents;
    }

    const noteRaw = cell(raw, plan, 'note');
    if (noteRaw.length > IMPORT_LIMITS.note) add('note', 'TOO_LONG');
    const note = noteRaw === '' ? null : noteRaw;

    const draft =
      issues.length > 0 || !type
        ? null
        : { type, categoryName, occurredOn: dateRaw, amountCents, note };

    rows.push({ line, draft, issues });
  }

  if (dataRows === 0) return { ok: false, error: 'NO_DATA_ROWS' };
  return { ok: true, rows };
}

/* -------------------------------------------------------------------------- */
/* Sales (Sprint 12b)                                                         */
/* -------------------------------------------------------------------------- */

/**
 * A parsed sale-item line (pre-resolution). Captures the RAW date string (the group
 * key for daily closes — may be invalid) plus the structural fields. `itemKind` is
 * null when the cell is missing/unknown. `taxRateBps` is null when the row left
 * `tax_rate_percent` blank, meaning "use the org default" (applied in the data-layer
 * planner — the parser has no org access). A row carrying any hard issue still
 * produces a draft so its close can be tainted; cleanliness = `issues.length === 0`.
 */
export type DraftSaleImportRow = {
  /** Raw trimmed `date` cell — the daily-close grouping key (possibly invalid/empty). */
  saleDate: string;
  itemKind: ImportSaleItemKind | null;
  /** Raw item name (display + frozen item_name source). */
  itemName: string;
  /** Lower/trim/collapsed key used for exact catalogue resolution. */
  normalizedItemName: string;
  quantity: number;
  /** Canonical stock per sold unit (ingredient lines only); null otherwise. */
  ingredientQtyCanonical: number | null;
  unitNetCents: number;
  /** Per-line tax rate in bps, or null to inherit the org default at planning. */
  taxRateBps: number | null;
};

/** Normalized comparison key for a sale item name (shared with the data-layer resolver). */
export const normalizeSaleItemName = (s: string): string =>
  s.trim().toLowerCase().replace(/\s+/g, ' ');

/** Coerce a raw cell to the sale item-kind union, or null when invalid. */
function asSaleItemKind(raw: string): ImportSaleItemKind | null {
  const v = normalize(raw);
  return v === 'recipe' || v === 'menu' || v === 'ingredient' ? v : null;
}

/** Parse a positive decimal (comma tolerated) capped at NUMERIC_12_2_MAX. Not money. */
function parseCanonicalQtyCell(
  raw: string,
): { value: number } | { error: 'INVALID_NUMBER' } {
  const trimmed = raw.trim();
  if (!/\d/.test(trimmed) || /[A-Za-z]/.test(trimmed)) return { error: 'INVALID_NUMBER' };
  const value = Number(trimmed.replace(',', '.'));
  if (!Number.isFinite(value) || value <= 0 || value > NUMERIC_12_2_MAX) {
    return { error: 'INVALID_NUMBER' };
  }
  return { value };
}

/**
 * Pure, deterministic parsing of a sales matrix into draft sale lines (Sprint 12b).
 * LONG format — one row per sale-item line, later grouped into daily closes by the
 * data-layer planner (the parser does NOT group, resolve item ids, dedup dates, or
 * touch org data). Structural validation only: date/kind/name/quantity/money/tax%/
 * canonical-qty shape + length + row cap. A row that carries a hard issue STILL
 * yields a draft (with its raw date) so the planner can mark the whole close invalid.
 */
export function parseSalesRows(matrix: string[][]): ParseResult<DraftSaleImportRow> {
  const planned = planHeader(matrix, SALES_COLUMNS, SALES_REQUIRED_COLUMNS);
  if (!planned.ok) return planned;
  const { plan } = planned;

  const rows: ParsedRow<DraftSaleImportRow>[] = [];
  let dataRows = 0;

  for (let i = plan.headerRowIndex + 1; i < matrix.length; i++) {
    const raw = matrix[i]!;
    if (isBlankRow(raw)) continue;
    dataRows += 1;
    if (dataRows > MAX_IMPORT_ROWS) return { ok: false, error: 'TOO_MANY_ROWS' };

    const line = i + 1;
    const issues: ImportRowIssue[] = [];
    const add = (column: string, code: ImportRowIssue['code']) =>
      issues.push({ line, column, code });

    // Date (the close grouping key — kept raw even when invalid).
    const saleDate = cell(raw, plan, 'date');
    if (saleDate === '') add('date', 'MISSING_REQUIRED');
    else if (!dateStringSchema.safeParse(saleDate).success) add('date', 'INVALID_DATE');

    // Item kind.
    const kindRaw = cell(raw, plan, 'item_kind');
    const itemKind = asSaleItemKind(kindRaw);
    if (kindRaw === '') add('item_kind', 'MISSING_REQUIRED');
    else if (!itemKind) add('item_kind', 'INVALID_TYPE');

    // Item name.
    const itemName = cell(raw, plan, 'item_name');
    if (itemName === '') add('item_name', 'MISSING_REQUIRED');
    else if (itemName.length > SALES_LIMITS.itemName) add('item_name', 'TOO_LONG');

    // Quantity — positive integer.
    const qtyRaw = cell(raw, plan, 'quantity');
    let quantity = 0;
    if (qtyRaw === '') add('quantity', 'MISSING_REQUIRED');
    else if (!/^\d+$/.test(qtyRaw)) add('quantity', 'INVALID_NUMBER');
    else {
      const n = Number(qtyRaw);
      if (!Number.isInteger(n) || n < 1 || n > 100000) add('quantity', 'INVALID_NUMBER');
      else quantity = n;
    }

    // Unit net price — integer cents, 0 allowed.
    const priceRaw = cell(raw, plan, 'unit_net_price');
    let unitNetCents = 0;
    if (priceRaw === '') add('unit_net_price', 'MISSING_REQUIRED');
    else {
      const parsed = parseAmountCell(priceRaw);
      if ('error' in parsed) add('unit_net_price', 'INVALID_NUMBER');
      else if (parsed.cents < 0) add('unit_net_price', 'NEGATIVE_AMOUNT');
      else if (parsed.cents > 1_000_000_000) add('unit_net_price', 'INVALID_NUMBER');
      else unitNetCents = parsed.cents;
    }

    // Tax rate percent — optional; blank ⇒ null (org default applied at planning).
    const taxRaw = cell(raw, plan, 'tax_rate_percent');
    let taxRateBps: number | null = null;
    if (taxRaw !== '') {
      const numeric = !/[A-Za-z]/.test(taxRaw) && /\d/.test(taxRaw);
      const value = Number(taxRaw.replace(',', '.'));
      if (!numeric || !Number.isFinite(value) || value < 0 || value > 100) {
        add('tax_rate_percent', 'INVALID_NUMBER');
      } else {
        taxRateBps = percentToBps(value);
      }
    }

    // Ingredient canonical quantity — required iff ingredient line, blank otherwise.
    const qtyCanonRaw = cell(raw, plan, 'ingredient_qty_canonical');
    let ingredientQtyCanonical: number | null = null;
    if (itemKind === 'ingredient') {
      if (qtyCanonRaw === '') add('ingredient_qty_canonical', 'MISSING_REQUIRED');
      else {
        const parsed = parseCanonicalQtyCell(qtyCanonRaw);
        if ('error' in parsed) add('ingredient_qty_canonical', 'INVALID_NUMBER');
        else ingredientQtyCanonical = parsed.value;
      }
    } else if (qtyCanonRaw !== '') {
      // A recipe/menu line must NOT carry a per-unit stock quantity.
      add('ingredient_qty_canonical', 'INVALID_NUMBER');
    }

    rows.push({
      line,
      draft: {
        saleDate,
        itemKind,
        itemName,
        normalizedItemName: normalizeSaleItemName(itemName),
        quantity,
        ingredientQtyCanonical,
        unitNetCents,
        taxRateBps,
      },
      issues,
    });
  }

  if (dataRows === 0) return { ok: false, error: 'NO_DATA_ROWS' };
  return { ok: true, rows };
}
