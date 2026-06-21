# Sales → Transactions contract (Sprint F5)

This is the contract Sprint 12a (Sales) implements against. F5 ships the fiscal
primitives, the sale↔transaction primitives, and the protected-transaction
enforcement; it does **not** build the `sales`/`sale_items` tables, the post/void
lifecycle, or any sales UI — those are **Sprint 12a**.

## Single revenue source

A posted sale projects into the financial ledger as **exactly one** `transactions`
row, created by `postSaleTransaction` (`lib/data/transactions.ts`). The primitive
**fixes the invariants** — the caller cannot bend them:

- `type = 'income'`
- `amount_cents = grossCents` (the gross daily-close total; F5 sales are exclusive,
  so gross = Σ line nets + Σ line taxes — see `lib/calculations/tax.ts`)
- `recipe_id = NULL`
- `source_type = 'sale'`, `source_id = <saleId>`
- `category` = the stable **system** category resolved by slug `daily_sales`
  (seeded per org in `CATEGORY_SEED`), never a caller-supplied id.

**Dedup with conflict detection** (mirrors the F1 inventory ledger, never a silent
overwrite): the insert is `ON CONFLICT (organization_id, source_type, source_id)
DO NOTHING RETURNING` against the partial unique index
`transactions_org_source_key`. If no row comes back, the existing sale row is
re-fetched and its payload compared:

- identical `amount_cents` + `occurred_on` → `{ ok: true, deduped: true }`;
- different → `{ ok: false, reason: 'idempotency_conflict' }` (the original is
  **never** overwritten; the action surfaces `IDEMPOTENCY_CONFLICT`).

A DB **CHECK** (`transactions_source_pair_chk`) enforces that `source_type` and
`source_id` are both NULL or both set — no half-populated provenance.

## Protected transactions

A sale-sourced row (`source_type = 'sale'`) is owned **solely** by the sale
lifecycle. F5 enforces this server-side:

- the generic `updateTransaction` / `softDeleteTransaction` / `restoreTransaction`
  / `purgeTransaction` mutators carry a hard SQL backstop
  `source_type IS DISTINCT FROM 'sale'` (deliberately **not** `<> 'sale'`, which
  would also drop the NULL-source normal rows), so a forged/concurrent path can
  never touch one;
- their **actions** (`app/(app)/transactions/actions.ts`, the trash restore/purge
  actions) load the row in the same `withOrg` and return the stable
  `PROTECTED_TRANSACTION` code — distinguished **atomically** from `NOT_FOUND`
  (no row) — and write **no audit event** when the mutation is refused;
- `listTrashedTransactions` **excludes** sale-sourced rows (a voided sale is not
  user-trash);
- `purgeExpired` (auto-purge cron, `lib/data/trash.ts`) **skips** sale-sourced
  rows — a voided sale's income row is a permanent historical projection, never
  garbage-collected.

## The 6-point void retention contract

F5 enforces points **3, 4, 6** at the transaction layer; points **1, 2, 5** need
the `sales` table and are implemented in **Sprint 12a**.

1. `posted → void` is atomic + idempotent, in a single `withOrg`. *(12a)*
2. The sale status flip + transaction soft-delete + F1 stock reversals + audit all
   commit in that same `withOrg` (throw-to-rollback; `runInOrg` commits on return,
   rolls back only on throw). *(12a)*
3. Sale-sourced transactions are **excluded from Trash** and are **not
   restorable/editable manually**. ✅ **enforced in F5.**
4. Auto-purge cron **skips** sale-sourced transactions. ✅ **enforced in F5.**
5. The voided sale row itself is retained indefinitely. *(12a — needs `sales`.)*
6. A second void is a no-op / `INVALID_STATUS_TRANSITION`, never a second stock
   reversal. ✅ `voidSaleTransaction` is idempotent in F5 (its `deleted_at IS NULL`
   guard makes the second call a no-op); the sale-status guard is **12a**.

`voidSaleTransaction` is the **only** path allowed to soft-delete a sale-sourced
row. Void = soft-delete the income row (not a second, expense-typed reversal row);
this divergence is **approved** (the schema stores only positive magnitudes and
already uses soft-delete) — spec §4 F5 / review #5.

### Accepted v1 limitation

Recording sales revenue here **and** importing the same money from a bank feed
would double-count. This is an **explicit accepted v1 limitation** (the Sales UI
will warn later); reconciliation is deferred.

## Financial-only mode

`organization_settings.stock_control_start_date` (nullable). Sales/productions
dated **before** it post revenue/cost but **do not move stock**. `movesStock`
(`lib/finance/stock-control.ts`) is the pure helper; Sprint 12a/12b call it **at
posting time**.

⚠️ The date is evaluated **only when an event is posted**. Changing
`stock_control_start_date` later does **not** retroactively recalculate or reverse
already-posted movements — past stock stays exactly as recorded.

## Tax model

`organization_settings.default_tax_rate_bps` (nullable integer, 0..10000 bps).
**NULL = not configured** — Sprint 12a must require a rate before posting sales
(no silent 0% default). Exclusive pricing: each sale line stores net / tax / gross
separately; the sale total is the sum of the per-line rounded grosses (no re-round
of the sum). Rounding is `Math.round` (half-up), valid for non-negative amounts.
Invoices keep their own decimal-percent model — F5 does not unify the two.
