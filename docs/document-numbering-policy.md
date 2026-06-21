# Document reference numbering policy (Sprint F6)

The one rule for how every kind of document gets its human reference, so each module
(PO, sales, production, invoices) doesn't grow its own — possibly unsafe — scheme.
There is **no generic `document_counters` table**: each document type that needs a
sequence gets its own dedicated counter.

| Document       | Reference source                                  | Counter            | Gaps        | Sprint   |
| -------------- | ------------------------------------------------- | ------------------ | ----------- | -------- |
| Invoice        | per-org + year sequence (`invoice_counters`)      | `invoice_counters` | **gap-FREE** (fiscal) | 3 (done) |
| Purchase order | per-org sequence (`po_counters`)                  | `po_counters`      | tolerated   | 8a       |
| Sales close    | the close **date** (one close per day)            | — (date *is* the ref) | n/a      | 12a      |
| Production     | **free text** (user-entered label)                | — (no counter)     | n/a         | 11       |

`invoice_counters` and its gap-free numbering are **untouched** by F6.

## PO counter (`po_counters`) — F6 ships this

- Table: one row per org, `last_seq integer NOT NULL DEFAULT 0` (the LAST number
  handed out), `CHECK (last_seq >= 0)`. Standard `org_isolation` RLS (normal org
  data, **not** append-only). See `lib/db/schema.ts` `poCounters`.
- **`allocatePoNumber(db, org)`** (`lib/data/po-counters.ts`): a single atomic
  `INSERT … ON CONFLICT (org) DO UPDATE SET last_seq = last_seq + 1 RETURNING
  last_seq`. It row-locks the counter (serializing concurrent allocations) and
  commits with the surrounding transaction. First call → 1, then 2, 3… This is what
  "row-locked, not `MAX(number)+1`" means — `MAX+1` is **not** concurrency-safe.
- **`advancePoCounterAtLeast(db, org, n)`**: moves the counter forward to
  `GREATEST(last_seq, n)`, never backwards.

## Rules Sprint 8a MUST honour (consumer contract)

1. **Canonical number is a positive integer.** `purchase_orders.number` stores the
   integer. Any `PO-2026-0001` style is **presentation only** — never the stored key.
2. **`unique (organization_id, number)`** + **`CHECK (number > 0)`** on
   `purchase_orders`.
3. **Allocate inside the create transaction.** Call `allocatePoNumber` in the SAME
   `withOrg` transaction that inserts the PO row — **never on opening the form**
   (abandoned drafts must not burn numbers; a rolled-back create rolls back the
   allocation).
4. **Gaps are accepted by design.** A deleted draft or a manual edit leaves a gap.
   Do NOT build a fiscal-style gap-free check for POs.
5. **On a manual number edit, call `advancePoCounterAtLeast(org, newNumber)`** in the
   same transaction, so the counter never re-issues the edited number.
6. **Per-org single sequence, no yearly reset.**
