# Document snapshot / purge / reversal policy

> **Status:** the authoritative contract every later *document* sprint cites
> (purchase orders, sales, productions + their PDFs — Sprints 7/8/11/12).
> Established in **Sprint F3 (Scope A, 2026-06-21)**. F3 ships the contract + the
> pure snapshot primitive (`lib/documents/snapshots.ts`) + the missing regression
> test (`tests/snapshot-policy.test.ts`). It adds **no schema, no migration, no
> `archived_at`, and no `trash.ts` refactor** — those land in the sprints noted
> below.

A "document" here is an **immutable historical record** of a business event: an
issued invoice today, and later a posted purchase order, a recorded sale, a logged
production run. The masters those documents reference (customers, ingredients,
recipes, and — from Sprint 7 — suppliers) keep changing. This policy fixes how a
document stays truthful about *what was real at the moment it was issued*, even as
the masters drift or are deleted.

There are three policies. **A** has a shipped precedent (invoices). **B** is a
forward contract with no implementation yet. **C** is already true and needs no new
code.

---

## A. Snapshot-on-issue — immutable historical documents

**Rule.** A non-draft document stores an **immutable snapshot** of every master it
depends on. The snapshot is:

- captured at the **draft → issued/post transition**, **inside the SAME
  transaction and under the same row lock** that performs the transition;
- **never received from the client** — the server loads the live master and freezes
  it; a client-supplied snapshot would let a caller forge history;
- read back verbatim — a document's PDF/print/list view renders the **snapshot**,
  never the live master.

**Storage shape: flat frozen COLUMNS.** A document table carries, side by side:

- a **live link** to the master — a nullable composite `(organization_id,
  master_id)` foreign key, `ON DELETE restrict` (so a master can't vanish out from
  under a non-draft document; see Policy B for how purge is handled); and
- the **frozen snapshot fields** as plain typed columns on the document row.

This mirrors `invoices`, which is the shipped precedent:

- `lib/db/schema.ts` — `invoices` has both `customer_id` (the live link,
  `invoices_customer_fk`, `ON DELETE restrict`, nullable) and the frozen
  `customer_name` / `customer_tax_id` / `customer_address` / `customer_email`
  columns alongside the frozen monetary totals (`subtotal_cents` / `tax_cents` /
  `total_cents`).
- `lib/data/invoices.ts` — `issueInvoice` takes a `FOR UPDATE` lock, loads the
  active customer, and writes the snapshot + frozen totals in the same `withOrg`
  transaction that flips `status` to `issued`. Editing or deleting the customer
  afterwards never changes the issued invoice.
- `lib/documents/invoice-data.ts` — the view-model reads the frozen columns; it
  never re-joins the live customer for an issued invoice.

Flat columns (over a JSON blob) keep the snapshot typed, indexable, and searchable
the same way the rest of the schema is.

### The pure snapshot primitive — `lib/documents/snapshots.ts`

So every document sprint freezes masters the *same* way, F3 ships pure helpers that
turn an existing master row into the flat snapshot fields:

- `ingredientLineSnapshot(ing)` → `{ ingredientName, unitCostCents, dimension }`.
  The cost field is `unitCostCents` (**not** `unitPriceCents`): a future sale/PO
  line may carry both a purchase cost and a selling price, so the cost snapshot is
  named unambiguously. It takes a narrow `Pick<Ingredient, 'name' | 'priceCents' |
  'dimension'>`.
- `recipeLineSnapshot(recipe, portionCostCents)` → `{ recipeName, portionCostCents
  }`. Portion cost is derived on read (no stored cost column), so the caller
  computes it inside the issue/post transaction and passes the single number to
  freeze; the snapshot keeps **only** `portionCostCents`.

These are pure (no I/O) and take a narrow `Pick`, never the whole row — the caller
loads the master under the issue/post lock and passes the picked fields. A snapshot
is never built from client input.

`supplierSnapshot` is **not** here: the `suppliers` table does not exist until
Sprint 7, so that helper lands there with the supplier/PO schema.

---

## B. Purge-block for non-draft references — CONTRACT ONLY (proof in Sprint 7/8)

**Rule (the contract later document sprints must honour).** A master is governed by
how it is referenced:

- A master (ingredient / recipe / supplier) referenced by **any non-draft
  document** must be **archived, never hard-deleted**, so the historical document
  stays valid. ("Archive" = mark `archived_at`, hide from active pickers, keep the
  row.)
- A master referenced **only by drafts** may be purged **after the draft link is
  nulled** (the draft loses the reference; no history is at stake).
- A master with **no document references** purges normally (today's behaviour).

**Not implemented in F3.** There are no non-draft document tables yet, and Scope A
adds no `archived_at`, so this rule can be neither implemented nor tested now. It is
written down here as the contract; the **first real implementation + the proving
tests land in Sprint 7/8** and the first reference check.

> **Sprint 8a — first Policy-B implementation (purchase orders).** A purchase order
> is the first non-draft document. The rule is now enforced for ingredients
> referenced by a `sent`/`cancelled` PO, **expressed through the existing trash
> "kept" state rather than a new `archived_at` column**: `purgeExpired`
> (`lib/data/trash.ts`) skips an expired-trashed ingredient that is still referenced
> by a non-draft PO line (a correlated `NOT EXISTS`, the same shape as the
> active-recipe-line pin), so that ingredient is retained indefinitely while the PO
> exists. A **draft-only** reference is purged after nulling the draft's line link
> (Policy B's "purge after the draft link is nulled"). Suppliers never reach this
> path — they are archived (`active = false`), never hard-deleted, so the PO's
> `restrict` supplier FK never blocks and the frozen `supplier_*` snapshot is the
> historical truth (Policy A). Proven by `tests/purchase-orders.test.ts` ("F3
> purge-block"). A dedicated `archived_at` column was judged unnecessary: the trash
> "kept" state already realises "archive, never hard-delete".

> **Invoices/customers are NOT a precedent for Policy B.** They are a precedent for
> Policy A (snapshot) only. When a customer is purged, `purgeCustomer`
> (`lib/data/customers.ts`) **nulls `invoices.customer_id` and keeps the frozen
> snapshot** — it does the *opposite* of blocking the purge. Purge-block (archive
> instead of delete) is a new behaviour that arrives with `archived_at` in Sprint
> 7/8. Do not cite invoices as its precedent.

---

## C. Retention / reversal — ALREADY TRUE (no F3 code)

These invariants already hold and already have tests; F3 only cross-references them
and adds **no** new code or tests for them:

- **Price history is retained** until the ingredient is fully purged —
  `ingredient_price_history` cascades with the ingredient (Sprint F2 cascade FK).
  Covered by `tests/ingredient-pricing.test.ts`.
- **Inventory is corrected by reversal, never edited/deleted** — an
  `inventory_movements` correction is an opposite-sign insert; the ledger is
  append-only at the RLS layer (Sprint F1). Covered by
  `tests/inventory-idempotency.test.ts`.

---

## Existing purge patterns in `lib/data/trash.ts` (documented, not extracted)

The current purge sequences already encode two reusable patterns. F3 **documents**
them here so document sprints can follow them inline; a **generic
`nullLinkThenPurge` / registry extraction is deferred to Sprint F6** (the current
sequences have different orderings, and a generic Drizzle abstraction risks
`any`/casts — not worth it until there are more call sites).

1. **Null-the-link-then-delete for `ON DELETE restrict` composite FKs.** A
   referenced master can't be deleted while a `restrict` FK points at it (and a
   multi-column `SET NULL` would also null the `NOT NULL organization_id`), so the
   purge path first sets the referencing `*_id` column to `NULL`, then deletes the
   row — both in the caller's `withOrg` transaction.
   - `purgeCustomer` (`lib/data/customers.ts`): nulls `invoices.customer_id`, then
     deletes the customer. The invoice keeps its snapshot (Policy A).
   - The recipe-purge path nulls `transactions.recipe_id` before deleting a recipe
     (Sprint 2), same reason.
   - `deleteFolder` (`lib/data/recipe-folders.ts`): nulls `recipes.folder_id` on all
     referencing recipes, then drops the folder.

2. **`NOT EXISTS` skip for the ingredient ↔ recipe-line pin.** `purgeExpired`
   purges recipes first, then purges only those trashed ingredients that **no
   active recipe line still references** (a `NOT EXISTS` guard), so a trashed
   ingredient still pinned by an active recipe is left in place rather than
   violating the restrict FK. This upholds the invariant "an active recipe never
   references a purged ingredient".

Document sprints follow these patterns directly until F6 factors them out.

---

## What's deferred (so this doc stays the single contract)

- `archived_at` + the Policy B purge-block implementation + its proof → **Sprint
  7/8**.
- `supplierSnapshot` + the `suppliers`/purchase-order tables → **Sprint 7/8**.
- The actual PO / sale / production snapshot columns + their PDFs → their sprints
  (8a/8b/11/12), each consuming `lib/documents/snapshots.ts`.
- Generic purge/GDPR/seed **registry** + `nullLinkThenPurge` extraction → **Sprint
  F6**.
