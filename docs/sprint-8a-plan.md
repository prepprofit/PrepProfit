# Sprint 8a — Purchase Orders (draft / send + outbox) — implementation plan

> **Status: DRAFT v2 for owner review** (senior-dev review #1 folded in — outbox idempotency,
> F3 purge policy, state machine, send-time locking, and the gaps below). Migration `0026` is
> **LOCAL only — prohibited in production until the diff is reviewed** (F/7/9 cadence; owner may
> override and authorize prod directly, as in F5/F6). Source spec:
> `docs/expansion-plan-kitchen-ops.md` §6.3 + `docs/document-numbering-policy.md` +
> `docs/document-snapshot-policy.md`.

## Context

Suppliers (Sprint 7) turned free-text `ingredients.supplier` into a manager-only entity with
pack pricing. Sprint 8a is the first **transactional document** built on the Foundation: a
manager drafts a purchase order against a supplier, sends it (freezing an immutable supplier +
line snapshot and queueing a PDF email to the supplier), and the order becomes a historical
record 8b ("receiving") will later book stock against. It deliberately exercises three built-
but-unused primitives: `po_counters` (F6), the snapshot-on-issue contract (F3), and an
`email_outbox` worker.

### Decisions locked (owner, this session)
1. **All plans, no billing change.** POs are **manager-only** (F4) but not gated behind a Clerk
   feature. No `procurement` feature, no catalogue change, no webhook work.
2. **Cancel-only after send.** No amend/versioning in 8a (defer to 8b). See the state machine §3.
3. **Outbox + cron worker in scope**, with **honest at-least-once + provider-side dedup**
   semantics (not "exactly once") — see §1/§5.

### Decisions resolved in this revision (review #1)
- **F3 purge policy = PURGE-BLOCK, not null-and-purge.** An ingredient referenced by a
  **non-draft** PO (`sent`/`cancelled`) is **kept** (never hard-purged), exactly as F3 Policy B
  requires. This is the first real Policy-B implementation; `docs/document-snapshot-policy.md`
  is updated to record it. (§7)
- **Send to a supplier you order from is not required**, but a line's default unit cost is
  sourced from the selected supplier's `ingredient_suppliers` pack price when a link exists,
  else the ingredient's approved cost. The line stores its own **negotiated** cost. (§3)
- **Currency is frozen** on the PO at create (`currency_code` snapshot) so a later org-currency
  change can't rewrite a historical PO's meaning. (§1)
- **PDF allowed for all statuses**: a `draft` PDF renders live data watermarked **"DRAFT"**;
  `sent`/`cancelled` render from the frozen snapshot. (§4)

---

## 1. Data model — migration `0026` (additive), `when` > current journal max

Bump the new migration's journal `when` above the current max in `drizzle/meta/_journal.json`
(the migrate-guard aborts otherwise). All three tables go in `businessTables` → `org_isolation`
RLS, and into `buildOrgDataExport` (account-export **bump 6 → 7**).

### `purchase_orders`
`id`, `organization_id`, `number integer NOT NULL`, `currency_code text NOT NULL` (frozen from
org settings at create), `supplier_id text NULL` (live link), `status text NOT NULL DEFAULT
'draft'`, `order_date date NULL` (stamped at send), `expected_date date NULL`, `notes text NULL`,
frozen supplier snapshot + totals, `created_at`, `updated_at`.
- **Numbering (F6 contract):** `number` allocated at **draft creation** via `allocatePoNumber`
  in the create tx (never on form open). `unique (org, number)` + `CHECK (number > 0)`. Gaps
  tolerated. A manual number edit calls `advancePoCounterAtLeast` **and** surfaces a stable
  `PO_NUMBER_TAKEN` on the unique violation.
- **Live link:** composite `(org, supplier_id) → suppliers`, **`ON DELETE restrict`**, nullable.
- **Frozen supplier snapshot (filled at send, like `invoices.customer_*`):** `supplier_name`,
  `supplier_email`, `supplier_phone`, `supplier_address`, `supplier_tax_id` (nullable).
- **Totals:** `subtotal_cents`, `total_cents` (integer, int4) — **computed & stored at draft
  create/update** (so the list never shows zero before send), re-frozen at send.
- `unique (org, id)` (FK target). **CHECK** `status IN ('draft','sent','cancelled')`.

### `purchase_order_items`
`id`, `organization_id`, `purchase_order_id`, `ingredient_id text NULL` (live link),
`quantity numeric(12,3)` (**canonical** — g / ml / count), `unit_cost_cents integer NOT NULL`
(**cost per priced unit** — per kg / litre / piece; the negotiated cost, defaulted from the
supplier link), `line_total_cents integer` (computed at draft, frozen at send),
`ingredient_name text NULL` + `dimension text NULL` (snapshot frozen at send), `sort_order integer`.
- Composite FKs `(org, purchase_order_id) → purchase_orders` **cascade**;
  `(org, ingredient_id) → ingredients` **restrict**, nullable.
- DB CHECKs: `quantity > 0`, `unit_cost_cents >= 0`.

> **Terminology (review #1):** price is per **priced** unit (kg/l/piece); quantity is in
> **canonical** units (g/ml/count). Line total uses the existing `recipeCost.ts` convention
> `unit_cost_cents × quantity ÷ canonicalFactor(dimension)` — NOT "cost per canonical unit".

### `email_outbox` (lease queue — at-least-once + provider dedup)
`id`, `organization_id`, `document_type text NOT NULL`, `document_id text NOT NULL`,
`to_email text NOT NULL`, `subject text`, `status text NOT NULL DEFAULT 'pending'`
(`pending|sending|sent|failed|cancelled`), `attempts integer NOT NULL DEFAULT 0`,
`max_attempts integer NOT NULL DEFAULT 5`, `last_error text NULL`,
`provider_message_id text NULL`, `dedup_key text NOT NULL`,
**`next_attempt_at timestamptz NOT NULL DEFAULT now()`**, `lease_until timestamptz NULL`,
`claim_token text NULL`, `created_at`, `updated_at`.
- **`unique (org, dedup_key)`** — idempotent enqueue (send key `purchase_order:<id>:send`,
  cancel key `purchase_order:<id>:cancel`).
- **Indexes:** partial `(status, next_attempt_at) WHERE provider_message_id IS NULL` (the claim
  scan); `(document_type, document_id)` (per-document lookup for the UI chip).
- **CHECKs:** `status IN ('pending','sending','sent','failed','cancelled')`,
  `attempts >= 0`, `max_attempts > 0`, `document_type IN ('purchase_order')`.
- In `businessTables` → `org_isolation`.

---

## 2. Pure helpers (no I/O, tested)
- `lib/calculations/purchaseOrder.ts` — `purchaseOrderLineTotal(quantityCanonical,
  unitCostCents, dimension)` + `purchaseOrderTotals(lines)`, reusing the canonical convention in
  `lib/calculations/recipeCost.ts` / `lib/units`. Money edges: zero, large (int4 cap),
  rounding, count vs weight/volume.
- `lib/documents/snapshots.ts` — add **`supplierSnapshot(supplier)`** (F3 deferred it to
  "Sprint 7/8"): narrow `Pick<Supplier, 'name'|'email'|'phone'|'address'|'taxId'>` → frozen
  fields. Pure; the send tx loads the live supplier under lock and passes it.
  - **Trap (review #1):** the existing `ingredientLineSnapshot()` returns `unitCostCents` (the
    ingredient's *current approved* cost). The PO line freeze must take **only**
    `{ ingredientName, dimension }` from it and **keep the line's own stored
    `unit_cost_cents`** — never spread the helper over the line, or the negotiated PO cost is
    silently overwritten. The plan calls this out and a test asserts it.

---

## 3. State machine + data layer

### Explicit status transitions (the one source of truth)
| From → To | Trigger | Effect | Blocked / error |
| --- | --- | --- | --- |
| — → `draft` | create | allocate number, store totals | — |
| `draft` → `draft` | updateDraft | replace items, recompute totals | non-draft → `PO_NOT_DRAFT` |
| `draft` → (gone) | deleteDraft | hard-delete (gaps tolerated), audited | non-draft → `PO_NOT_DRAFT` |
| `draft` → `sent` | send | snapshot + freeze totals + enqueue send email | not draft → `PO_NOT_DRAFT`; no supplier → `SUPPLIER_REQUIRED`; inactive supplier → `SUPPLIER_INACTIVE`; no lines → `PO_EMPTY`; nulled/purged line link → `PO_LINE_INGREDIENT_MISSING` |
| `draft` → `cancelled` | cancel | status flip, audited | — |
| `sent` → `cancelled` | cancel | flip; **cancel the not-yet-sent outbox row** (`pending`/`sending` → `cancelled`); if the send email already left (`sent`), enqueue a **cancellation notice** (`:cancel` dedup key) | already `cancelled` → idempotent no-op (returns ok) |
| `sent` → `sent` | re-send | **rejected** → `PO_NOT_DRAFT` (NOT a silent no-op) | — |

### `lib/data/purchase-orders.ts` (mirrors `lib/data/invoices.ts`)
- `listPurchaseOrders`, `getPurchaseOrderWithItems`.
- `createDraftPurchaseOrder` — allocate `number`, freeze `currency_code`, insert PO + items,
  compute+store totals.
- `updateDraftPurchaseOrder` — re-assert `status='draft'` **inside the UPDATE predicate**
  (`updateDraftInvoice` pattern); recompute totals; on `number` change call
  `advancePoCounterAtLeast` + map the unique violation → `PO_NUMBER_TAKEN`.
- **`sendPurchaseOrder` — full concurrent-safe snapshot (review #1):**
  1. `SELECT … FOR UPDATE` the PO; assert `status='draft'` (double-send blocks then bails → no
     second number/snapshot).
  2. `SELECT … FOR UPDATE` the linked supplier; missing → `SUPPLIER_REQUIRED`, archived →
     `SUPPLIER_INACTIVE`.
  3. Collect line ingredient ids, **lock them `FOR UPDATE` in deterministic id-ascending order**
     (anti-deadlock, the F1 convention). Any line whose `ingredient_id` is NULL (link nulled) or
     points at a trashed/missing ingredient → `PO_LINE_INGREDIENT_MISSING` (explicit, never a
     silent drop).
  4. Freeze: `supplierSnapshot` columns; per line freeze **only** `ingredient_name`/`dimension`
     (keep stored `unit_cost_cents`); recompute + freeze `line_total_cents` + PO totals; stamp
     `order_date`; flip `status='sent'`.
  5. Enqueue **one** `email_outbox` row (`ON CONFLICT (org, dedup_key) DO NOTHING`, `to` =
     supplier email) **only when the supplier has an email** — same tx. No email → still `sent`,
     no row; UI warns.
- `cancelPurchaseOrder` — per the table (handles outbox interaction in the same tx).
- `deleteDraftPurchaseOrder` — draft-only hard delete, audited.

### `lib/data/email-outbox.ts` (new) — lease queue
- `enqueueEmail` — `INSERT … ON CONFLICT (org, dedup_key) DO NOTHING`.
- **`claimDueOutbox(db, org, now, claimToken, limit)`** — atomic claim that two workers can't
  both win: `UPDATE email_outbox SET status='sending', lease_until=now()+lease, claim_token=$tok
  WHERE id IN (SELECT id FROM email_outbox WHERE provider_message_id IS NULL AND ((status='pending'
  AND next_attempt_at <= now()) OR (status='sending' AND lease_until < now())) ORDER BY
  next_attempt_at FOR UPDATE SKIP LOCKED LIMIT $n) RETURNING *`. `SKIP LOCKED` + the lease
  recover both un-leased `pending` rows and **expired-lease `sending` rows** (worker crash
  recovery).
- `markOutboxSent(id, token, providerMessageId)` — guarded by `claim_token=$token`; sets
  `status='sent'`, `provider_message_id`, clears lease.
- `markOutboxFailed(id, token, error, attempt, maxAttempts)` — `attempts+1`; `failed` once
  `attempts >= max_attempts`, else back to `pending` with `next_attempt_at = now() + backoff`,
  clears lease. (`failed`/`cancelled` are terminal.)
- `cancelPendingOutbox(db, org, documentId)` — `pending`/`sending` (un-sent) send row →
  `cancelled` (used by PO cancel).
- **Honest invariant:** never claim/send a row that already has `provider_message_id`. Combined
  with the **provider idempotency key** (§5) the guarantee is *at-least-once delivery with
  provider-side dedup*, not exactly-once.

---

## 4. PO PDF (snapshot) — reuse the document infra
- `lib/documents/po-data.ts` — pure view-model; for `sent`/`cancelled` reads the **frozen**
  columns (never re-joins the live supplier), for `draft` reads live data and sets a `draft:true`
  flag. Mirrors `lib/documents/invoice-data.ts`; reuses `seller.ts`/`format.ts`.
- `lib/documents/po-pdf.tsx` + `po-labels.ts` — react-pdf (Node); a **"DRAFT" watermark** when
  `draft`. Logo via SSRF-safe `lib/documents/logo.ts`.
- **Manager-only route** `app/api/purchase-orders/[id]/pdf/route.ts` — canonical order (mirror
  `app/api/invoices/[id]/pdf/route.ts`): `isManager()`→403 → rate-limit (`documents`, 20/min) →
  `withOrg` load → render → **post-success** audit `export.purchaseOrderPdf`. 404 / 429.
- Print page `/purchase-orders/[id]/print` for parity (reuses the view-model + `PrintLogo`).

---

## 5. Outbox cron worker
- `app/api/cron/process-email-outbox/route.ts` (Node, `force-dynamic`) — mirrors
  `app/api/cron/purge-trash/route.ts`:
  - `isCronAuthorized(authHeader, CRON_SECRET)`→401; rate-limit new **`outboxWorker`** bucket
    (cron-keyed by hashed header, like `cronPurge`)→429; no-op early when `!isEmailConfigured()`.
  - Fan out over Clerk orgs. Per org, generate a `claim_token`, `claimDueOutbox(... )` inside
    `withOrg`. For each claimed row, render the PO PDF + `getEmailSender().send({ …,
    idempotencyKey: row.dedupKey })` **outside the claim tx** (low-stock-digest precedent), then
    a second `withOrg`: success → `markOutboxSent` + audit **`document.email`** (metadata =
    documentType + provider message id only); failure → `markOutboxFailed` with exponential
    backoff. Per-row try/catch so one failure never blocks the sweep.
- **Provider idempotency:** extend `EmailSender.send` (`lib/email/resend.ts`) with an optional
  `idempotencyKey`, forwarded to Resend, so a crash *after* the provider accepted but *before*
  `markOutboxSent` does not double-send on retry.
- **Schedule:** add the route to `vercel.json` cron (frequent; note the Vercel-plan cron-
  frequency floor as an ops detail). The send action stays outbox-only (no inline send) to keep
  the tx clean.

---

## 6. Server actions, validation, audit
- `app/(app)/purchase-orders/actions.ts` — `create/updateDraft/send/cancel/deleteDraft
  PurchaseOrderAction`; each `isManager()`→`FORBIDDEN` **before** data, Zod-validated, audited.
- **Validation `lib/validation/purchase-orders.ts`** — mirror `lib/validation/invoices.ts`
  int4/length caps: cap `quantity`, `unit_cost_cents`, line count, computed totals to int4
  (`superRefine` on overflow), and bound `notes`/text lengths. Number must be a positive
  integer.
- New `AuditAction`s (`lib/data/audit.ts`): `purchaseOrder.create/.update/.send/.cancel/.delete`
  (**`.delete` was missing** — review #1), `export.purchaseOrderPdf`. Reuse `document.email`
  (worker) + existing supplier audits. Metadata = ids/counts/status only; **never supplier
  contact PII** (email/phone/address/tax id) or line money tied to a person.
- New `ActionErrorCode`s (`lib/action-result.ts`): `PO_NOT_DRAFT`, `SUPPLIER_REQUIRED`,
  `PO_EMPTY`, `PO_NUMBER_TAKEN`, `PO_LINE_INGREDIENT_MISSING` (reuse `SUPPLIER_INACTIVE` from
  Sprint 7, `NOT_FOUND`/`FORBIDDEN`/`INVALID_INPUT`).
- **UI** (`NoAccess` for kitchen; manager-only sidebar group via `canSeeFinance`):
  `/purchase-orders` list (number, supplier, status badge, total, date) + New PO;
  `/purchase-orders/[id]` draft editor (supplier picker = active suppliers; line rows =
  ingredient picker + qty + unit cost defaulted from the supplier link / approved cost), Send /
  Cancel / Download PDF / Print, and an **outbox status chip** (pending/sent/failed/cancelled)
  read via the `(document_type, document_id)` index. ⌘K `purchaseOrder` descriptor
  (`canAccess: canAccessFinancials`) over `number` + `supplier_name`, deep-link
  `/purchase-orders?highlight=<id>` (reuse `use-row-highlight`). i18n `purchaseOrders.*` +
  `nav.purchaseOrders`.

---

## 7. Purge / snapshot integrity — F3 Policy B (purge-block)
This **replaces** the v1 null-and-purge approach, which contradicted
`docs/document-snapshot-policy.md`.
- **Suppliers** never hard-delete (archive only) → the `restrict` supplier FK is never tripped.
- **Ingredients** (which DO purge): extend `purgeExpired` (`lib/data/trash.ts`) with a
  **`NOT EXISTS` skip** — an ingredient referenced by a **non-draft** PO item
  (`purchase_orders.status IN ('sent','cancelled')`) is **kept in trash, never purged** (the
  exact pattern already used for the active-recipe-line pin). A **draft-only** reference may be
  purged after nulling the draft's line link (Policy B allows this; no history at stake).
- This is the **first real Policy-B implementation**: update
  `docs/document-snapshot-policy.md` (mark "first reference check + purge-block lands in
  Sprint 8a", note it is expressed through the existing trash "kept" state, not a new
  `archived_at` column) so the contract and the code agree.

---

## 8. Tests
- **Pure:** `purchaseOrder.test.ts` (line/total math, rounding, int4 edges); `snapshots.test.ts`
  (+`supplierSnapshot`, **and the "freeze keeps line cost, not approved cost" trap**);
  `po-data.test.ts` (sent reads frozen; draft reads live + DRAFT flag).
- **PGlite `tests/purchase-orders.test.ts`:** create allocates number + freezes currency +
  stores draft totals (non-zero in list before send); draft edit; **send freezes
  supplier+line+totals, flips status**; edit/delete after send → `PO_NOT_DRAFT`; send paths →
  `SUPPLIER_REQUIRED` / `SUPPLIER_INACTIVE` / `PO_EMPTY` / `PO_LINE_INGREDIENT_MISSING`; editing
  the supplier/ingredient after send leaves the sent PO unchanged; `unique(org,number)` →
  `PO_NUMBER_TAKEN`; manual number edit advances the counter; cross-org RLS on all three tables;
  FK restrict; cancel transitions per the table.
- **`tests/email-outbox.test.ts`:** enqueue idempotent (dedup unique); **claim leases + flips to
  sending**; `markOutboxSent` sets `provider_message_id` + audits `document.email` only after
  accept; failure → backoff/`pending`, exhausted → `failed`; **never claims a row with
  `provider_message_id`**; **expired-lease `sending` row is re-claimable** (crash recovery);
  `cancelPendingOutbox` cancels an un-sent row.
- **Worker route `tests/cron-email-outbox.test.ts`:** 401/429; processes across orgs (mocked
  Clerk + mocked sender); idempotent re-run; no-op when email unconfigured; **provider
  idempotencyKey is passed**.
- **RBAC `tests/purchase-orders-authz.test.ts`:** every action `FORBIDDEN` for kitchen before
  data; PDF route 403/200; search descriptor excluded for kitchen.
- **PDF route `tests/purchase-order-pdf-route.test.ts`:** 403/404/200+`%PDF`+audit/429.
- **`tests/account-export.test.ts`:** version 7, three new tables (real rows), never another
  tenant's.
- **Real-PG concurrency `tests/concurrency/purchase-orders.pg.test.ts`** (opt-in
  `TEST_DATABASE_URL`, skipped in CI): two concurrent `createDraftPurchaseOrder` → distinct
  numbers; two concurrent `sendPurchaseOrder` → one snapshot + one outbox row; **two workers
  over one outbox batch (`FOR UPDATE SKIP LOCKED`) never double-send**; **expired lease is
  reclaimed exactly once**; **crash-after-accept (kill before `markOutboxSent`) → next run does
  not duplicate** (provider idempotency); **cancel × in-flight send race** ends in a single
  coherent terminal state.

---

## 9. Out of scope (later sprints)
Receiving / `receipts` / inventory IN movements + the F2 `cost_change` flag (8b); amend/revision
of a sent PO (8b); ordering in pack units vs canonical (canonical only in v1); PO approval
workflow; multi-currency conversion (we only *freeze* the code); requiring an ingredient be
linked to the ordered supplier; dropping `ingredients.supplier`.

---

## 10. Definition of Done
- `npm run lint && npm run typecheck && npm test && npm run build` green.
- Migration `0026` applied **locally**; prod awaits diff review (owner may authorize directly).
- F4 not regressed: POs manager-only (pages `NoAccess`, actions `FORBIDDEN`, PDF route 403,
  search excluded for kitchen); no money leaks to kitchen.
- Snapshot-on-send proven (edit master after send ⇒ sent PO unchanged; line keeps negotiated
  cost); outbox is **at-least-once + provider-dedup** (lease + `SKIP LOCKED` + idempotency key),
  `document.email` audited only after the provider accepts.
- **F3 purge-block** implemented + `docs/document-snapshot-policy.md` updated to match (no
  contradiction); ingredient purge keeps any non-draft-PO-referenced ingredient.
- Every PO mutation audited incl. `.delete` (no supplier contact PII); account-export 6 → 7 +
  tested.
- `docs/sprint-8a-plan.md` committed; full diff handed to the owner for review.

---

## 11. Codebase anchors (reuse, don't reinvent)
- `lib/data/po-counters.ts` (`allocatePoNumber`/`advancePoCounterAtLeast`) ·
  `docs/document-numbering-policy.md`.
- `lib/data/invoices.ts` (`issueInvoice` snapshot+lock+allocate; `updateDraftInvoice` re-assert;
  totals stored at draft) · `lib/documents/invoice-data.ts` / `invoice-pdf.tsx` /
  `app/api/invoices/[id]/pdf/route.ts` · `/invoices/[id]/print` ·
  `lib/validation/invoices.ts` (int4 superRefine caps).
- `lib/documents/snapshots.ts` (+`supplierSnapshot`; the `unitCostCents` trap) ·
  `docs/document-snapshot-policy.md` (Policy A **and** B) · `lib/documents/seller.ts`/`logo.ts`.
- `lib/data/suppliers.ts` (`getSupplierById`, active/`SUPPLIER_INACTIVE`) ·
  `lib/data/ingredients.ts` (`lockActiveIngredientRow`) · `lib/data/ingredient-suppliers.ts`
  (default link → line default cost) · `lib/calculations/recipeCost.ts` + `lib/units`.
- `app/api/cron/purge-trash/route.ts` (cron-auth + Clerk-org fan-out + send-outside-tx) ·
  `lib/email/resend.ts` (`EmailSender` seam; add `idempotencyKey`) ·
  `lib/rate-limit/config.ts` (add `outboxWorker`) · `lib/data/trash.ts` (`purgeExpired`
  `NOT EXISTS` skip precedent).
- `lib/data/account-export.ts` (`ACCOUNT_EXPORT_SCHEMA_VERSION` 6 → 7) · `lib/data/audit.ts` ·
  `lib/action-result.ts` · `lib/search/registry.ts` + `queries.ts` ·
  `drizzle/meta/_journal.json` (bump `when` for 0026).

## Verification (end-to-end)
1. `npm run db:generate`; apply 0026 **locally**; confirm the migrate-guard prints "Journal
   ordering OK".
2. `npm test` incl. the new PO/outbox/RBAC/route/export suites; optionally the opt-in
   `*.pg.test.ts` against a real Postgres `TEST_DATABASE_URL` (the two-worker / lease / crash /
   cancel-race cases).
3. `npm run dev` as a **manager**: create draft PO → list shows a non-zero total → add lines →
   Send → status flips, snapshot freezes (edit the supplier afterwards; reopen; unchanged),
   download PDF, outbox chip = pending.
4. Hit `/api/cron/process-email-outbox` with the `CRON_SECRET` bearer (Resend configured) → row
   → `sent`, `provider_message_id` set, `document.email` audited; hit again → no resend; 401
   without the bearer.
5. Cancel a `sent` PO whose email already went → a `:cancel` notice is enqueued; cancel one
   still `pending` → the send row flips to `cancelled` and the worker skips it.
6. As **kitchen**: `/purchase-orders` → `NoAccess`; PDF route → 403; ⌘K shows no PO results.
7. `npm run lint && npm run typecheck && npm run build` green.
