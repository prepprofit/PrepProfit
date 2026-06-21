# Sprint F5 — Fiscal model + Sales→Transactions contract — implementation plan

> **Status:** **AUTHORIZED for LOCAL implementation (dev review 2026-06-21).** The §5
> decisions are resolved and the dev's mandatory corrections are folded in (§1, §3,
> §4, §5, §6, §10). F1–F4 are done & on `main` (prod migrated to 0021). Source spec:
> `docs/expansion-plan-kitchen-ops.md` §4 F5 + owner decisions #3 (single exclusive
> VAT, per-item override, integer bps, line-level round-half-up) and #4 (sales =
> daily close). Build in one slice, full diff review at the end.
>
> **Migration `0022` is applied LOCALLY only — PROHIBITED in production until the
> diff is reviewed** (as F1/F2). F6 stays unauthorized. Authorization is conditional
> on every mandatory correction in §10 + the tests in §6 being delivered.

---

## 0. What F5 is — a FOUNDATION slice (Sales itself is Sprint 12a)

Sales (`sales`/`sale_items`, the post/void lifecycle, the UI) is **Sprint 12a** —
those tables don't exist yet. So, exactly like F3 (snapshot policy), F5 cannot build
sales end-to-end. It ships the **fiscal primitives + the sale↔transaction
contract + the protected-transaction enforcement** that 12a consumes, plus the two
schema homes, so 12a wires real sale ids into a ready, tested mechanism.

F5 delivers, all testable now with synthetic ids:
1. The **fiscal config columns** (`organization_settings`) + the **provenance
   columns** on `transactions` (one migration, `0022`).
2. A **pure tax module** (`lib/calculations/tax.ts`) — exclusive, integer basis
   points, line-level round-half-up.
3. Two **sale↔transaction primitives** (`postSaleTransaction`, `voidSaleTransaction`)
   + a **protected-transaction guard** so the generic financial mutators and the
   trash/auto-purge can never touch a sale-sourced row.
4. The **contract doc** (`docs/sales-transaction-contract.md`) — the 6-point void
   retention contract + financial-only mode — that Sprint 12a implements against.

**No `sales` table. No sales UI. No void lifecycle UI.** Those are 12a.

---

## 1. The model F5 codifies

### A. Tax — single org rate, exclusive, per-item override, line-level round-half-up
- `organization_settings.default_tax_rate_bps integer` (nullable; e.g. `2300` = 23%).
  Sale lines (12a) default from it and may override per item.
- **Range: 0..10000 bps (0%..100%).** ⚠️ correction — the earlier draft said
  `100_000`, which would allow a 1000% rate. The Zod validator AND the tax module
  guard cap at **10000**.
- The settings UI shows/edits a **percentage** (0..100); the server converts to bps
  on save (`Math.round(percent * 100)`) and back for display. NULL = "not configured"
  (§5.4) — no silent 0% default.
- **Exclusive** pricing: a line stores `net_cents`, `tax_cents`, `gross_cents`
  separately; sale total = Σ line grosses (no re-round of the sum).
- Pure `lib/calculations/tax.ts`:
  - `lineTax(netCents, bps)` = `Math.round(netCents * bps / 10000)` (half-up; valid
    because sale amounts are non-negative — same rounding the invoice calc uses at
    `lib/calculations/invoice.ts:46`, just /10000 for bps instead of /100 for percent).
  - `saleLineTotals({ netCents, bps })` → `{ netCents, taxCents, grossCents }`.
  - `saleTotals(lines)` → Σ of the per-line rounded figures (mirrors `invoiceTotals`).
  - `percentToBps(percent)` / `bpsToPercent(bps)` for the settings round-trip.
- **Invoices are untouched** — they keep their decimal-percent model
  (`taxRate` numeric). F5 adds a *parallel* bps model for sales; it does not unify
  the two.

### B. Sales → Transactions (single revenue source)
- `transactions` gains `source_type text` (nullable) + `source_id text` (nullable),
  plus a **partial unique** `(organization_id, source_type, source_id) WHERE
  source_type IS NOT NULL` (a sale posts at most once — dedup) and a **CHECK
  constraint** that `source_type` and `source_id` are **both NULL or both set**
  (`(source_type IS NULL) = (source_id IS NULL)`) — no half-populated provenance.
  ⚠️ The redundant plain index on `(org, source_type, source_id)` is **dropped** —
  the partial unique already serves those lookups; re-add only if a concrete query
  needs it (§10.10).
- **`postSaleTransaction(db, org, { saleId, grossCents, occurredOn })`** (F5
  primitive). It FIXES the invariants — the caller can never bend them:
  - `type='income'`, `amount_cents = grossCents`, `recipe_id = NULL`,
    `source_type='sale'`, `source_id=saleId`;
  - **category = a stable SYSTEM category** resolved by slug `daily_sales` (NOT a
    caller-supplied `categoryId`). F5 adds `daily_sales` (income) to the seed
    (`lib/finance/categories.ts` `CATEGORY_SEED`) and the primitive resolves/seeds it
    per org (§10.4);
  - **Idempotent WITH conflict detection (mirrors F1, NOT a silent ignore):**
    `INSERT … ON CONFLICT (org, source_type, source_id) DO NOTHING RETURNING`; if no
    row, **re-fetch the existing sale row and compare the full payload**
    (`amount_cents`, `occurred_on`) — identical → `{ ok:true, deduped:true }`;
    **different → `{ ok:false, reason:'idempotency_conflict' }`** (reuse the F1
    `IDEMPOTENCY_CONFLICT` code; never overwrite). §10.2.
- **Protected:** a sale-sourced transaction (`source_type='sale'`) is owned solely by
  the sale lifecycle. F5 enforces, server-side:
  - the generic `updateTransaction` / `softDeleteTransaction` / `restoreTransaction`
    / `purgeTransaction` (and their actions) **refuse** a sale-sourced row with a new
    stable `PROTECTED_TRANSACTION` code (§5.3), distinguishing it **atomically** from
    NOT_FOUND: the action loads the row in the same `withOrg`, returns `NOT_FOUND` if
    absent, `PROTECTED_TRANSACTION` if `source_type='sale'`, else mutates. The
    data-layer mutators ALSO carry a hard backstop predicate
    **`source_type IS DISTINCT FROM 'sale'`** (NOT `<> 'sale'`, which would also drop
    the NULL-source normal rows — §10.6) so a sale row can never be touched even by a
    forged/concurrent path;
  - `listTrashedTransactions` **excludes** sale-sourced rows (a voided sale is not
    user-trash);
  - `purgeExpired` (auto-purge cron, `lib/data/trash.ts:98`) **skips** sale-sourced
    rows (`source_type IS DISTINCT FROM 'sale'`) — a permanent historical projection,
    never garbage-collected.
- **`voidSaleTransaction(db, org, saleId)`** (F5 primitive): soft-deletes the linked
  sale-sourced income row, **idempotently** (a second call is a no-op — guard on
  `deleted_at IS NULL`). This is the ONE path allowed to soft-delete a sale row; 12a
  calls it inside the sale-void `withOrg` alongside the sale status flip + F1 stock
  reversals + audit. (The divergence — void = soft-delete the income row, NOT an
  expense-typed reversal — is APPROVED, spec §4 F5 / review #5.)

### C. Financial-only mode
- `organization_settings.stock_control_start_date date` (nullable). Sales/productions
  dated **before** it post revenue/cost but **do not move stock** (so importing
  history can't wreck on-hand). F5 ships the column + a tiny pure helper
  `movesStock(eventDate, startDate)` (`lib/finance/stock-control.ts`); 12a/12b
  consume it at **posting time**.
- ⚠️ **Decided rule (document it):** the date is evaluated **only when an event is
  posted**. Changing `stock_control_start_date` later does **NOT** retroactively
  recalculate or reverse already-posted movements — past stock stays as recorded.
  The contract doc + the column comment must state this (§10.7).

---

## 2. The void retention contract (documented in F5, implemented in 12a)
`docs/sales-transaction-contract.md` records the 6 points 12a must honour (spec §4
F5). F5 enforces points 3/4/6 at the transaction layer already; 1/2/5 need the sale
table (12a):
1. `posted → void` is atomic + idempotent, in a single `withOrg`. *(12a)*
2. Sale status flip + transaction soft-delete + F1 stock reversals + audit commit in
   that same `withOrg` (throw-to-rollback). *(12a)*
3. Sale-sourced transactions are **excluded from Trash** and **not
   restorable/editable manually**. ✅ **enforced in F5.**
4. Auto-purge cron **skips** sale-sourced transactions. ✅ **enforced in F5.**
5. The voided sale row is retained indefinitely. *(12a — needs `sales`.)*
6. A second void is a no-op / `INVALID_STATUS_TRANSITION`, never a second stock
   reversal. ✅ `voidSaleTransaction` is idempotent in F5; the status guard is 12a.
- **Bank-import double-count** is an explicit accepted v1 limitation (warn in the
  Sales UI later); documented here, not solved.

---

## 3. Files

### CREATE
- `lib/calculations/tax.ts` + `lib/calculations/tax.test.ts` — pure tax (bps,
  line-level round-half-up) + `movesStock`.
- `docs/sales-transaction-contract.md` — the contract above.
- The migration `drizzle/0022_*.sql` (see §4) — additive, hand-verified `when`.
- `tests/sales-transaction-contract.test.ts` (PGlite) — protected guard + dedup +
  trash/cron exclusion + void idempotency, driven with synthetic `source_type='sale'`
  rows (no `sales` table needed).

### CHANGE
- `lib/db/schema.ts` — `organizationSettings` (+`defaultTaxRateBps`,
  `+stockControlStartDate`); `transactions` (+`sourceType`, `+sourceId`, the partial
  unique + the both-null-or-both-set CHECK; **no** plain traceability index, §10.10).
- `lib/finance/categories.ts` — add a stable **system income category** `daily_sales`
  to `CATEGORY_SEED` (the slug `postSaleTransaction` resolves; §10.4).
- `lib/data/transactions.ts` — `postSaleTransaction` (fixed invariants + conflict
  detection) + `voidSaleTransaction` primitives; the four generic mutators
  (`updateTransaction` / `softDeleteTransaction` / `restoreTransaction` /
  `purgeTransaction`) carry the `source_type IS DISTINCT FROM 'sale'` backstop;
  `listTrashedTransactions` excludes sale-sourced.
- `lib/data/trash.ts` — `purgeExpired` skips `source_type IS DISTINCT FROM 'sale'`.
- `lib/action-result.ts` — new `PROTECTED_TRANSACTION` code (§5.3). `IDEMPOTENCY_CONFLICT`
  already exists (F1) — reused by `postSaleTransaction`.
- `lib/i18n/messages/en.json` — the new `actionErrors.PROTECTED_TRANSACTION` key AND
  the new **settings field labels/help** (tax-rate %, stock-control date) — §10.9.
- `lib/validation/org-settings.ts` — validate the tax rate as a **percentage 0..100**
  (server converts to bps, capped 0..10000) + `stockControlStartDate` (a real
  calendar date or null).
- `lib/data/org-settings.ts` + `app/(app)/settings/*` — surface the two fiscal fields
  (percentage input) in the manager-only settings form (§5.1); the update action
  **audits** the change (`settings.update` or a dedicated `settings.fiscalUpdate`,
  metadata = new bps + date, no PII) — §10.8.
- `app/(app)/transactions/actions.ts` — `updateTransactionAction` /
  `deleteTransactionAction` load the row and return `PROTECTED_TRANSACTION` for a
  sale-sourced row (atomic not_found-vs-protected, §10.6), and write **no audit
  event** when the operation is refused (§10, tests §6).
- The trash restore/purge actions for transactions — same protected guard, same
  no-audit-on-refusal rule.
- Account-export bundle + **export-format version bump 2 → 3** (§5.5).

### NO new table, NO `businessTables` change, NO RLS change.

---

## 4. Migration `0022` (additive, no backfill)
1. `organization_settings`: `ADD COLUMN default_tax_rate_bps integer` (nullable, §5.4),
   `ADD COLUMN stock_control_start_date date` (nullable).
2. `transactions`: `ADD COLUMN source_type text`, `ADD COLUMN source_id text`
   (both nullable).
3. `CREATE UNIQUE INDEX … ON transactions (organization_id, source_type, source_id)
   WHERE source_type IS NOT NULL` (partial — drizzle `uniqueIndex().where(sql\`…\`)`;
   hand-verify the generated SQL).
4. `ALTER TABLE transactions ADD CONSTRAINT transactions_source_pair_chk CHECK
   ((source_type IS NULL) = (source_id IS NULL))` — both NULL or both set (§10.3).
   (Drizzle `check(...)` in the table builder, or hand-add to the SQL.)
- **No plain `(org, source_type, source_id)` index** — the partial unique already
  serves those lookups (§10.10).
- Existing rows: `source_type`/`source_id` stay NULL → they satisfy the CHECK and are
  normal, unprotected, purgeable financial rows. No backfill, no data risk.
- ⚠️ The bps value is **not** constrained at the DB (Postgres CHECK), it is capped in
  Zod + the tax module at **0..10000**; the column is a plain nullable integer.
- **Verify `_journal.json` `when` > 1782033361704** (current max, 0021) — the
  recurring gotcha; `migrate-guard` also aborts if not. Apply LOCALLY only;
  **prod migration is PROHIBITED until the diff is reviewed.**

---

## 5. Decisions — RESOLVED (dev review 2026-06-21)

1. **Settings UI now → YES.** Ship the columns + Zod now and add the two fiscal
   fields to `/settings` (manager-only). The tax field is shown/edited as a
   **percentage**; the server converts to bps on save (§1.A).
2. **Ship the primitives now → YES.** `postSaleTransaction` + `voidSaleTransaction` +
   the protected guard ship in F5 (opaque `source_id`, no FK to the not-yet-existing
   `sales`).
3. **Error code → `PROTECTED_TRANSACTION`** (new). Posting conflict reuses the
   existing `IDEMPOTENCY_CONFLICT` (F1).
4. **`default_tax_rate_bps` → NULLABLE.** NULL = "not configured"; 12a must require a
   rate before posting sales — no silent 0% default.
5. **Account-export version bump → 2 → 3** (confirmed). New columns added to the
   bundle + a test on the bumped version.
6. **Tax rounding → `Math.round` (half-up).** Valid because sale amounts are
   non-negative; matches `invoice.ts:46`. (A future banker's-rounding ask would be a
   12a accountant sign-off, not F5.)

---

## 6. Tests
- **`lib/calculations/tax.test.ts`** (pure): `lineTax` at rounding boundaries
  (half-up: 1.5→2), each bps (0, 600, 2300, **10000 = 100% max**), `saleTotals` = Σ
  rounded lines (no penny drift), `movesStock` (before/on/after the start date,
  null = always moves), `percentToBps` (**23 → 2300, 100 → 10000**) / `bpsToPercent`.
- **`tests/sales-transaction-contract.test.ts`** (PGlite, synthetic
  `source_type='sale'` rows — no `sales` table):
  - `postSaleTransaction` inserts ONE income row with the FIXED invariants
    (`type='income'`, `amount = gross`, `recipe_id = NULL`, `daily_sales` category);
    a **second call, same payload** → `deduped`, still one row.
  - **same `saleId`, DIFFERENT payload** (amount or date) → `IDEMPOTENCY_CONFLICT`
    and **no overwrite** of the original row (§10.2).
  - **posting concurrency/dedup:** two concurrent posts of the same `saleId` →
    exactly one row (partial unique + conflict path).
  - **invalid `source_type`/`source_id` combinations** (one set, the other NULL) are
    rejected by the CHECK constraint (§10.3).
  - **all four mutators** (`update` / `softDelete` / `restore` / `purge`) — and their
    actions — tested with BOTH a NORMAL row (source NULL → succeeds, regression) AND a
    sale row (→ `PROTECTED_TRANSACTION`, atomically distinct from `NOT_FOUND`).
  - **no audit event** is written by update/delete/restore/purge when the operation is
    refused (assert zero `audit_log` rows for the refused id) — §10.8.
  - `listTrashedTransactions` **excludes** a soft-deleted sale-sourced row.
  - `purgeExpired` **skips** an expired sale-sourced row (kept) while purging a normal
    expired transaction (gone).
  - `voidSaleTransaction` soft-deletes the row and is **idempotent** (second call =
    no-op, no second state change).
- **`lib/validation/org-settings`** test: tax percentage 0..100 → bps 0..10000,
  **empty → NULL**, over-100 / negative rejected; date validation.
- **Account-export** test updated for **version 3** + the new columns (§5.5).

---

## 7. Definition of Done
- `npm run lint && npm run typecheck && npm test && npm run build` green.
- Migration `0022` applied **LOCALLY only**; **prod migration PROHIBITED until the
  diff is reviewed.**
- Every mandatory correction in §10 delivered; tests in §6 green.
- Pure tax module tested (0..10000 cap, half-up, percent↔bps); sale↔transaction
  primitives (fixed invariants + conflict detection) + protected guard
  (`PROTECTED_TRANSACTION`, atomic vs NOT_FOUND, no audit on refusal) + trash/cron
  exclusion + void idempotency proven (synthetic sale ids).
- Settings fiscal fields shipped (percentage UI → bps), audited, with i18n labels.
- Contract doc committed (`docs/sales-transaction-contract.md`).
- Account-export includes the new columns + **version bumped 2 → 3**.
- **Full diff handed to the dev before F6 is authorized.** F6 stays unauthorized.

---

## 8. Out of scope for F5 (do NOT build)
- The `sales` / `sale_items` tables, the post/void **lifecycle**, and the Sales UI →
  **Sprint 12a** (consumes F5's primitives + tax module + columns).
- Sales import + financial-only enforcement on import → **Sprint 12b**.
- Unifying invoices onto the bps model — invoices stay decimal-percent.
- Multi-rate / multi-jurisdiction VAT — explicitly out per owner decision #3.
- Bank-import reconciliation (the double-count) — documented as a v1 limitation.
- Accountant sign-off on rounding/jurisdiction — gates **12a**, not F5 (§7 of the
  expansion plan).

---

## 9. Codebase anchors (verified this review)
- `lib/db/schema.ts:59` `organizationSettings`; `:451` `transactions` (positive
  magnitude + `type`, the model a sale income row matches).
- `lib/data/transactions.ts` — the generic mutators to guard (`updateTransaction:154`,
  `softDeleteTransaction:176`, `restoreTransaction:196`, `purgeTransaction:216`,
  `listTrashedTransactions:232`).
- `lib/data/trash.ts:98` — `purgeExpired` transactions delete (add the sale skip).
- `app/(app)/transactions/actions.ts` — manager-gated actions (where the protected
  code surfaces).
- `lib/calculations/invoice.ts:46` — the round-half-up precedent to mirror for bps.
- `drizzle/meta/_journal.json` — current max `when` 1782033361704 (0021); 0022 must
  exceed it.
- F3 precedent for a "contract + primitive, consumer deferred" slice:
  `docs/document-snapshot-policy.md` + `docs/sprint-f3-plan.md`.
- F1 precedent for the post-conflict idempotency revalidation +
  `IDEMPOTENCY_CONFLICT`: `lib/data/inventory.ts` `recordMovement` +
  `tests/inventory-idempotency.test.ts`.

---

## 10. Mandatory corrections (dev review 2026-06-21 — all REQUIRED)

Authorization is conditional on every item below. They are folded into the sections
above; this is the checklist.

1. **bps cap = 10000, not 100000.** `100_000` allows a 1000% rate. Zod (percentage
   0..100 → bps 0..10000) + the tax module both cap at 10000. (§1.A, §4, §6)
2. **Posting idempotency must DETECT conflicts, not silently ignore.** Same `saleId`
   with a different amount/date → `IDEMPOTENCY_CONFLICT` (reuse F1's code), never an
   overwrite. `postSaleTransaction` does `ON CONFLICT DO NOTHING RETURNING` → on no
   row, re-fetch + compare payload → identical = `deduped`, different = conflict.
   (§1.B, §6)
3. **CHECK constraint: `source_type` and `source_id` both NULL or both set**
   (`(source_type IS NULL) = (source_id IS NULL)`). No half-populated provenance.
   (§1.B, §4, §6)
4. **The aggregated sale transaction uses a STABLE SYSTEM category** — slug
   `daily_sales` seeded in `CATEGORY_SEED`, resolved by `postSaleTransaction`. Never a
   caller-supplied arbitrary `categoryId`. (§1.B, §3)
5. **`postSaleTransaction` fixes the invariants** server-side: `type='income'`,
   `amount_cents = gross`, `recipe_id = NULL`, `source_type='sale'`, `source_id=saleId`.
   The caller cannot bend them. (§1.B)
6. **Mutators distinguish NOT_FOUND from PROTECTED atomically**, and the SQL backstop
   uses **`source_type IS DISTINCT FROM 'sale'`** — `source_type <> 'sale'` alone also
   excludes NULL-source (normal) rows, which would break legitimate edits. (§1.B, §3)
7. **`stock_control_start_date` is evaluated at posting time only.** Changing it later
   does NOT recalc/reverse past movements. State it in the column comment + the
   contract doc. (§1.C)
8. **Audit the settings change** (new tax bps + start date; no PII), and write **no
   audit event** when a mutator is refused on a protected row. (§3, §6)
9. **i18n: the new settings field labels/help** ship in `en.json`, not only the error
   message. (§3)
10. **Drop the redundant plain `(org, source_type, source_id)` index** — the partial
    unique already serves those lookups. Re-add only with a concrete justifying query.
    (§1.B, §4)
