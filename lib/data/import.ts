import { and, eq, isNull } from 'drizzle-orm';
import { ingredients, transactions } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';
import {
  ensureCategoriesSeeded,
  listCategories,
} from '@/lib/data/transaction-categories';
import type { ParsedRow, DraftTransactionRow } from '@/lib/import/parse';
import type {
  ImportIngredientRecord,
  ImportTransactionRecord,
  ImportRecord,
  ImportRowIssue,
} from '@/lib/import/types';

/**
 * DB-dependent import PLANNING + APPLY (Sprint 4.5). The pure parser produces
 * structurally-valid draft rows; planning resolves what only the org's data can
 * decide — duplicate ingredient names (skipped, never updated) and category-name
 * resolution (unknown → skipped) — turning drafts into insert-ready records.
 *
 * ALWAYS org-scoped (RULE #1); MUST run inside `withOrg` so RLS is active. Apply
 * inserts every record in the caller's single transaction (all-or-nothing).
 */

export type ImportPlan<T extends ImportRecord = ImportRecord> = {
  /** Insert-ready records (the importable rows), narrowed to the entity type. */
  records: T[];
  /** Every per-row issue: parser (structural) + planning (duplicate/unknown). */
  issues: ImportRowIssue[];
  counts: {
    total: number;
    importable: number;
    /** Excluded by a soft check (duplicate name / unknown category). */
    skipped: number;
    /** Excluded by a hard structural issue (bad date, missing field, …). */
    invalid: number;
  };
};

async function activeIngredientNames(
  db: TenantClient,
  organizationId: string,
): Promise<string[]> {
  const rows = await db
    .select({ name: ingredients.name })
    .from(ingredients)
    .where(
      and(
        eq(ingredients.organizationId, organizationId),
        isNull(ingredients.deletedAt),
      ),
    );
  return rows.map((r) => r.name);
}

/**
 * Plan an ingredient import: skip rows whose name already exists in the org (no
 * silent updates) or repeats earlier in the file. Comparison is case-insensitive.
 */
export async function planIngredientImport(
  db: TenantClient,
  organizationId: string,
  parsed: ParsedRow<ImportIngredientRecord>[],
): Promise<ImportPlan<ImportIngredientRecord>> {
  const existing = new Set(
    (await activeIngredientNames(db, organizationId)).map((n) => n.toLowerCase()),
  );
  const seen = new Set<string>();
  const records: ImportIngredientRecord[] = [];
  const issues: ImportRowIssue[] = [];
  let skipped = 0;
  let invalid = 0;

  for (const row of parsed) {
    issues.push(...row.issues);
    if (!row.draft) {
      invalid += 1;
      continue;
    }
    const key = row.draft.name.toLowerCase();
    if (existing.has(key) || seen.has(key)) {
      issues.push({ line: row.line, column: 'name', code: 'DUPLICATE' });
      skipped += 1;
      continue;
    }
    seen.add(key);
    records.push(row.draft);
  }

  return {
    records,
    issues,
    counts: { total: parsed.length, importable: records.length, skipped, invalid },
  };
}

/**
 * Plan a transaction import: resolve each row's category NAME to an org-scoped id
 * matching the row's kind (income/expense). Seeds predefined categories first so
 * an app-exported file (which writes category row names) re-imports. An unknown
 * name is a skip (the row is excluded), never an auto-created category in v1.
 */
export async function planTransactionImport(
  db: TenantClient,
  organizationId: string,
  parsed: ParsedRow<DraftTransactionRow>[],
): Promise<ImportPlan<ImportTransactionRecord>> {
  await ensureCategoriesSeeded(db, organizationId);
  const categories = await listCategories(db, organizationId);
  const byKindName = new Map<string, { id: string; name: string }>();
  for (const c of categories) {
    byKindName.set(`${c.kind}:${c.name.toLowerCase()}`, { id: c.id, name: c.name });
  }

  const records: ImportTransactionRecord[] = [];
  const issues: ImportRowIssue[] = [];
  let skipped = 0;
  let invalid = 0;

  for (const row of parsed) {
    issues.push(...row.issues);
    if (!row.draft) {
      invalid += 1;
      continue;
    }
    const match = byKindName.get(
      `${row.draft.type}:${row.draft.categoryName.toLowerCase()}`,
    );
    if (!match) {
      issues.push({ line: row.line, column: 'category', code: 'UNKNOWN_CATEGORY' });
      skipped += 1;
      continue;
    }
    records.push({
      type: row.draft.type,
      categoryId: match.id,
      categoryName: match.name,
      occurredOn: row.draft.occurredOn,
      amountCents: row.draft.amountCents,
      recipeId: null,
      note: row.draft.note,
    });
  }

  return {
    records,
    issues,
    counts: { total: parsed.length, importable: records.length, skipped, invalid },
  };
}

/** Bulk-insert ingredient records in the caller's transaction. Returns the count. */
export async function applyIngredientRecords(
  db: TenantClient,
  organizationId: string,
  records: ImportIngredientRecord[],
): Promise<number> {
  if (records.length === 0) return 0;
  await db.insert(ingredients).values(
    records.map((r) => ({
      organizationId,
      name: r.name,
      dimension: r.dimension,
      priceCents: r.priceCents,
      supplier: r.supplier,
    })),
  );
  return records.length;
}

/**
 * Bulk-insert transaction records in the caller's transaction. The composite
 * (organization_id, category_id) FK rejects a category that vanished since
 * preview — the caller maps that to a confirm-time conflict and rolls back.
 */
export async function applyTransactionRecords(
  db: TenantClient,
  organizationId: string,
  records: ImportTransactionRecord[],
): Promise<number> {
  if (records.length === 0) return 0;
  await db.insert(transactions).values(
    records.map((r) => ({
      organizationId,
      type: r.type,
      categoryId: r.categoryId,
      recipeId: r.recipeId,
      occurredOn: r.occurredOn,
      amountCents: r.amountCents,
      note: r.note,
    })),
  );
  return records.length;
}
