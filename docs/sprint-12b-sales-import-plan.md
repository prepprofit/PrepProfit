# Sprint 12b - Sales import (staged daily closes) - implementation plan

> **Status: SENIOR-REVIEWED implementation plan - NOT started.**
>
> This plan was reviewed against the current code snapshot (`PrepProfit-main (23).zip`,
> 2026-06-23). The defaults below are the implementation contract unless the owner
> explicitly overrides them before coding.
>
> Source of truth for scope: `docs/expansion-plan-kitchen-ops.md` section 6.6
> (12b) plus the shipped Sprint 12a sales lifecycle. Sprint 12b reuses the staged
> import foundation (`lib/import/*`, `import_jobs`, preview -> confirm, job lock,
> `import.preview` / `import.commit` audit) and the 12a sales primitives
> (`createSale`, `postSale`, F5 `postSaleTransaction`, F1 `recordMovements`,
> `movesStock`, `lib/calculations/tax.ts`, and the partial unique
> `(organization_id, sale_date) WHERE status <> 'void'`).
>
> **Default plan ships no schema migration.** If the owner chooses the external-ref
> alternative in D2, that is a separate local-only migration (`0033`) and must not
> reach production without explicit SQL/meta diff review.

## 0. Outcome and boundaries

Sprint 12b lets a manager upload a CSV/XLSX of sales lines, preview the normalized
daily closes server-side, and confirm them. Each imported close is created as a draft
sale and immediately posted through the same 12a primitives as a manual sale. The
import must never write income transactions, sale item totals, or inventory movements
directly.

A close dated before the org `stock_control_start_date` posts financial-only through
`postSale` (`stock_moved = false`, no OUT movements). A close on/after that date
consumes stock through the 12a consumption path. Re-uploading the same or overlapping
dates must never double-post an active close.

This is not a per-ticket POS importer, not a bank importer, and not a reconciliation
feature. The accepted v1 limitation still applies: if the same sales revenue is also
imported as a bank/transaction row, the app only warns; it does not reconcile.

Hard invariants:

- **Org isolation:** every read/write is scoped by server-derived `organizationId` and
  runs inside `withOrg`; the client only holds the opaque `import_jobs.id`.
- **Staged import:** parse -> preview -> stored normalized payload -> confirm. The
  browser never sends rows back on confirm.
- **Single revenue source:** imported closes call `createSale` then `postSale`. The
  protected income row comes only from F5 `postSaleTransaction`
  (`type='income'`, `source_type='sale'`, `source_id=<saleId>`, `daily_sales`).
- **Throw to roll back:** `withOrg` commits on normal return and rolls back only on
  throw. After any sale draft is created inside confirm, every later failure must throw
  a typed import error, not return a failure value.
- **Idempotency:** `lockImportJob(...).for('update')` plus `status='committed'` makes
  a second confirm a no-op. The sales table partial unique is the data-level backstop
  for overlapping imports or concurrent manual closes.
- **Tax:** exclusive pricing, integer cents, per-line rounded tax, summed totals via
  `tax.ts`. Current `postSale` requires `organization_settings.default_tax_rate_bps`
  to be configured even when import rows carry explicit rates.
- **Financial auth:** manager-only and `requireFeature('invoices')`, matching current
  12a sales actions. Enforce RBAC -> entitlement -> validation/data.
- **Audit privacy:** no amounts, item names, or raw spreadsheet text in audit metadata.

## 1. Senior review corrections to bake in

These are the points most likely to cause a broken or subtly unsafe implementation:

1. **Audits do not "fire naturally" from data primitives.** In the current code,
   `sale.create` and `sale.post` audit events are written by
   `app/(app)/sales/actions.ts`, not by `createSale` / `postSale`. The sales import
   confirm path must write the per-sale audit events explicitly in the same
   transaction, or extract a shared helper. Do not assume calling the data functions
   writes audit events.
2. **`postSale` requires `expectedUpdatedAt`.** After `createSale` returns
   `{ status: 'ok', sale }`, call `postSale(tx, org, sale.id, sale.updatedAt)`.
3. **The existing generic import actions are not entitlement-gated.** They are
   manager-only because ingredients/transactions/recipes imports are starter-module
   conveniences. The sales branch must add `requireFeature('invoices')` after
   `isManager()` and before any file parsing, job read, template response, or data
   access.
4. **Sales preview is close-oriented, not row-oriented.** The existing `ImportPreview`
   sample grid works for ingredients/transactions but is a poor fit for grouped daily
   closes. Extend the preview type/UI deliberately instead of shoehorning sales closes
   into the flat `sample` grid.
5. **Use exact item resolution only for v1.** Recipes, menus, and ingredients can have
   duplicate display names. A normalized name must link only if exactly one active
   same-kind item matches. Multiple exact matches are `AMBIGUOUS_ITEM`; no exact match
   is `UNKNOWN_ITEM`. Fuzzy suggestions can be displayed as help, but must not auto-link
   and must not create catalogue items.
6. **Use `saleItems` terminology.** The current schema/table is `sale_items` exposed as
   `saleItems`, not `sale_lines`.
7. **Default D2 date dedup is intentional.** For v1 daily closes, the stable imported
   close key is the close date. F5 `source_type/source_id` dedup already protects the
   generated income transaction using the sale id; do not add another transaction-level
   source key for imports.

## 2. Decisions

### 2.A Locked

1. **Reuse the import foundation.** Add `sales` to the TS-only import entity lists and
   job payload union. No DB CHECK exists for `import_jobs.entity`, so this alone should
   not require SQL migration.
2. **Commit through 12a.** Confirm creates a draft sale with normalized lines, then
   posts it immediately. No direct transaction or movement writes.
3. **Financial-only is delegated to 12a.** Do not re-implement `movesStock` in import
   apply logic.
4. **Manager + invoices feature.** Same gate as `/sales`.
5. **No silent catalogue changes.** Sales import never creates recipes, menus, or
   ingredients.

### 2.B Defaults

- **D1 - File granularity: one row per sale item line, grouped by date.**
  Required columns:
  `date,item_kind,item_name,quantity,unit_net_price`.

  Optional columns:
  `tax_rate_percent,ingredient_qty_canonical`.

  `item_kind` is `recipe | menu | ingredient`. `ingredient_qty_canonical` is required
  only for `item_kind='ingredient'` and means canonical stock quantity consumed per
  sold unit, matching `saleItems.ingredientQtyCanonical`. For recipe/menu lines it must
  be blank. `quantity` is integer units sold. `unit_net_price` is exclusive net price
  per sold unit.

- **D2 - Dedup key: close date, no migration.**
  A date that already has a non-void sale is skipped at preview with soft issue
  `DUPLICATE`. The partial unique `sales_org_date_active_key` is the hard backstop.

  Alternative only if the owner needs true POS/export ids independent of date:
  add `sales.external_ref text NULL` plus a partial unique
  `(organization_id, external_ref) WHERE external_ref IS NOT NULL`. That is migration
  `0033`, local-only until reviewed, and account export bumps `13 -> 14`.

- **D3 - Confirm policy: all-or-nothing for importable closes.**
  Preview may classify some closes as skipped duplicates and exclude invalid closes.
  Confirm attempts only importable closes, all in one `withOrg`. If any close fails
  during create/post/audit, throw and roll back the whole confirm; leave the job
  `parsed` so the manager can fix and retry.

- **D4 - Stock shortfall.**
  Let `postSale` / `recordMovements` throw `MovementError`. Map
  `insufficient_stock -> INSUFFICIENT_STOCK`, `idempotency_conflict ->
  IDEMPOTENCY_CONFLICT`, `not_found -> SALE_INCOMPLETE`. Do not clamp, skip, or
  partially post.

- **D5 - Item resolution.**
  Resolve against active same-org items only (`deleted_at IS NULL`):
  exact normalized single match -> link; no match -> `UNKNOWN_ITEM`; multiple exact
  matches -> `AMBIGUOUS_ITEM`. Optional fuzzy suggestions are display-only.

- **D6 - Tax source.**
  Preview should fetch org settings. If `default_tax_rate_bps` is null, return
  `SALES_TAX_RATE_REQUIRED` before staging a sales job, because current `postSale`
  requires it unconditionally. If configured, blank row `tax_rate_percent` defaults to
  that value; explicit values are validated as `0..100%` and converted to bps.

- **D7 - Audit.**
  In confirm, write:
  `sale.create` per created draft (`metadata: { lineCount }`);
  `sale.post` per successfully posted close (`lineCount`, `ingredientCount`,
  `stockMoved`, `movementCount`, `transactionId`);
  one `import.commit` for the job (`entity: 'sales'`, counts only).

  If any later close fails, all of those audit writes roll back with the transaction.
  A re-confirm of an already committed job is a no-op and must not double-audit.

- **D8 - UI placement.**
  Extend the existing `/import` workbench/entity select with `sales`. Do not create a
  standalone `/sales/import` route for v1 unless the owner explicitly asks for that
  product shape. Add a sales-specific preview panel grouped by date.

## 3. Flow

```text
upload file
  -> parseSalesRows(matrix)                     // pure, structural only
  -> planSalesImport(tx, org, parsed, settings) // org data, no writes
  -> create import_jobs row(status='parsed', normalized_rows=ImportSalesPayload)
  -> manager reviews close-oriented preview
  -> confirmSalesImportAction(jobId)
       -> lockImportJob FOR UPDATE
       -> validate stored payload
       -> for each importable close:
            createSale(...)
            write sale.create audit
            postSale(..., sale.updatedAt)
            write sale.post audit
       -> markImportJobCommitted
       -> write import.commit audit
```

If a job is already `committed`, confirm returns success with `alreadyCommitted=true`
and writes nothing. If the job is expired, mark it expired and return
`IMPORT_EXPIRED`.

## 4. Data contracts and types

### Import types

Update `lib/import/types.ts`:

- Add `'sales'` to `IMPORT_ENTITIES` and `FILE_IMPORT_ENTITIES`.
- Add hard issue codes `UNKNOWN_ITEM` and `AMBIGUOUS_ITEM`.
- Add:

```ts
export type ImportSaleItemKind = 'recipe' | 'menu' | 'ingredient';

export type ImportSaleLine = {
  sourceLine: number;
  itemKind: ImportSaleItemKind;
  itemName: string;
  normalizedItemName: string;
  itemRecipeId: string | null;
  itemMenuId: string | null;
  itemIngredientId: string | null;
  quantity: number;
  ingredientQtyCanonical: number | null;
  unitNetCents: number;
  taxRateBps: number;
  netCents: number;
  taxCents: number;
  grossCents: number;
};

export type ImportSaleClose = {
  saleDate: string;
  lines: ImportSaleLine[];
  netCents: number;
  taxCents: number;
  grossCents: number;
  status: 'importable' | 'skipped' | 'invalid';
  issues: ImportRowIssue[];
  stockMode: 'moves_stock' | 'financial_only';
};

export type ImportSalesPayload = {
  closes: ImportSaleClose[];
};
```

Widen `ImportNormalizedRows = ImportRecord[] | ImportRecipePayload |
ImportSalesPayload`.

### Validation

Update `lib/validation/import.ts`:

- Add `SALES_COLUMNS` and `SALES_REQUIRED_COLUMNS`.
- Add `importSalesPayloadSchema` for confirm-time defense.
- Reuse 12a caps: max 200 lines per close, `quantity 1..100000`,
  `unitNetCents 0..1_000_000_000`, `taxRateBps 0..10000`, and the int4 sale-total
  overflow guard from `lib/validation/sales.ts`.
- Keep file caps (`MAX_IMPORT_BYTES`, `MAX_IMPORT_ROWS`) unless product explicitly
  raises them.

## 5. Pure parser

Add `parseSalesRows(matrix)` in `lib/import/parse.ts`.

Parser responsibilities only:

- Validate headers against `SALES_COLUMNS`.
- Validate date, item kind, quantity, money, tax percent, ingredient canonical quantity
  shape, max lengths, and row cap.
- Produce draft rows with raw item names and structural issues.
- Do not query org data, resolve item ids, dedup dates, compute stock mode, or create
  jobs.

Formula safety:

- Treat spreadsheet cells as literal values; never evaluate formulas.
- Keep template/export generation formula-safe via `neutralizeFormula`.
- If any imported text is later included in a downloadable CSV/XLSX, neutralize at that
  output boundary.

## 6. Data layer

Create `lib/data/sales-import.ts`.

### `planSalesImport`

Signature:

```ts
export async function planSalesImport(
  db: TenantClient,
  organizationId: string,
  parsed: ParsedRow<DraftSaleImportRow>[],
  settings: { defaultTaxRateBps: number; stockControlStartDate: string | null },
): Promise<SalesImportPlan>
```

Responsibilities:

- Load active recipes, menus, and ingredients for the org.
- Resolve item names exact-only per D5.
- Group structurally valid rows by `date`.
- Apply tax defaults and compute line/close totals via `saleLineTotals` / `saleTotals`.
- Mark existing non-void sale dates as skipped duplicates.
- Mark a whole close invalid if any line has a hard issue.
- Return counts by close: `total`, `importable`, `skipped`, `invalid`, plus
  `financialOnly`.
- No writes.

### `applySalesImport`

Signature:

```ts
export async function applySalesImport(
  db: TenantClient,
  organizationId: string,
  actor: AuditActor,
  closes: ImportSaleClose[],
): Promise<{
  closesCreated: number;
  linesCreated: number;
  movementsCreated: number;
  financialOnly: number;
}>
```

Responsibilities:

- Accept only `status === 'importable'` closes.
- For each close, call `createSale` with `SaleLineInput[]`.
- If `createSale` returns `date_taken`, throw a typed import error mapped to
  `SALE_DATE_TAKEN`. If it returns `invalid_source`, throw `SALE_INCOMPLETE`.
- Write `sale.create` audit after create.
- Call `postSale(tx, org, sale.id, sale.updatedAt)`.
- Map `postSale` non-ok statuses:
  `tax_rate_required -> SALES_TAX_RATE_REQUIRED`;
  `incomplete -> SALE_INCOMPLETE`;
  `idempotency_conflict -> IDEMPOTENCY_CONFLICT`;
  `not_found | stale | not_postable -> INVALID_INPUT`.
- Write `sale.post` audit after successful post.
- Accumulate counts from `PostSaleOutcome`.
- Throw on any failure after the first write so the caller's `withOrg` rolls back.

The confirm action catches typed import errors and `MovementError` outside `withOrg`.
Do not mark the job committed until every close has posted and all audits have been
written.

## 7. Actions and route changes

Prefer extending `app/(app)/import/actions.ts` only if it stays readable; otherwise add
`app/(app)/import/sales-actions.ts` and call it from a sales-specific child component.
Either way, the order is mandatory:

```text
isManager()
  -> requireFeature('invoices') for entity='sales'
  -> rate limit
  -> Zod / file validation
  -> withOrg
  -> audit
  -> revalidate
```

Preview:

- Validate `entity='sales'` through `importParamsSchema`.
- If org VAT rate is missing, return `SALES_TAX_RATE_REQUIRED` before creating a job.
- Stage `ImportSalesPayload` in `import_jobs.normalized_rows`.
- Audit `import.preview` with counts only.

Confirm:

- Confirm payload is only `jobId`; sales import has no row payload and no client-side
  resolution choices.
- Lock job `FOR UPDATE`, validate status/TTL/entity/payload.
- Apply importable closes with `applySalesImport`.
- Mark job committed and audit `import.commit`.
- Revalidate `/import`, `/sales`, `/transactions`, `/financials`, and `/dashboard`.

Template route:

- Extend `app/api/import/template/route.ts` and `lib/import/templates.ts` for sales.
- For `entity='sales'`, apply manager + `invoices` entitlement before returning the
  template, even though the template is static.

## 8. UI

Extend `app/(app)/import/import-workbench.tsx`:

- Add `sales` to the entity selector.
- Render a dedicated sales preview when `preview.entity === 'sales'`.
- Group preview by close date. Each close shows date, line count, gross, stock mode
  (`financial-only` or `moves stock`), and status (`importable`, `skipped`, `invalid`).
- Show a summary: importable closes, financial-only closes, skipped duplicates, invalid
  closes.
- Confirm button is enabled only when `counts.importable > 0`.
- Surface rollback errors with the stable action message; include the offending date in
  the returned state when available, but do not place raw item names or amounts in audit.
- Reuse the existing sales double-count warning copy.

Add i18n under `import.entity.sales`, `import.sales.*`, and issue messages for
`UNKNOWN_ITEM` and `AMBIGUOUS_ITEM`.

## 9. Tests

### Pure parser

- Valid sales rows for recipe/menu/ingredient.
- Bad date/type/number/money/tax percent.
- Ingredient line missing `ingredient_qty_canonical`.
- Recipe/menu line carrying `ingredient_qty_canonical`.
- Missing required columns, unknown columns, duplicate columns, too many rows.
- Formula-looking text remains literal and does not execute.

### Resolver / planner

- Exact single active match links.
- No match -> `UNKNOWN_ITEM`.
- Multiple exact active matches in same kind -> `AMBIGUOUS_ITEM`.
- Trashed items are ignored.
- Same display name across different kinds is OK because `item_kind` scopes lookup.
- Existing non-void sale date -> skipped duplicate.
- Existing void sale date -> importable.
- Org VAT rate null -> preview/action returns `SALES_TAX_RATE_REQUIRED`.
- Counts reconcile by close, not by raw row.

### Confirm / data

- Happy path posts multiple closes: one protected income transaction per close, sale
  status `posted`, line totals frozen, `source_type='sale'`, `daily_sales`.
- Pre-start-date close is financial-only: no movement, `stockMoved=false`.
- On/after-start-date close writes aggregated OUT movements.
- All-or-nothing: second close oversells stock -> no sales, no sale items, no income
  transactions, no movements, no audit events, job remains `parsed`.
- Concurrent/manual duplicate between preview and confirm -> rollback with
  `SALE_DATE_TAKEN`, job remains `parsed`.
- Re-confirm committed job -> success no-op, no duplicate closes, no duplicate audit.
- TTL expired -> `IMPORT_EXPIRED`, no writes.
- Stored payload tamper/shape mismatch -> `INVALID_INPUT`, no writes.

### Auth / entitlements

- Kitchen user gets `FORBIDDEN` before file parsing/job reads/template response.
- Manager without `invoices` gets `UPGRADE_REQUIRED` before file parsing/job
  reads/template response.
- Other import entities retain their existing gate behavior.

### Audit / privacy

- `import.preview` and `import.commit` once each with counts only.
- Per-sale `sale.create` / `sale.post` written during successful confirm.
- No audit metadata contains amounts, item names, raw file cells, or notes.
- Failed confirm rolls back sale and import audits.

## 10. Out of scope

- Bank reconciliation or bank-import double-count prevention.
- Per-ticket POS import, refunds/returns, updating posted closes.
- Multi-rate/inclusive tax beyond existing per-line exclusive rate.
- Silent catalogue creation or fuzzy auto-linking.
- Inventory storage areas/transfers/count depth (Sprint 12c).

## 11. Definition of Done

- `npm run lint && npm run typecheck && npm test && npm run build` green.
- Sales import template downloads for CSV and XLSX.
- Preview proves grouping, item resolution, date dedup, stock mode, and close-level
  counts.
- Confirm proves create+post through 12a, explicit sale audits, import audits,
  all-or-nothing rollback, re-confirm no-op, and date duplicate protection.
- RBAC and entitlement tests prove RBAC -> entitlement -> data order.
- i18n wired for sales import and new issue codes.
- No default migration. If D2 external_ref is chosen, migration `0033` and account
  export `13 -> 14` are local-only until reviewed.

## 12. Owner/dev confirmations

If the owner says "no changes", code the defaults above.

1. D1: line-level import grouped into daily closes.
2. D2: date-only dedup, no schema migration.
3. D3: all-or-nothing confirm, no best-effort partial commits.
4. D5: exact-only item resolution, no catalogue creation and no fuzzy auto-link.
5. D8: extend existing `/import` workbench, no standalone sales import route.
6. Process: build/review can proceed while the inherited accountant sign-off from 12a
   blocks shipping sales to production.
