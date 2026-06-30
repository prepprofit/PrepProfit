import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  ingredients,
  ingredientSuppliers,
  recipes,
  transactions,
} from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';
import { normalizeSupplierName } from '@/lib/suppliers/normalize';
import {
  findOrCreateSupplierByName,
  reactivateSupplier,
} from '@/lib/data/suppliers';
import {
  ensureCategoriesSeeded,
  listCategories,
} from '@/lib/data/transaction-categories';
import { createRecipe } from '@/lib/data/recipes';
import { addRecipeIngredient } from '@/lib/data/recipe-ingredients';
import {
  resolveIngredient,
  type IngredientCandidate,
} from '@/lib/import/resolveIngredient';
import type { ParsedRow, DraftTransactionRow, DraftRecipe } from '@/lib/import/parse';
import type {
  ImportIngredientRecord,
  ImportTransactionRecord,
  ImportRecord,
  ImportRowIssue,
  ImportIngredientResolution,
  ImportDimension,
  ImportRecipePayload,
  ImportRecipeRecord,
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

/* -------------------------------------------------------------------------- */
/* Recipes (Sprint 4.6)                                                       */
/* -------------------------------------------------------------------------- */

/** Lower/trim/collapse key for a recipe name (mirrors the parser's grouping). */
const recipeKey = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');

export type RecipeImportPlan = {
  /** The full staged payload (recipe records + per-name resolutions) for the job. */
  payload: ImportRecipePayload;
  /** Parser issues + planning issues (duplicate recipe, exact-link unit mismatch). */
  issues: ImportRowIssue[];
  counts: { total: number; importable: number; skipped: number; invalid: number };
};

/**
 * Plan a recipe import: resolve each DISTINCT ingredient name against the org's
 * active ingredients (exact link / fuzzy suggestions / new — never an auto-link
 * for fuzzy), skip recipes whose name already exists in the org (DUPLICATE_RECIPE,
 * v1 only CREATES), and drop EXACT-linked lines whose unit dimension conflicts
 * with the existing ingredient (UNIT_MISMATCH). The chosen link for a FUZZY name
 * is validated at confirm (the manager decides), so its dimension is checked then.
 *
 * MUST run inside `withOrg` (RLS). Builds the stored job payload + counts; applies
 * nothing.
 */
export async function planRecipeImport(
  db: TenantClient,
  organizationId: string,
  parsed: DraftRecipe[],
  parserIssues: ImportRowIssue[],
): Promise<RecipeImportPlan> {
  const existing = await db
    .select({
      id: ingredients.id,
      name: ingredients.name,
      dimension: ingredients.dimension,
    })
    .from(ingredients)
    .where(and(eq(ingredients.organizationId, organizationId), isNull(ingredients.deletedAt)));

  const candidates: IngredientCandidate[] = existing.map((e) => ({ id: e.id, name: e.name }));
  const dimensionById = new Map(existing.map((e) => [e.id, e.dimension]));

  const existingRecipeRows = await db
    .select({ name: recipes.name })
    .from(recipes)
    .where(and(eq(recipes.organizationId, organizationId), isNull(recipes.deletedAt)));
  const existingRecipeKeys = new Set(existingRecipeRows.map((r) => recipeKey(r.name)));

  // Resolve each distinct ingredient name once. Key = normalized name (the same
  // key the lines carry), so the resolution is shared across recipes.
  const resolutions: Record<string, ImportIngredientResolution> = {};
  const firstRawByName = new Map<string, string>();
  for (const recipe of parsed) {
    for (const line of recipe.lines) {
      if (!firstRawByName.has(line.normalizedName)) {
        firstRawByName.set(line.normalizedName, line.ingredientName);
      }
    }
  }
  for (const [normName, raw] of firstRawByName) {
    const outcome = resolveIngredient(raw, candidates);
    if (outcome.kind === 'exact') {
      resolutions[normName] = {
        kind: 'exact',
        ingredientId: outcome.ingredientId,
        ingredientName: outcome.name,
      };
    } else if (outcome.kind === 'fuzzy') {
      resolutions[normName] = { kind: 'fuzzy', suggestions: outcome.suggestions };
    } else {
      resolutions[normName] = { kind: 'new' };
    }
  }

  const issues = [...parserIssues];
  const recipeRecords: ImportRecipeRecord[] = [];
  let skipped = 0;

  for (const recipe of parsed) {
    if (existingRecipeKeys.has(recipe.normalizedKey)) {
      issues.push({ line: recipe.firstLine, column: 'recipe', code: 'DUPLICATE_RECIPE' });
      skipped += 1;
      continue;
    }
    const lines = [];
    for (const line of recipe.lines) {
      const res = resolutions[line.normalizedName];
      // An EXACT auto-link whose dimension disagrees with the existing ingredient
      // can't be honored — drop the line and flag it (the canonical quantity would
      // be in the wrong dimension). Fuzzy links are validated at confirm.
      if (res?.kind === 'exact') {
        const existingDim = dimensionById.get(res.ingredientId);
        if (existingDim && existingDim !== line.dimension) {
          issues.push({ line: recipe.firstLine, column: 'ingredient', code: 'UNIT_MISMATCH' });
          continue;
        }
      }
      lines.push({
        ingredientName: line.ingredientName,
        normalizedName: line.normalizedName,
        quantityCanonical: line.quantityCanonical,
        dimension: line.dimension,
      });
    }
    recipeRecords.push({
      name: recipe.name,
      yieldPortions: recipe.yieldPortions,
      yieldPercentage: recipe.yieldPercentage,
      notes: recipe.notes,
      lines,
    });
  }

  return {
    payload: { recipes: recipeRecords, resolutions },
    issues,
    counts: {
      total: parsed.length,
      importable: recipeRecords.length,
      skipped,
      invalid: 0,
    },
  };
}

/** A confirmed per-name resolution choice (validated against the stored suggestions). */
export type ResolvedChoice =
  | { action: 'create' }
  | { action: 'link'; ingredientId: string };

/**
 * Apply a planned recipe import inside the caller's transaction (all-or-nothing):
 * create the chosen NEW ingredients (priceCents 0, needs pricing) once each, then
 * create the recipes and their lines. Lines are summed per resolved ingredient id
 * within a recipe (two source names can resolve to one ingredient — the
 * recipe_ingredients unique key is per ingredient). A line whose dimension does
 * not match its resolved ingredient is skipped (defense; plan already dropped the
 * exact case). Returns the number of recipes created.
 */
export async function applyRecipeImport(
  db: TenantClient,
  organizationId: string,
  payload: ImportRecipePayload,
  choices: Map<string, ResolvedChoice>,
): Promise<number> {
  // First occurrence of each name → display + dimension, for creating new rows.
  const nameMeta = new Map<string, { displayName: string; dimension: 'weight' | 'volume' | 'count' }>();
  for (const recipe of payload.recipes) {
    for (const line of recipe.lines) {
      if (!nameMeta.has(line.normalizedName)) {
        nameMeta.set(line.normalizedName, {
          displayName: line.ingredientName,
          dimension: line.dimension,
        });
      }
    }
  }

  const idByName = new Map<string, string>();
  const dimById = new Map<string, 'weight' | 'volume' | 'count'>();

  // Load dimensions of all linked (existing) ingredients in one query.
  const linkedIds = [...choices.values()]
    .filter((c): c is { action: 'link'; ingredientId: string } => c.action === 'link')
    .map((c) => c.ingredientId);
  if (linkedIds.length > 0) {
    const rows = await db
      .select({ id: ingredients.id, dimension: ingredients.dimension })
      .from(ingredients)
      .where(
        and(
          eq(ingredients.organizationId, organizationId),
          isNull(ingredients.deletedAt),
          inArray(ingredients.id, linkedIds),
        ),
      );
    for (const r of rows) dimById.set(r.id, r.dimension);
  }

  for (const [name, choice] of choices) {
    if (choice.action === 'link') {
      idByName.set(name, choice.ingredientId);
      continue;
    }
    const meta = nameMeta.get(name);
    if (!meta) continue; // a resolution with no referencing line — nothing to create
    const [row] = await db
      .insert(ingredients)
      .values({
        organizationId,
        name: meta.displayName.slice(0, 120),
        dimension: meta.dimension,
        priceCents: 0,
        needsPricing: true,
      })
      .returning({ id: ingredients.id });
    if (!row) throw new Error('Failed to create ingredient during recipe import.');
    idByName.set(name, row.id);
    dimById.set(row.id, meta.dimension);
  }

  let created = 0;
  for (const recipe of payload.recipes) {
    const row = await createRecipe(db, organizationId, {
      name: recipe.name,
      yieldPortions: recipe.yieldPortions,
      yieldPercentage: recipe.yieldPercentage,
      notes: recipe.notes,
    });

    // Sum quantities per resolved ingredient id, preserving first-seen order.
    const qtyById = new Map<string, number>();
    const sortById = new Map<string, number>();
    let sort = 0;
    for (const line of recipe.lines) {
      const id = idByName.get(line.normalizedName);
      if (!id) continue;
      const dim = dimById.get(id);
      if (dim === undefined || dim !== line.dimension) continue; // skip a mismatch
      qtyById.set(id, (qtyById.get(id) ?? 0) + line.quantityCanonical);
      if (!sortById.has(id)) sortById.set(id, sort++);
    }
    for (const [ingredientId, quantity] of qtyById) {
      await addRecipeIngredient(db, organizationId, {
        recipeId: row.id,
        ingredientId,
        quantity,
        sortOrder: sortById.get(ingredientId) ?? 0,
      });
    }
    created += 1;
  }
  return created;
}

/**
 * Resolve the client's resolution choices into apply-ready actions (Sprint 4.7
 * inline-match revision). An EXACT name is force-linked to its stored match; a NEW
 * or FUZZY name may either link to ANY ingredient id the client chose (the inline
 * ingredient search lets the manager pick a match the server never suggested) or
 * default to create. A missing/empty `link` id is the only structural reject here.
 *
 * The previous D8 rule ("a fuzzy link must be one of the offered suggestion ids; a
 * new name can never link") is deliberately RELAXED — it blocked the inline search.
 * The trust boundary is NOT this pure function: `confirmImportAction` re-checks,
 * inside `withOrg`, that every returned `linkId` is an ACTIVE ingredient of the
 * current org (RLS + `deleted_at IS NULL`) and that its dimension matches the
 * line's (see {@link findResolutionDimensionMismatches}). `organizationId` is never
 * taken from the client. A name with no client choice still defaults to `create`.
 */
export function buildResolvedChoices(
  resolutions: Record<string, ImportIngredientResolution>,
  clientChoices: { name: string; action: 'link' | 'create'; ingredientId?: string }[],
): { ok: true; choices: Map<string, ResolvedChoice>; linkIds: string[] } | { ok: false } {
  const byName = new Map(clientChoices.map((c) => [c.name, c]));
  const choices = new Map<string, ResolvedChoice>();
  const linkIds: string[] = [];

  for (const [name, res] of Object.entries(resolutions)) {
    if (res.kind === 'exact') {
      choices.set(name, { action: 'link', ingredientId: res.ingredientId });
      linkIds.push(res.ingredientId);
      continue;
    }
    // new / fuzzy: link to any id the client chose (org/active/dimension re-checked
    // downstream), otherwise create. An empty link id is malformed → reject.
    const c = byName.get(name);
    if (c && c.action === 'link') {
      if (!c.ingredientId) return { ok: false };
      choices.set(name, { action: 'link', ingredientId: c.ingredientId });
      linkIds.push(c.ingredientId);
    } else {
      choices.set(name, { action: 'create' });
    }
  }
  return { ok: true, choices, linkIds };
}

/** One link choice whose chosen ingredient's dimension conflicts with a recipe line. */
export type ResolutionDimensionMismatch = {
  /** Normalized ingredient name (the resolutions/choices key). */
  normalizedName: string;
  /** A recipe-line dimension that does not match the linked ingredient. */
  lineDimension: ImportDimension;
  /** The linked ingredient's actual dimension. */
  ingredientDimension: ImportDimension;
};

/**
 * Find link choices whose chosen ingredient measures in a DIFFERENT dimension than
 * the recipe line(s) using that name (e.g. a line in grams linked to a volume
 * ingredient). Pure and DB-free — the caller passes `dimensionById` for the linked
 * ids (loaded inside `withOrg`).
 *
 * Critical for the inline search (Sprint 4.7): `applyRecipeImport` silently SKIPS a
 * dimension-mismatched line, which would drop ingredients from the recipe without a
 * trace. The confirm path runs this BEFORE applying and rejects atomically instead,
 * and the UI blocks the same case — so a manual mis-link never produces a partial
 * recipe. An id absent from `dimensionById` is ignored here (the active-id re-check
 * already rejects it).
 */
export function findResolutionDimensionMismatches(
  payload: ImportRecipePayload,
  choices: Map<string, ResolvedChoice>,
  dimensionById: Map<string, ImportDimension>,
): ResolutionDimensionMismatch[] {
  const lineDimsByName = new Map<string, Set<ImportDimension>>();
  for (const recipe of payload.recipes) {
    for (const line of recipe.lines) {
      let dims = lineDimsByName.get(line.normalizedName);
      if (!dims) {
        dims = new Set();
        lineDimsByName.set(line.normalizedName, dims);
      }
      dims.add(line.dimension);
    }
  }

  const mismatches: ResolutionDimensionMismatch[] = [];
  for (const [name, choice] of choices) {
    if (choice.action !== 'link') continue;
    const ingredientDimension = dimensionById.get(choice.ingredientId);
    if (ingredientDimension === undefined) continue; // active-id re-check handles this
    const lineDims = lineDimsByName.get(name);
    if (!lineDims) continue;
    for (const lineDimension of lineDims) {
      if (lineDimension !== ingredientDimension) {
        mismatches.push({ normalizedName: name, lineDimension, ingredientDimension });
        break;
      }
    }
  }
  return mismatches;
}

/**
 * Insert ingredient records in the caller's transaction (Sprint 4.5; Sprint 7
 * supplier dual-write). For each record with a non-blank `supplier` cell, the
 * supplier becomes a real record + a DEFAULT `ingredient_suppliers` link, and the
 * legacy `ingredients.supplier` column mirrors the supplier's CANONICAL name — all
 * in this ONE transaction (transition contract §5/§6, §12.12).
 *
 * Suppliers are resolved by their NORMALIZED name (find-or-create, atomic), never
 * by `RETURNING` order: a `normalizedName → supplierId` map is built first, then
 * each ingredient is inserted and linked by explicit id. An archived supplier whose
 * name reappears in an import is reactivated (the import implies it is current).
 * Returns the number of ingredients created.
 */
export async function applyIngredientRecords(
  db: TenantClient,
  organizationId: string,
  records: ImportIngredientRecord[],
): Promise<number> {
  if (records.length === 0) return 0;

  // 1. Resolve every distinct supplier name once → id + canonical display name.
  const supplierByNorm = new Map<string, { id: string; name: string }>();
  for (const r of records) {
    if (!r.supplier) continue;
    const norm = normalizeSupplierName(r.supplier);
    if (norm === '' || supplierByNorm.has(norm)) continue;
    const found = await findOrCreateSupplierByName(db, organizationId, r.supplier);
    if (found.status === 'invalid_name') continue;
    let supplier = found.supplier;
    if (found.status === 'inactive') {
      const reactivated = await reactivateSupplier(db, organizationId, supplier.id);
      if (reactivated) supplier = reactivated;
    }
    supplierByNorm.set(norm, { id: supplier.id, name: supplier.name });
  }

  // 2. Insert each ingredient, then (if it had a supplier) its default link.
  for (const r of records) {
    const resolved = r.supplier
      ? supplierByNorm.get(normalizeSupplierName(r.supplier))
      : undefined;
    const [ing] = await db
      .insert(ingredients)
      .values({
        organizationId,
        name: r.name,
        dimension: r.dimension,
        priceCents: r.priceCents,
        // Persist the "needs pricing" flag (Sprint 4.6 column): a blank/zero price
        // imports as 0 cents and is flagged for pricing, so cost stays honest.
        needsPricing: r.needsPricing,
        // Legacy mirror = the supplier's canonical name (or the raw cell if it had
        // no resolvable supplier).
        supplier: resolved ? resolved.name : r.supplier,
      })
      .returning({ id: ingredients.id });
    if (!ing) throw new Error('Failed to create ingredient during import.');

    if (resolved) {
      await db
        .insert(ingredientSuppliers)
        .values({
          organizationId,
          ingredientId: ing.id,
          supplierId: resolved.id,
          isDefault: true,
        })
        .onConflictDoNothing({
          target: [
            ingredientSuppliers.organizationId,
            ingredientSuppliers.ingredientId,
            ingredientSuppliers.supplierId,
          ],
        });
    }
  }
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
