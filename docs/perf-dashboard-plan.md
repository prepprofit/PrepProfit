# Performance Plan - Dashboard and Layout Query Consolidation

**Status:** SENIOR-REVISED - approved for implementation after the revisions below.  
**Date:** 2026-07-07  
**Scope:** Findings 1, 2, and 4 of the 2026-07-07 performance audit. No migration, no schema change, no new dependency, no cache-policy change, and no visible user-facing behavior change.

## Senior Verdict

The original direction is correct, but the draft was not implementation-ready as written. It missed one real dashboard transaction (`getOrgSettings()`), left the layout consolidation shape open, and allowed ambiguity around finance money semantics.

This revised plan is the contract the dev should implement. Do not start coding from the old draft.

## Current-Code Facts Verified

- `app/(app)/dashboard/page.tsx` is manager-only after the role guard, then reads org settings, operational dashboard data, transaction rows, and invoice rows.
- `getOrgSettings()` opens its own `withOrg` transaction via `lib/data/org-settings.ts`; it is part of the dashboard cost and must be counted.
- The dashboard currently fetches full-year transaction rows for `monthlyBuckets()`, prior-period transaction rows for `comparePeriods()`, current-period transaction rows for `financeSummary()`, recent transaction rows, and all active invoices for `invoiceSummary()`.
- `listTransactions()` in `lib/data/transactions.ts` is org-scoped, soft-delete-aware, date-filtered, and joins categories plus optional recipe names. It is still the right API for current-period category/top-product breakdowns and recent rows.
- `listInvoices()` in `lib/data/invoices.ts` is org-scoped and soft-delete-aware, but intentionally unbounded. It is wrong for the dashboard summary once invoice history grows.
- Existing schema already has `transactions_org_date_idx`, `transactions_org_deleted_idx`, `invoices_org_status_idx`, and `invoices_org_deleted_idx`. This plan must not add indexes or migrations.
- `amountCents` is a positive integer-cent magnitude. Direction comes from transaction `type`; negative transaction amounts are not a supported domain behavior.
- `app/(app)/layout.tsx` already runs trial, AI meter, entitlement, and activation reads in parallel for managers, but then does a separate serial `withOrg` for `countNeedsPricing()`.
- `getActivationSnapshot()` wraps `readActivationSnapshot(tx, organizationId)` in its own `withOrg`; the reusable transacted helper already exists.
- The test harness is Vitest with `environment: 'node'` and PGlite-style data-layer tests. Do not require browser/component tests to prove SQL aggregate correctness.

## Non-Goals

- No pagination/search work for list pages.
- No changes to RLS architecture, `withOrg`, pool sizing, Clerk entitlement semantics, or dashboard authorization.
- No dashboard UI redesign and no copy changes.
- No server caching, revalidation windows, or stale badge behavior.
- No deletion of `listTransactions()`, `listInvoices()`, `monthlyBuckets()`, `financeSummary()`, or `invoiceSummary()`; other pages still use row-based APIs.

## Locked Decisions

### D1 - Keep Current-Period Breakdown Row-Based

The dashboard still fetches current-month transaction rows because `financeSummary()` powers `byCategory` and `topProducts`, and those sections need category and recipe labels. This fetch is bounded to one month and remains acceptable for this slice.

Do not replace the current-period breakdown with multiple category/product SQL aggregates in this plan.

### D2 - Move Full-Year, Prior-Period, and Invoice Totals to SQL

Only the data that currently ships unbounded or unnecessarily large row sets moves to SQL aggregates:

- Full-year monthly chart totals.
- Prior-period income, expense, and profit totals.
- Lifetime invoice status/accounts-receivable summary.

### D3 - Dashboard Must Count `getOrgSettings()`

The optimized dashboard target is two org-scoped data transactions for the normal manager dashboard path:

- Transaction A: org settings plus operational data.
- Transaction B: financial aggregates and bounded finance rows.

`getOrgSettings()` should not remain as a third separate dashboard transaction. Use `getOrgSettingsRow(tx, organizationId) ?? DEFAULT_ORG_SETTINGS` inside Transaction A.

### D4 - Layout Uses One Combined Manager DB Snapshot

For manager layout data that is DB-backed, add a layout-local cached helper that opens one `withOrg` and returns:

- `activation: await readActivationSnapshot(tx, organizationId)`
- `needsPricingCount: await countNeedsPricing(tx, organizationId)`

Keep entitlement/trial reads outside that transaction because they are Clerk/session-derived, not DB-backed. Kitchen-role behavior remains unchanged: no activation read, no AI meter read, no badge read.

### D5 - Money Conversion Must Be Explicit and Guarded

Postgres `SUM(integer)` returns a bigint-like value. Aggregate functions must convert at the data edge with a small private helper, for example `toSafeCents(value, label)`, that:

- Accepts the driver-returned bigint/string/number shape.
- Converts with `Number(value)`.
- Throws if the result is not a safe integer.
- Documents that app money stays integer cents.

Do not silently coerce unsafe sums.

## Slice 1 - Add Dashboard Aggregate Reads

### `lib/data/transactions.ts`

Add:

```ts
export type TransactionTypeTotals = {
  incomeCents: number;
  expenseCents: number;
  profitCents: number;
};

export type TransactionMonthlyTotals = {
  month: number;
  incomeCents: number;
  expenseCents: number;
  profitCents: number;
};
```

Add `sumTransactionsByType(db, organizationId, { from, to })`.

Contract:

- Filters by `organizationId`.
- Filters `deleted_at IS NULL`.
- Applies inclusive `occurred_on >= from` and `occurred_on <= to`.
- Computes income and expense with SQL `SUM(...) FILTER (WHERE type = ...)`.
- Returns zeros for no rows.
- Computes `profitCents = incomeCents - expenseCents` in TypeScript after safe conversion.
- Does not join categories or recipes.

Add `sumTransactionsByMonth(db, organizationId, year)`.

Contract:

- Filters by `organizationId`.
- Filters `deleted_at IS NULL`.
- Uses `occurred_on >= YYYY-01-01` and `occurred_on <= YYYY-12-31`; do not use timezone math.
- Groups by `extract(month from occurred_on)::int`.
- Uses filtered sums for income and expense.
- Returns exactly 12 rows or maps to exactly 12 buckets with zero-filled months, matching the current `monthlyBuckets()` shape.
- Computes `profitCents` per month after safe conversion.

Implementation note:

- Prefer `sql<string>` or `sql<unknown>` for sums and run them through `toSafeCents`.
- Use `sql<number>\`extract(month from ... )::int\`` for month keys.
- Keep the function names dashboard-specific enough that future list pages do not start using aggregates where row detail is required.

### `lib/data/invoices.ts`

Add `summarizeInvoicesForDashboard(db, organizationId, today)`.

Return the existing `InvoiceSummary` shape from `lib/calculations/invoice.ts`:

```ts
{
  outstandingCents: number;
  overdueCents: number;
  draftCount: number;
  issuedCount: number;
  paidCount: number;
}
```

Contract:

- Filters by `organizationId`.
- Filters `deleted_at IS NULL`.
- Counts draft, issued, and paid invoices.
- Ignores void invoices for money and dashboard counts, matching `invoiceSummary()`.
- `outstandingCents` sums only `status = 'issued'`.
- `overdueCents` sums only `status = 'issued' AND due_date IS NOT NULL AND due_date < today`.
- `today` remains an app-supplied bare `YYYY-MM-DD` string, same convention as the current pure `invoiceSummary(invoices, todayKey())`.
- Uses the same safe cents conversion as transaction aggregates.

Do not modify invoice lifecycle functions in this slice.

## Slice 2 - Rewrite Dashboard Data Loading

Target shape in `app/(app)/dashboard/page.tsx`:

1. Resolve non-DB request data without extra serial waits where safe:
   - `getTranslations(...)` calls can be loaded with `Promise.all`.
   - `getLocale()`, `searchParams`, and `getFirstName()` can also be grouped where readability stays acceptable.
   - Keep the role guard before manager-only dashboard data.

2. Replace `getOrgSettings()` with `getOrgSettingsRow()` inside the first dashboard transaction.

3. Run the two dashboard data transactions in parallel for the normal manager dashboard path:

```ts
const [operational, finance] = await Promise.all([
  withOrg(organizationId, async (tx) => {
    const settings = (await getOrgSettingsRow(tx, organizationId)) ?? DEFAULT_ORG_SETTINGS;

    if (settings.onboardedAt == null) {
      return { needsOnboarding: true as const, settings };
    }

    return {
      needsOnboarding: false as const,
      settings,
      recipes: await listRecipesWithLines(tx, organizationId),
      ingredients: await listIngredients(tx, organizationId),
      profitLeaks: await loadProfitLeaks(tx, organizationId),
    };
  }),
  withOrg(organizationId, async (tx) => {
    const yearKey = String(resolved.year);
    const year = resolvePeriod('year', yearKey);

    const monthly = await sumTransactionsByMonth(tx, organizationId, resolved.year);
    const prior = await sumTransactionsByType(tx, organizationId, {
      from: resolved.priorFrom,
      to: resolved.priorTo,
    });
    const period = await listTransactions(tx, organizationId, {
      from: resolved.from,
      to: resolved.to,
    });
    const recent = await listTransactions(tx, organizationId, { limit: 8 });
    const invoices = await summarizeInvoicesForDashboard(tx, organizationId, todayKey());

    return { monthly, prior, period, recent, invoices };
  }),
]);

if (operational.needsOnboarding) redirect('/onboarding');
```

Notes:

- The `year` variable above is only needed if the implementation keeps a helper that expects `year.from`/`year.to`; otherwise remove it.
- Do not call `redirect()` inside the `withOrg` callback. Return a sentinel and redirect after the transaction completes.
- It is acceptable that the finance transaction may run in parallel on the rare not-yet-onboarded manager request; the visible behavior remains the same and the common dashboard path gets the latency win.
- Do not use `Promise.all` inside one `withOrg` as a performance argument. Queries on a single transaction/connection are still serialized by the driver/protocol.

Build the existing `finance` object shape from the new data:

- `periodSummary = financeSummary(financeRows.period)`
- `priorTotals = financeRows.prior`
- `revenueComparison = comparePeriods(periodSummary.incomeCents, priorTotals.incomeCents)`
- `profitComparison = comparePeriods(periodSummary.profitCents, priorTotals.profitCents)`
- `expenseComparison = comparePeriods(periodSummary.expenseCents, priorTotals.expenseCents)`
- `invoices = financeRows.invoices`
- `monthly = financeRows.monthly.map(...)`
- `recentTxns = financeRows.recent`

Rendered output must stay identical:

- KPI values.
- AR/invoice summary values.
- Category breakdown.
- Top products.
- Monthly chart labels and values.
- Recent transactions.
- January period comparison where prior period is December of the previous year.

## Slice 3 - Consolidate Layout DB Reads

In `app/(app)/layout.tsx`, add a layout-local cached helper, not a new data-layer React dependency:

```ts
const getManagerLayoutDbSnapshot = cache(async () => {
  const organizationId = await getOrgId();
  return withOrg(organizationId, async (tx) => ({
    activation: await readActivationSnapshot(tx, organizationId),
    needsPricingCount: await countNeedsPricing(tx, organizationId),
  }));
});
```

Then change the manager branch to load:

- `getTrialView()`
- `getSidebarAiMeterView()`
- `getEffectiveEntitlementState()`
- `getManagerLayoutDbSnapshot()`

inside the existing layout `Promise.all`.

Rules:

- Kitchen staff still get `[null, null, null, null]`-style fallbacks and no DB snapshot.
- `flowsUser` values must be identical to today.
- `needsPricingCount` must be identical to today.
- Do not move `getEffectiveEntitlementState()` into a DB transaction.
- Do not add a freshness/cache window for the badge in this plan.

## Tests Required

Add focused PGlite data-layer tests. A good file name is `tests/dashboard-aggregates.test.ts`.

### Transaction Aggregate Tests

Seed two orgs, transaction categories, active rows, and soft-deleted rows.

Required cases:

- `sumTransactionsByMonth()` returns 12 months with zero-filled gaps.
- Income and expense are separated by `type`.
- Profit equals income minus expense.
- Dec 31 and Jan 1 land in the correct year.
- Soft-deleted rows are excluded.
- Rows from another org do not affect the result.
- Large but valid positive cent values survive the aggregate conversion.
- No-row result returns zeros, not `null` or `NaN`.

Do not add a "negative amount" support test. The domain contract is positive cents.

### Prior-Period Tests

Required cases:

- `sumTransactionsByType()` respects inclusive `from` and `to`.
- January's prior-period range can be in the previous calendar year.
- Soft-deleted and cross-org rows are excluded.
- No-row result returns zero totals and zero profit.

### Invoice Summary Tests

Seed active and soft-deleted invoices directly or through existing invoice helpers, whichever keeps the test clearer.

Required cases:

- Draft, issued, paid, and void statuses produce the same summary as `invoiceSummary()`.
- Outstanding money includes issued invoices only.
- Overdue money includes issued invoices only when `dueDate < today`.
- `dueDate === today` is not overdue.
- `dueDate === null` is not overdue.
- Soft-deleted draft invoices are excluded.
- Cross-org rows are excluded.
- Empty org returns all zeros.

### Layout Test

Update or add a small unit/integration test only if the layout helper is exported/testable without fighting Next internals. Otherwise keep this to code review plus a manual check. The critical correctness for activation and badge counts is already data-layer testable.

## Manual Verification

Before merge, run:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

Manual dashboard checks:

- Seed or use a demo org with at least current-month transactions, prior-month transactions, invoices in draft/issued/paid/void, and a January period case.
- Compare before/after numbers for revenue, profit, expenses, AR, overdue, invoice counts, monthly chart, category breakdown, top products, and recent transactions.
- Confirm a manager with `onboardedAt == null` is still redirected to `/onboarding`.
- Confirm kitchen staff still cannot access `/dashboard` and still see no pricing badge/layout finance surfaces.

Optional performance sanity check:

- In development logging or Neon query logs, verify the dashboard no longer fetches full-year transaction rows or all invoice rows for the dashboard cards.
- Confirm the normal dashboard path has two dashboard data `withOrg` calls after this change, not the current settings + operational + finance + invoices shape.
- Confirm the manager layout has one DB-backed layout snapshot for activation + needs-pricing badge.

## Definition of Done

- No migration generated; `npm run db:generate` should produce no intended schema diff.
- The dashboard no longer calls `listInvoices()` and no longer calls `listTransactions()` for full-year or prior-period row sets.
- `listTransactions()` remains used for current-period breakdowns, recent transactions, list pages, and exports.
- `listInvoices()` remains used by invoice list/detail flows.
- All new aggregate functions are org-scoped and soft-delete-aware.
- Bigint/sum conversion is explicit and safe.
- Tests cover zero rows, year boundaries, January prior period, overdue edge, soft deletes, cross-org isolation, and large valid cents.
- User-visible dashboard and layout output is unchanged.

## Expected Impact

- Removes the dashboard's unbounded full-year transaction row transfer and full-history invoice row transfer.
- Reduces dashboard org-scoped data loading to two main transactions on the normal manager path.
- Removes one serial manager-layout transaction by combining activation and needs-pricing badge reads.
- Keeps the scale cost tied to current-month transaction rows plus small SQL aggregates instead of year rows plus lifetime invoices.
