# Sprint F3 — Snapshot / purge / reversal policy — implementation plan

> **Status:** **Scope A AUTHORIZED (2026-06-21)** after dev review — corrections
> applied (see §0a). F1 + F2 are merged + prod-migrated. Build in one slice, full
> review at the end. **No migration in F3.** Source spec:
> `docs/expansion-plan-kitchen-ops.md` §4 F3.

---

## 0. Read this first — F3 is a POLICY slice, not a feature

F3 governs **documents** (purchase orders, sales, productions + their PDFs). **None
of those tables exist yet** — they are Sprints 7/8/11/12. So F3 cannot "build the
snapshots" end-to-end; what it ships is the **contract + a pure snapshot primitive +
the missing regression test**, so every later document sprint follows ONE consistent
pattern instead of re-inventing it.

## 0a. Corrections from the dev review (folded in)

1. **The contradiction is fixed.** The existing `invoices` ↔ `customers` behavior is
   a precedent for **SNAPSHOT ONLY, not purge-block**: on customer purge, the code
   **nulls `customer_id` and keeps the frozen snapshot** (`lib/data/trash.ts`
   `purgeExpired`, and the tests confirm it). It does the OPPOSITE of blocking a
   purge. The earlier draft wrongly cited it as a purge-block precedent.
2. **Purge-block is a forward CONTRACT only.** Scope A does not add `archived_at`,
   so it can neither implement nor test purge-block. F3 therefore **documents
   purge-block as the contract** for future documents; the **first real
   implementation + proof lands in Sprint 7/8, together with `archived_at`**.
3. **No `nullLinkThenPurge` extraction now.** The current purge sequences have
   different orderings and a generic Drizzle abstraction risks `any`/casts. F3 only
   **documents** the existing patterns; extraction is deferred to **F6**.
4. **No migration `0022`.** Scope A is helpers + contract + one test.

---

## 1. The three policies F3 codifies (in `docs/document-snapshot-policy.md`)

### A. Snapshot-on-issue (immutable historical documents) — PRECEDENT EXISTS
A non-draft document stores an **immutable snapshot** of every master it depends on,
captured at the **draft → issued/post transition, inside the SAME transaction/lock**,
and **never received from the client**. Reads render the snapshot, never the live
master. Reference: `invoices` freezes `customer_name/tax_id/address/email` at issue
(`lib/db/schema.ts` ~L581); editing or purging the customer afterwards never changes
the issued invoice.

### B. Purge-block for non-draft references — CONTRACT ONLY (proof in Sprint 7/8)
- A master (ingredient / recipe / supplier) referenced by **any non-draft document**
  must be **archived, never hard-deleted**, so the historical document stays valid.
- A master referenced **only by drafts** may purge **after the draft link is nulled**.
- A master with **no document references** purges normally (today's behavior).

> **Not implemented in F3.** There are no non-draft document tables yet, and Scope A
> adds no `archived_at`. This rule is written down as the contract; Sprint 7/8 add
> `archived_at` + the first reference check + the proving tests. (Note: invoices are
> NOT this precedent — see §0a.1.)

### C. Retention / reversal — ALREADY TRUE (no F3 code)
- `ingredient_price_history` retained until the ingredient is fully purged (F2
  cascade FK).
- `inventory_movements` corrections are reversals (opposite inserts), never
  edits/deletes (F1 append-only RLS).
- F3 only cross-references these; it adds **no** new code or tests for them (already
  covered — see §4 "do not duplicate").

---

## 2. What F3 ships

### 2a. Pure snapshot primitive — `lib/documents/snapshots.ts` (NEW)
Pure functions + types that freeze an EXISTING master into document-line snapshot
fields. Reused by Sprints 8/11/12. Takes a **narrow `Pick`**, not the whole row.

```ts
import type { Ingredient, Recipe } from '@/lib/db/schema';
import type { Dimension } from '@/lib/units';

export type IngredientLineSnapshot = {
  ingredientName: string;
  // Approved cost per priced unit at capture (per kg/l/piece), integer cents.
  // Named *cost* (not price): a future sale/PO line may carry BOTH a cost and a
  // selling price, so the cost snapshot must be unambiguous.
  unitCostCents: number;
  dimension: Dimension;
};
export function ingredientLineSnapshot(
  ing: Pick<Ingredient, 'name' | 'priceCents' | 'dimension'>,
): IngredientLineSnapshot;

export type RecipeLineSnapshot = {
  recipeName: string;
  portionCostCents: number; // the single number the document used at capture
};
export function recipeLineSnapshot(
  recipe: Pick<Recipe, 'name'>,
  portionCostCents: number,
): RecipeLineSnapshot;
```

Fully unit-testable now (pure). **`supplierSnapshot` is NOT here** — `suppliers`
doesn't exist until Sprint 7; it lands there (leave a one-line note in the file).
Lives in `lib/documents/` alongside the existing view-models (approved §5.3).

### 2b. The contract doc — `docs/document-snapshot-policy.md` (NEW)
The authoritative doc later document sprints cite. Contents:
- the snapshot convention: **flat frozen COLUMNS** (like invoices — approved §5.2),
  a live link (`ON DELETE restrict`, nullable) + frozen snapshot fields;
- snapshots are built **in the same transaction/lock as draft → issued/post, never
  from the client**;
- the purge-block contract (§1.B) — to be implemented with `archived_at` in Sprint
  7/8;
- a note on the EXISTING purge patterns in `lib/data/trash.ts` (null-link-then-delete
  for restrict FKs; `NOT EXISTS` skip for the ingredient↔recipe-line pin) and that
  **generic extraction is deferred to F6** — document sprints follow the pattern
  inline for now.

### 2c. The ONE missing test (NEW)
- `lib/documents/snapshots.test.ts` — the pure helpers (names, `unitCostCents`,
  `portionCostCents`, money/edge values). **(Single test location — the earlier
  draft mentioned two paths; use this one.)**
- The **historical-snapshot** test that is currently missing: **edit the master
  AFTER issue and prove the document does not change.** Use the only existing issued
  document (invoices): create a customer → create + issue an invoice (snapshot
  frozen) → rename/edit the customer → re-read the invoice and assert the customer
  SNAPSHOT is unchanged. Put it in `tests/snapshot-policy.test.ts` (PGlite). This
  proves immutability against a master EDIT (the purge case is already covered).

**No schema change, no migration.**

---

## 3. Files

### CREATE
- `lib/documents/snapshots.ts` + `lib/documents/snapshots.test.ts`.
- `docs/document-snapshot-policy.md`.
- `tests/snapshot-policy.test.ts` (the edit-after-issue invoice regression).

### CHANGE
- None required. (No `lib/data/trash.ts` refactor — deferred to F6, §0a.3. No schema,
  no `account-export`, no migration.)

---

## 4. Do NOT duplicate (already covered — dev review)

These invariants already have tests; F3 adds nothing for them:
- `ingredient_price_history` cascade-deletes with the ingredient → `tests/ingredient-pricing.test.ts` (F2).
- `inventory_movements` append-only (UPDATE/DELETE blocked) → `tests/inventory-idempotency.test.ts` (F1).
- invoice keeps the customer snapshot AFTER the customer is purged → existing trash/invoice tests.

The only NEW behavioral test is the **edit-master-after-issue** case (§2c).

---

## 5. Decisions — RESOLVED (dev review 2026-06-21)

1. **Scope:** ✅ **Scope A only.** No `archived_at`, **no migration 0022** — the
   archive state has no live consumer until Sprint 7/8 and lands there.
2. **Snapshot storage shape:** ✅ **flat frozen columns** (consistent with invoices,
   indexable, typed).
3. **Helper location:** ✅ `lib/documents/`.
4. **Recipe portion cost:** ✅ store **only `portionCostCents`** at capture.

Extra contract points locked by the review:
- Snapshot helper takes a `Pick<...>`, not the whole `Ingredient`/`Recipe` row.
- Field is `unitCostCents` (not `unitPriceCents`) — future docs may carry cost AND
  selling price.
- Snapshots are built in the issue/post transaction+lock, never client-supplied.

---

## 6. Definition of Done

- `npm run lint && npm run typecheck && npm test && npm run build` green.
- `lib/documents/snapshots.ts` pure helpers tested (incl. money/edge values).
- The edit-master-after-issue regression (`tests/snapshot-policy.test.ts`) passes.
- `docs/document-snapshot-policy.md` committed (the contract later sprints cite).
- No migration, no schema change, no `trash.ts` refactor.
- **Full diff handed to the dev before F4 is authorized.** F4–F6 stay unauthorized.

---

## 7. Out of scope for F3 (do NOT build)

- `archived_at` + the purge-block implementation + its proof → **Sprint 7/8**.
- Generic purge/GDPR/seed **registry** + `nullLinkThenPurge` extraction → **F6**.
- `supplierSnapshot` + `suppliers`/PO tables → **Sprint 7/8**.
- Actual PO / sale / production snapshot columns + PDFs → their sprints (8a/8b/11/12),
  each consuming `lib/documents/snapshots.ts`.
- The F4 RBAC money-visibility retrofit → **F4**.

---

## 8. Codebase anchors

- `lib/db/schema.ts` — `invoices` customer snapshot (~L581, the SNAPSHOT precedent);
  `customers` purge comment (~L506).
- `lib/data/trash.ts` — `purgeExpired`: null-link-then-delete + `NOT EXISTS` skip
  (the patterns to DOCUMENT, not extract).
- `lib/data/invoices.ts` — the draft → issued transition that freezes the snapshot
  (the edit-after-issue test drives this).
- `lib/documents/` — existing document view-model convention.
- Test patterns: `tests/trash.test.ts`, `tests/invoice-*.test.ts`,
  `tests/helpers/db.ts` (PGlite + RLS).
