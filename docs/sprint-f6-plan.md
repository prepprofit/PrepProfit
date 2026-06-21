# Sprint F6 — Document numbering + supplier-identity transition — implementation plan

> **Status:** **AUTHORIZED for LOCAL implementation (dev review — decisions resolved,
> all mandatory corrections folded in).** This is the last Foundation slice (F1–F5
> DONE & on `main`; prod migrated to 0022). Source spec:
> `docs/expansion-plan-kitchen-ops.md` v2.2 §4 F6 + the owner's locked decisions.
>
> Like F3 (snapshot policy) and F5 (sales↔transactions), the **consumers don't exist
> yet** — `purchase_orders` is **Sprint 8a**, `suppliers` is **Sprint 7**. So F6
> ships the **reusable primitives + the contracts** those sprints implement against,
> testable now with synthetic usage. **No PO table, no suppliers table, no UI.**
>
> **Migration `0023` is applied LOCALLY only — PROHIBITED in production until the
> diff is reviewed** (as F1/F2/F5). With the §11 corrections delivered and the §6
> tests green, F6 is authorized; **Sprint F (Foundation) is COMPLETE** only after the
> §10 hook-coverage note (export done; purge + seed/demo explicitly deferred) is in.

---

## 0. What F6 is — the last FOUNDATION slice

Sprint F locks the cross-cutting invariants the real modules (7–12) would otherwise
each reinvent and silently diverge on: stock (F1), cost (F2), document snapshots
(F3), RBAC (F4), revenue/tax (F5). **F6's invariants are two:**

1. **Document reference numbering** — one policy for how every kind of document gets
   its human reference, so POs (8a), sales closes (12a), productions (11) and the
   existing invoices don't each grow a different, possibly-unsafe scheme.
2. **Supplier identity** — how a supplier name becomes a real supplier record without
   losing the legacy free-text `ingredients.supplier` data, so Suppliers (7), PO (8)
   and imports all dedup the SAME way (one normalization key, not re-implemented per
   call site).

F6 delivers the primitives buildable + testable now plus the contract docs the
consuming sprints implement. **It does NOT build `purchase_orders`, `suppliers`,
`supplier_links`, receiving, or any UI.**

---

## 1. The model F6 codifies

### A. Document reference numbering — dedicated counters, NOT a generic table

**Decision (locked):** there is **no** generic `document_counters` table. Each
document type that needs a sequence gets its own dedicated counter, mirroring the
proven `invoice_counters` pattern. Across all doc types:

| Document       | Reference source                                  | Sprint   | F6 builds                          |
| -------------- | ------------------------------------------------- | -------- | ---------------------------------- |
| Invoice        | existing `invoice_counters` (per-org+year, gap-FREE) | 3 (done) | **untouched**                   |
| Purchase order | dedicated `po_counters` (per-org sequence)        | 8a       | the **counter + the two primitives** |
| Sales close    | the close **date** (one close/day; no counter)    | 12a      | nothing (date *is* the ref)        |
| Production     | **free text** (user-entered label, no counter)    | 11       | nothing                            |

- **`po_counters`** mirrors `invoice_counters` (`lib/db/schema.ts:582`): one row per
  org. ⚠️ **Correction (§11.1):** the column holds the **LAST number allocated**, so
  it is named **`last_seq integer NOT NULL DEFAULT 0`** (NOT `next_value`), exactly
  like `invoice_counters.last_seq`. A **`CHECK (last_seq >= 0)`** (§11.4) guards it.
  Added to `businessTables` → standard `org_isolation` RLS (like `invoice_counters`
  at `schema.ts:1049`); it is normal org data, **NOT** append-only — do not copy the
  audit-log SELECT/INSERT-only policy (§10).
- **`allocatePoNumber(db, org)`** mirrors `nextInvoiceSeq` (`lib/data/invoices.ts:42`):
  a single atomic `INSERT (org, last_seq=1) ON CONFLICT (org) DO UPDATE SET last_seq =
  ${last_seq} + 1 RETURNING last_seq`. First call → 1, then 2, 3… This is what
  "row-locked, NOT MAX+1" means in practice — the upsert-increment takes the row lock
  internally and is concurrency-safe; `MAX(number)+1` is NOT.
- **`advancePoCounterAtLeast(db, org, n)`** (§11.2) — closes the manual-edit hole:
  `INSERT (org, last_seq=n) ON CONFLICT (org) DO UPDATE SET last_seq =
  GREATEST(po_counters.last_seq, EXCLUDED.last_seq)`. If a user edits a PO from 10 to
  500, Sprint 8a calls this with 500 so the counter never re-issues 500. The counter
  only ever moves forward.
- **Allocation timing (8a contract, §11.3):** `allocatePoNumber` MUST be called
  **inside the same `withOrg` transaction that inserts the `purchase_orders` row** —
  never on opening the create form. (A rolled-back create rolls back the allocation;
  abandoned drafts never burn numbers.)
- **Gaps tolerated + editable + unique (8a contract):** unlike invoices (gap-free is
  fiscal), a PO number may have gaps (deleted draft, manual edit) and may be edited.
  The counter only yields the suggested default; `purchase_orders.number` is an
  editable column with **`unique (organization_id, number)`** and a **positive-integer
  CHECK (`number > 0`)** — both **enforced by Sprint 8a** (the table doesn't exist
  yet). The canonical number is a **positive integer** (§5.4); any `PO-2026-0001`
  style is **presentation only** (8a display), never stored as the key.

`invoice_counters` and its gap-free numbering are **completely untouched** by F6.

### B. Supplier identity transition — dual-write + idempotent backfill

Today a supplier is free text on the ingredient (`ingredients.supplier`,
`schema.ts:119`). Sprint 7 introduces a real `suppliers` table. The migration must
not lose data or break the legacy column while other code still reads it.
**Decision (locked):** suppliers stay in F6 as **helper + contract**; the tables and
the dual-write/backfill code remain **Sprint 7** (they need the table).

**What F6 ships now:**
- a pure **`normalizeSupplierName(name)`** helper — the single source of truth for
  the dedup key. **Correction (§11, suppliers):** it explicitly does
  **`.toLowerCase()`**, **`.trim()`**, and **collapses Unicode whitespace**
  (`replace(/\s+/gu, ' ')`), so `'  ACME   Foods '` and `'acme foods'` map to the
  same key. An **empty result (`''`) is invalid** — callers must reject it, never
  create a supplier with key `''`.
- the **supplier-transition contract** doc (below) Sprint 7 implements against.

**Contract Sprint 7 MUST honour (folded-in corrections):**
1. Store a **`normalized_name` column computed by the TS helper** at write time and
   apply **`unique (organization_id, normalized_name)`**. A SQL constraint cannot
   "reuse" the TS function, so the normalized value is written into a real column and
   the DB only enforces uniqueness on it (it does not re-derive the key in SQL).
2. The normalization logic lives in ONE place (`normalizeSupplierName`); SQL and the
   import path must NOT duplicate `lower(trim(...))` inline — they call the helper.
3. **Reject the empty key** — never create a supplier from a blank/whitespace name.
4. The **backfill picks the display name deterministically** when `ACME`, `Acme`,
   `acme` all collapse to one key (e.g. the most frequent, tie-broken by first-seen
   / lexicographic — pick one rule and state it), so re-runs are stable.
5. **Dual-write covers ALL writers:** ingredient create/edit, imports, receiving,
   and supplier rename — every path that can set a supplier keeps the new record +
   the legacy column in sync during the window.
6. Since Sprint 7 allows **multiple suppliers with one default**, the legacy
   `ingredients.supplier` text mirrors **only the supplier marked `is_default`**.
7. **Renaming the default supplier** updates the legacy `ingredients.supplier` text
   on **all linked ingredients** during the transition window.
8. `ingredients.supplier` is dropped only in a later sprint, after the dual-write
   window proves the linked model is the single source of truth.

---

## 2. Contracts documented in F6

- **`docs/document-numbering-policy.md`** — the §1.A table: which doc types get a
  counter; the atomic-increment rule; `allocatePoNumber` + `advancePoCounterAtLeast`;
  same-tx allocation; gap-free (invoice) vs gap-tolerant+editable (PO); per-org
  sequence; canonical positive integer; the `unique (org, number)` + `number > 0`
  rules Sprint 8a enforces.
- **`docs/supplier-transition-contract.md`** — the §1.B contract (8 points): the
  `normalized_name` column + `unique (org, normalized_name)`, single-source helper,
  empty-key rejection, deterministic display-name pick, all-writers dual-write,
  `is_default` mirroring, default-rename propagation, drop-legacy-later.

---

## 3. Files

### CREATE
- `lib/data/po-counters.ts` — `allocatePoNumber(db, org)` + `advancePoCounterAtLeast(db, org, n)`.
- `lib/suppliers/normalize.ts` + `lib/suppliers/normalize.test.ts` — pure
  `normalizeSupplierName`.
- `docs/document-numbering-policy.md`, `docs/supplier-transition-contract.md`.
- `drizzle/0023_*.sql` — additive (`po_counters` + CHECK), hand-verified `when` >
  1782057106858 (0022).
- `tests/po-counter.test.ts` (PGlite) — functional: allocation sequence,
  `advancePoCounterAtLeast` never goes backwards, CHECK rejects negative, **cross-org
  RLS** (§11.6), org-scoped independence.
- `tests/concurrency/po-counter.pg.test.ts` (opt-in real Postgres, §11.5) — N
  concurrent `allocatePoNumber` → N distinct numbers, no collision. `describe.skipIf
  (!TEST_DATABASE_URL)`, neon-serverless Pool, mirrors
  `tests/concurrency/inventory-idempotency.pg.test.ts`.

### CHANGE
- `lib/db/schema.ts` — add `poCounters` (`organization_id` PK, `last_seq integer NOT
  NULL DEFAULT 0`, `check('po_counters_last_seq_chk', sql\`last_seq >= 0\`)`); add
  `'po_counters'` to `businessTables`.
- `lib/data/account-export.ts` — add `poCounters` to the bundle + bump
  `ACCOUNT_EXPORT_SCHEMA_VERSION` **3 → 4**.
- `tests/account-export.test.ts` — version 4 + assert a real `poCounters` row +
  cross-org isolation (§11.7).

### NO RLS policy change beyond adding `po_counters` to `businessTables`.

---

## 4. Migration `0023` (additive, no backfill)

1. `CREATE TABLE po_counters (organization_id text PRIMARY KEY, last_seq integer NOT
   NULL DEFAULT 0, CONSTRAINT po_counters_last_seq_chk CHECK (last_seq >= 0))`
   (drizzle table builder + `check(...)`; mirror `invoice_counters` + the new CHECK).
2. RLS: `po_counters` in `businessTables` → standard `org_isolation` applied by
   `npm run db:migrate` (`lib/db/rls.ts`).
- **Verify `_journal.json` `when` > 1782057106858** (current max, 0022) — the
  recurring gotcha; `migrate-guard` also aborts if not. Apply **LOCALLY only**;
  **prod migration waits for the diff review.**
- No data backfill, no change to existing rows.

---

## 5. Decisions — RESOLVED (dev review)

1. **Shape 1 (primitive + contracts) → APPROVED.** Build `po_counters` + the two
   primitives + the contracts now.
2. **PO numbering → per-org single sequence, NO yearly reset.** Confirmed.
3. **Suppliers stay in F6 → helper + contract only; tables/dual-write/backfill remain
   Sprint 7.**
4. **Canonical number → positive INTEGER.** `PO-…` formatting is presentation (8a).
5. **Generic snapshot/purge extraction → OUT** (leave for whenever a real second
   consumer needs it).
6. **Account export → bump 3 → 4.**

---

## 6. Tests

- **`lib/suppliers/normalize.test.ts`** (pure): lowercases, trims, collapses Unicode
  whitespace; `'  ACME   Foods '` === `'acme foods'` key; blank/whitespace-only →
  `''` (callers reject).
- **`tests/po-counter.test.ts`** (PGlite, under `tenant_app`):
  - `allocatePoNumber` returns 1, 2, 3 for one org;
  - two orgs have independent sequences;
  - `advancePoCounterAtLeast(org, 500)` then `allocatePoNumber` → 501; calling it
    with a value **below** the current `last_seq` does NOT lower it;
  - the CHECK rejects a negative `last_seq` (direct write);
  - **cross-org RLS (§11.6):** inside ORG_A's GUC context, a SELECT/UPSERT targeting
    ORG_B's counter sees/affects **nothing** (RLS, not just "separate rows").
- **`tests/concurrency/po-counter.pg.test.ts`** (opt-in real PG, §11.5): K parallel
  `allocatePoNumber` across K transactions → K distinct contiguous-ish numbers, zero
  duplicates. Skipped without `TEST_DATABASE_URL`.
- **`tests/account-export.test.ts`**: bundle version 4, `poCounters` present, a real
  seeded counter row exported, and ORG_B's export never contains ORG_A's counter
  (§11.7).

---

## 7. Definition of Done

- `npm run lint && npm run typecheck && npm test && npm run build` green.
- Migration `0023` applied **LOCALLY only**; **prod PROHIBITED until the diff is
  reviewed.**
- Every §11 correction delivered; §6 tests green (incl. the cross-org RLS test and
  the opt-in real-PG concurrency test).
- Both contract docs committed; the §10 hook-coverage note committed.
- **Full diff handed to the dev. Sprint F (Foundation) is COMPLETE** → next is Sprint
  9 (Allergens) per the approved sequence, each with its own plan + review.

---

## 8. Out of scope for F6 (do NOT build)

- `purchase_orders` table, PO lifecycle, the `unique (org, number)` + `number > 0`
  guards, same-tx allocation wiring, and any PO UI → **Sprint 8a** (consumes
  `allocatePoNumber` / `advancePoCounterAtLeast`).
- `suppliers` table, dual-write code, backfill script, supplier links, `is_default`,
  default-rename propagation → **Sprint 7** (consumes `normalizeSupplierName`).
- Sales-close / production reference generation (date / free text, no counter).
- Dropping legacy `ingredients.supplier` → a later sprint.
- Generic snapshot/purge pattern extraction (§5.5).

---

## 9. Codebase anchors (verified this plan)

- `lib/data/invoices.ts:42` — `nextInvoiceSeq`, the atomic `ON CONFLICT DO UPDATE …
  + 1 RETURNING` counter `allocatePoNumber` mirrors.
- `lib/db/schema.ts:582` — `invoice_counters` table shape to mirror (`last_seq`);
  `:119` `ingredients.supplier` legacy free-text column; `:1037`/`:1049`
  `businessTables` (add `'po_counters'`).
- `lib/db/rls.ts` — `businessTables` → standard `org_isolation` (counters are normal
  org data; no carve-out).
- `lib/data/account-export.ts:40` — `ACCOUNT_EXPORT_SCHEMA_VERSION` (3 → 4).
- `lib/data/trash.ts` — `purgeExpired` does NOT (and must not) touch counters (parity
  with `invoice_counters`).
- `tests/concurrency/inventory-idempotency.pg.test.ts` — the opt-in real-PG harness
  (`TEST_DATABASE_URL`, `describe.skipIf`, neon-serverless Pool) to mirror.
- `scripts/seed-demo.ts:228` — the seed/demo delete set (counters are absent;
  parity rationale in §10).
- `drizzle/meta/_journal.json` — current max `when` 1782057106858 (0022); 0023 must
  exceed it.

---

## 10. New-table hook coverage (export / purge / seed-demo) — REQUIRED note

The parent plan expects a new table to be wired into the three integration hooks.
Adding `po_counters`, F6 covers them as follows — and **explicitly documents the two
deferrals** so Foundation isn't declared complete with a silent gap:

- **Export — DONE.** `po_counters` is added to `buildOrgDataExport` and the schema
  version is bumped 3 → 4, with a test (§6).
- **Purge — N/A (documented).** A counter is never soft-deleted or auto-purged;
  `purgeExpired` correctly does not touch it, exactly like `invoice_counters`. **If a
  future org HARD-delete (GDPR fulfilment / `organization.deleted` cascade) is ever
  built, it MUST include BOTH counter tables** — recorded here, not built in F6 (no
  such automated path exists today; deletion is operator out-of-band).
- **Seed/demo — N/A (documented).** A counter auto-creates on first allocation and
  needs no seed/demo row; it is intentionally absent from `scripts/seed-demo.ts`,
  parity with `invoice_counters`. Demo POs (Sprint 8a) will allocate through
  `allocatePoNumber` like real ones.

---

## 11. Mandatory corrections (dev review — all REQUIRED)

Authorization is conditional on every item below; they are folded into the sections
above — this is the checklist.

1. **Column is `last_seq` (last allocated), not `next_value`.** `DEFAULT 0`,
   mirroring `invoice_counters`; function is `allocatePoNumber`. (§1.A, §4)
2. **`advancePoCounterAtLeast(org, n)`** so a manual PO-number edit (10 → 500)
   advances the counter to ≥ 500 and it never re-issues 500. `GREATEST(last_seq, n)`.
   (§1.A; the 8a wiring is 8a's, the primitive + contract are F6's.)
3. **Allocation happens in the SAME tx that creates the draft PO**, never on form
   open. Documented as the 8a contract in the policy doc. (§1.A)
4. **`CHECK (last_seq >= 0)`** on `po_counters`; `purchase_orders.number` is a
   positive integer (`> 0`, 8a). (§4)
5. **PGlite can't prove real concurrency.** Keep PGlite functional tests AND add an
   opt-in real-PG test (`TEST_DATABASE_URL`, `describe.skipIf`) under
   `tests/concurrency/`. (§3, §6)
6. **RLS test attempts cross-org access** — operate on ORG_B's counter from inside
   ORG_A's context and prove it's blocked, not merely that sequences are independent.
   (§6)
7. **Export test asserts a REAL `poCounters` row + cross-org isolation**, not just the
   version bump. (§6)
8. **Supplier helper is the single key source**: explicit `.toLowerCase()` + `.trim()`
   + Unicode-whitespace collapse; SQL/imports never duplicate it; **empty key
   rejected**. (§1.B)
9. **Supplier contract (Sprint 7) must:** store a `normalized_name` column + `unique
   (org, normalized_name)`; pick the display name deterministically on collision;
   dual-write across ALL writers (ingredient create/edit, imports, receiving, rename);
   mirror only the `is_default` supplier into legacy `ingredients.supplier`; propagate
   a default-rename to all linked ingredients in the window. (§1.B, §2)
10. **Document the export/purge/seed-demo hook coverage** (export done; purge +
    seed/demo N/A with rationale + the future-org-delete note) before declaring
    Foundation complete. (§10)
