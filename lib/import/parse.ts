import { parseMoneyToCents } from '@/lib/format/money';
import { dateStringSchema } from '@/lib/validation/transactions';
import {
  INGREDIENT_COLUMNS,
  INGREDIENT_REQUIRED_COLUMNS,
  TRANSACTION_COLUMNS,
  TRANSACTION_REQUIRED_COLUMNS,
  IMPORT_LIMITS,
  MAX_IMPORT_ROWS,
} from '@/lib/validation/import';
import { parseCsv } from './csv';
import { parseXlsx } from './xlsx';
import type {
  ImportFormat,
  ImportIngredientRecord,
  ImportRowIssue,
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
