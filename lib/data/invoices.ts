import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import {
  customers,
  invoiceCounters,
  invoiceItems,
  invoices,
} from '@/lib/db/schema';
import type { Invoice, InvoiceItem, InvoiceStatus } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';
import { invoiceTotals } from '@/lib/calculations/invoice';
import type { InvoiceSummary } from '@/lib/calculations/invoice';
import { toSafeCents } from '@/lib/data/transactions';
import type { InvoiceDraftInput, InvoiceItemInput } from '@/lib/validation/invoices';

/**
 * Access to `invoices` is ALWAYS org-scoped (RULE #1); RLS is the second layer.
 * Invoices are financial data — every caller is behind the manager-only RBAC gate.
 *
 * Lifecycle: draft → issued → paid / void. A draft is freely editable and has no
 * number; at issue a GAP-FREE number is allocated, the customer is snapshotted and
 * the monetary totals are FROZEN. Issued/paid/void invoices are immutable (status
 * transitions + internal note aside) and are never deleted — only DRAFTS are
 * soft-deletable. Money is integer cents.
 */

/** Display form of an invoice number, e.g. (2026, 1) → 'INV-2026-0001'. */
export function formatInvoiceNumber(year: number, seq: number): string {
  return `INV-${year}-${String(seq).padStart(4, '0')}`;
}

/**
 * Atomically allocates the next sequence number for (org, year) and returns it.
 * A single upsert-increment: it takes a ROW LOCK on the counter (serializing
 * concurrent allocations) and only commits with the surrounding transaction — a
 * rollback releases the lock without consuming a number, so the sequence is
 * GAP-FREE. `last_seq` is monotonic and never decremented. Must run inside the
 * same `withOrg` transaction that issues the invoice.
 */
export async function allocateInvoiceNumber(
  db: TenantClient,
  organizationId: string,
  year: number,
): Promise<number> {
  const [row] = await db
    .insert(invoiceCounters)
    .values({ organizationId, year, lastSeq: 1 })
    .onConflictDoUpdate({
      target: [invoiceCounters.organizationId, invoiceCounters.year],
      set: { lastSeq: sql`${invoiceCounters.lastSeq} + 1` },
    })
    .returning({ lastSeq: invoiceCounters.lastSeq });
  if (!row) throw new Error('Failed to allocate invoice number.');
  return row.lastSeq;
}

export type InvoiceListItem = {
  id: string;
  status: InvoiceStatus;
  number: string | null;
  /** Snapshot name if issued, else the live linked customer's name (draft). */
  customerName: string | null;
  totalCents: number;
  issueDate: string | null;
  /** Bare 'YYYY-MM-DD' due date (set at issue), or null. Drives AR "overdue". */
  dueDate: string | null;
  createdAt: Date;
};

/** Active invoices for the org, newest first, with a display customer name. */
export async function listInvoices(
  db: TenantClient,
  organizationId: string,
): Promise<InvoiceListItem[]> {
  const rows = await db
    .select({
      id: invoices.id,
      status: invoices.status,
      number: invoices.number,
      snapshotName: invoices.customerName,
      liveName: customers.name,
      totalCents: invoices.totalCents,
      issueDate: invoices.issueDate,
      dueDate: invoices.dueDate,
      createdAt: invoices.createdAt,
    })
    .from(invoices)
    .leftJoin(
      customers,
      and(
        eq(invoices.customerId, customers.id),
        eq(customers.organizationId, organizationId),
      ),
    )
    .where(
      and(eq(invoices.organizationId, organizationId), isNull(invoices.deletedAt)),
    )
    .orderBy(desc(invoices.createdAt));

  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    number: r.number,
    customerName: r.snapshotName ?? r.liveName ?? null,
    totalCents: r.totalCents,
    issueDate: r.issueDate,
    dueDate: r.dueDate,
    createdAt: r.createdAt,
  }));
}

/**
 * Dashboard aggregate: lifetime AR/status summary computed in SQL instead of
 * fetching every invoice row (`listInvoices()` is intentionally unbounded and
 * wrong for this once history grows). Same semantics as the pure
 * `invoiceSummary()`: void is ignored, outstanding = issued totals, overdue =
 * issued past `today` (bare 'YYYY-MM-DD', lexicographic). Org-scoped,
 * soft-delete-aware.
 */
export async function summarizeInvoicesForDashboard(
  db: TenantClient,
  organizationId: string,
  today: string,
): Promise<InvoiceSummary> {
  const [row] = await db
    .select({
      outstanding: sql<string>`coalesce(sum(${invoices.totalCents}) filter (where ${invoices.status} = 'issued'), 0)`,
      overdue: sql<string>`coalesce(sum(${invoices.totalCents}) filter (where ${invoices.status} = 'issued' and ${invoices.dueDate} is not null and ${invoices.dueDate} < ${today}), 0)`,
      draftCount: sql<number>`count(*) filter (where ${invoices.status} = 'draft')::int`,
      issuedCount: sql<number>`count(*) filter (where ${invoices.status} = 'issued')::int`,
      paidCount: sql<number>`count(*) filter (where ${invoices.status} = 'paid')::int`,
    })
    .from(invoices)
    .where(
      and(eq(invoices.organizationId, organizationId), isNull(invoices.deletedAt)),
    );
  return {
    outstandingCents: toSafeCents(row?.outstanding, 'invoiceSummary.outstanding'),
    overdueCents: toSafeCents(row?.overdue, 'invoiceSummary.overdue'),
    draftCount: row?.draftCount ?? 0,
    issuedCount: row?.issuedCount ?? 0,
    paidCount: row?.paidCount ?? 0,
  };
}

export type InvoiceWithItems = {
  invoice: Invoice;
  items: InvoiceItem[];
};

export async function getInvoiceWithItems(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<InvoiceWithItems | null> {
  const invoiceRows = await db
    .select()
    .from(invoices)
    .where(
      and(
        eq(invoices.organizationId, organizationId),
        eq(invoices.id, id),
        isNull(invoices.deletedAt),
      ),
    )
    .limit(1);
  const invoice = invoiceRows[0];
  if (!invoice) return null;

  const items = await db
    .select()
    .from(invoiceItems)
    .where(
      and(
        eq(invoiceItems.organizationId, organizationId),
        eq(invoiceItems.invoiceId, id),
      ),
    )
    .orderBy(asc(invoiceItems.sortOrder));

  return { invoice, items };
}

/**
 * Batched detail loader for the draft invoices on the invoices page: two
 * org-scoped queries total (invoices + their items) instead of N+1 round-trips
 * via {@link getInvoiceWithItems}. Items are grouped per invoice in memory.
 */
export async function listDraftInvoiceDetails(
  db: TenantClient,
  organizationId: string,
  draftIds: string[],
): Promise<InvoiceWithItems[]> {
  if (draftIds.length === 0) return [];

  const invoiceRows = await db
    .select()
    .from(invoices)
    .where(
      and(
        eq(invoices.organizationId, organizationId),
        inArray(invoices.id, draftIds),
        isNull(invoices.deletedAt),
      ),
    );

  const itemRows = await db
    .select()
    .from(invoiceItems)
    .where(
      and(
        eq(invoiceItems.organizationId, organizationId),
        inArray(invoiceItems.invoiceId, draftIds),
      ),
    )
    .orderBy(asc(invoiceItems.sortOrder));

  const itemsByInvoice = new Map<string, InvoiceItem[]>();
  for (const item of itemRows) {
    const list = itemsByInvoice.get(item.invoiceId) ?? [];
    list.push(item);
    itemsByInvoice.set(item.invoiceId, list);
  }

  return invoiceRows.map((invoice) => ({
    invoice,
    items: itemsByInvoice.get(invoice.id) ?? [],
  }));
}

/** Maps validated line input to the cents/numeric shape the calc + DB expect. */
function toCalcLines(items: InvoiceItemInput[]) {
  return items.map((it) => ({
    quantity: it.quantity,
    unitPriceCents: it.unitPriceCents,
    taxRate: it.taxRate,
  }));
}

/** Inserts the invoice's line items (org-scoped, ordered). */
async function insertItems(
  db: TenantClient,
  organizationId: string,
  invoiceId: string,
  items: InvoiceItemInput[],
): Promise<void> {
  if (items.length === 0) return;
  await db.insert(invoiceItems).values(
    items.map((it, index) => ({
      organizationId,
      invoiceId,
      description: it.description,
      quantity: String(it.quantity),
      unitPriceCents: it.unitPriceCents,
      taxRate: String(it.taxRate),
      sortOrder: index,
    })),
  );
}

/**
 * Creates a DRAFT invoice with its line items; totals are computed and stored so
 * the list view shows an amount without re-joining items (re-frozen at issue).
 */
export async function createDraftInvoice(
  db: TenantClient,
  organizationId: string,
  input: InvoiceDraftInput,
): Promise<Invoice> {
  const totals = invoiceTotals(toCalcLines(input.items));
  const [invoice] = await db
    .insert(invoices)
    .values({
      organizationId,
      customerId: input.customerId,
      status: 'draft',
      notes: input.notes,
      subtotalCents: totals.subtotalCents,
      taxCents: totals.taxCents,
      totalCents: totals.totalCents,
    })
    .returning();
  if (!invoice) throw new Error('Failed to create invoice.');

  await insertItems(db, organizationId, invoice.id, input.items);
  return invoice;
}

/**
 * Replaces a DRAFT invoice's customer, notes and line items, recomputing totals.
 * Returns null if the invoice is missing or not a draft (issued+ are immutable).
 */
export async function updateDraftInvoice(
  db: TenantClient,
  organizationId: string,
  id: string,
  input: InvoiceDraftInput,
): Promise<Invoice | null> {
  const existing = await db
    .select({ status: invoices.status })
    .from(invoices)
    .where(
      and(
        eq(invoices.organizationId, organizationId),
        eq(invoices.id, id),
        isNull(invoices.deletedAt),
      ),
    )
    .limit(1);
  if (!existing[0] || existing[0].status !== 'draft') return null;

  const totals = invoiceTotals(toCalcLines(input.items));
  const [invoice] = await db
    .update(invoices)
    .set({
      customerId: input.customerId,
      notes: input.notes,
      subtotalCents: totals.subtotalCents,
      taxCents: totals.taxCents,
      totalCents: totals.totalCents,
    })
    .where(
      and(
        eq(invoices.organizationId, organizationId),
        eq(invoices.id, id),
        // Re-assert draft + not-trashed IN the UPDATE: the read above is not a
        // lock, so a concurrent issueInvoice/soft-delete could land between it
        // and this write. If that happens the predicate matches no row, we bail
        // out below WITHOUT wiping items — an issued invoice stays immutable.
        eq(invoices.status, 'draft'),
        isNull(invoices.deletedAt),
      ),
    )
    .returning();
  if (!invoice) return null;

  // Replace the lines wholesale (simplest correct update for a small set).
  await db
    .delete(invoiceItems)
    .where(
      and(
        eq(invoiceItems.organizationId, organizationId),
        eq(invoiceItems.invoiceId, id),
      ),
    );
  await insertItems(db, organizationId, id, input.items);
  return invoice;
}

export type IssueOutcome =
  | { status: 'ok'; invoice: Invoice }
  | { status: 'not_found' }
  | { status: 'no_customer' }
  | { status: 'empty' };

/**
 * Issues a DRAFT invoice: snapshots the linked (active) customer, freezes the
 * totals from the current line items, allocates a gap-free number and stamps the
 * issue date. Requires a linked customer and at least one line. Idempotency is
 * the caller's concern (status check below blocks a double-issue).
 */
export async function issueInvoice(
  db: TenantClient,
  organizationId: string,
  id: string,
  dueDate: string | null,
  now: Date = new Date(),
): Promise<IssueOutcome> {
  // Lock the invoice row FIRST. A concurrent issue of the SAME draft (double
  // click / retry) blocks here, then re-reads it as 'issued' below and bails out
  // BEFORE allocating a number — without this lock both callers pass the status
  // check and each burn a counter value, leaving a gap in the legally-required
  // gap-free sequential numbering (PT invoicing). Must run inside `withOrg`.
  const [locked] = await db
    .select({ status: invoices.status })
    .from(invoices)
    .where(and(eq(invoices.organizationId, organizationId), eq(invoices.id, id)))
    .for('update')
    .limit(1);
  if (!locked || locked.status !== 'draft') return { status: 'not_found' };

  const detail = await getInvoiceWithItems(db, organizationId, id);
  if (!detail || detail.invoice.status !== 'draft') return { status: 'not_found' };
  if (!detail.invoice.customerId) return { status: 'no_customer' };
  if (detail.items.length === 0) return { status: 'empty' };

  const customer = await db
    .select()
    .from(customers)
    .where(
      and(
        eq(customers.organizationId, organizationId),
        eq(customers.id, detail.invoice.customerId),
        isNull(customers.deletedAt),
      ),
    )
    .limit(1);
  if (!customer[0]) return { status: 'no_customer' };

  const totals = invoiceTotals(
    detail.items.map((it) => ({
      quantity: Number(it.quantity),
      unitPriceCents: it.unitPriceCents,
      taxRate: Number(it.taxRate),
    })),
  );

  const year = now.getUTCFullYear();
  const seq = await allocateInvoiceNumber(db, organizationId, year);
  const issueDate = now.toISOString().slice(0, 10);

  const [invoice] = await db
    .update(invoices)
    .set({
      status: 'issued',
      number: formatInvoiceNumber(year, seq),
      seq,
      year,
      issueDate,
      dueDate,
      customerName: customer[0].name,
      customerTaxId: customer[0].taxId,
      customerAddress: customer[0].address,
      customerEmail: customer[0].email,
      subtotalCents: totals.subtotalCents,
      taxCents: totals.taxCents,
      totalCents: totals.totalCents,
    })
    .where(
      and(
        eq(invoices.organizationId, organizationId),
        eq(invoices.id, id),
        // Re-assert draft in the predicate so a concurrent issue can't double-run.
        eq(invoices.status, 'draft'),
      ),
    )
    .returning();
  if (!invoice) return { status: 'not_found' };
  return { status: 'ok', invoice };
}

export type StatusOutcome = 'ok' | 'not_found';

/** Marks an ISSUED invoice paid. Returns 'not_found' if it was not issued. */
export async function markInvoicePaid(
  db: TenantClient,
  organizationId: string,
  id: string,
  now: Date = new Date(),
): Promise<StatusOutcome> {
  const [row] = await db
    .update(invoices)
    .set({ status: 'paid', paidAt: now })
    .where(
      and(
        eq(invoices.organizationId, organizationId),
        eq(invoices.id, id),
        eq(invoices.status, 'issued'),
        isNull(invoices.deletedAt),
      ),
    )
    .returning({ id: invoices.id });
  return row ? 'ok' : 'not_found';
}

/**
 * Voids an ISSUED or PAID invoice (the number survives as an audit record).
 * Returns 'not_found' if it was a draft or already void.
 */
export async function voidInvoice(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<StatusOutcome> {
  const [row] = await db
    .update(invoices)
    .set({ status: 'void' })
    .where(
      and(
        eq(invoices.organizationId, organizationId),
        eq(invoices.id, id),
        sql`${invoices.status} in ('issued', 'paid')`,
        isNull(invoices.deletedAt),
      ),
    )
    .returning({ id: invoices.id });
  return row ? 'ok' : 'not_found';
}

/**
 * Moves a DRAFT invoice to the trash. Only drafts are trashable (an issued number
 * must survive); returns null if the invoice is missing or not a draft.
 */
export async function softDeleteDraftInvoice(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<Invoice | null> {
  const [row] = await db
    .update(invoices)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(invoices.organizationId, organizationId),
        eq(invoices.id, id),
        eq(invoices.status, 'draft'),
        isNull(invoices.deletedAt),
      ),
    )
    .returning();
  return row ?? null;
}

/** Brings a trashed draft invoice back. Returns null if it was not in the trash. */
export async function restoreInvoice(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<Invoice | null> {
  const [row] = await db
    .update(invoices)
    .set({ deletedAt: null })
    .where(
      and(
        eq(invoices.organizationId, organizationId),
        eq(invoices.id, id),
        isNotNull(invoices.deletedAt),
      ),
    )
    .returning();
  return row ?? null;
}

/** Permanently deletes a trashed (draft) invoice; its line items cascade. */
export async function purgeInvoice(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<void> {
  await db
    .delete(invoices)
    .where(
      and(
        eq(invoices.organizationId, organizationId),
        eq(invoices.id, id),
        isNotNull(invoices.deletedAt),
      ),
    );
}

export async function listTrashedInvoices(
  db: TenantClient,
  organizationId: string,
): Promise<Invoice[]> {
  return db
    .select()
    .from(invoices)
    .where(
      and(eq(invoices.organizationId, organizationId), isNotNull(invoices.deletedAt)),
    )
    .orderBy(desc(invoices.deletedAt));
}
