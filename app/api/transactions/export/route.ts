import { NextResponse } from 'next/server';
import { getOrgId, isManager } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { listTransactions, type TransactionFilter } from '@/lib/data/transactions';
import { transactionsToCsv } from '@/lib/finance/csv';
import { transactionExportFilterSchema } from '@/lib/validation/transactions';

// neon-serverless Pool needs Node; force-dynamic so the download is never cached.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * CSV export of the org's transactions — the one justified API route (a file
 * download). Manager-only and org-scoped (RULE #1). Honours the same filters as
 * the list view (from/to/type/category query params) so the export reconciles
 * with what the user sees. Stable machine format (mirrors the import template).
 */
export async function GET(req: Request): Promise<NextResponse> {
  if (!(await isManager())) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const organizationId = await getOrgId();
  const { searchParams } = new URL(req.url);

  // Validate the filters server-side (RULE: Zod on all user input). Empty params
  // collapse to undefined so they're simply ignored; malformed ones (impossible
  // dates, bad type) are rejected with 400 instead of silently mis-querying.
  const parsed = transactionExportFilterSchema.safeParse({
    from: searchParams.get('from') || undefined,
    to: searchParams.get('to') || undefined,
    type: searchParams.get('type') || undefined,
    category: searchParams.get('category') || undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid filter' }, { status: 400 });
  }

  const filter: TransactionFilter = {};
  if (parsed.data.from) filter.from = parsed.data.from;
  if (parsed.data.to) filter.to = parsed.data.to;
  if (parsed.data.type) filter.type = parsed.data.type;
  if (parsed.data.category) filter.categoryId = parsed.data.category;

  const items = await withOrg(organizationId, (tx) =>
    listTransactions(tx, organizationId, filter),
  );

  const csv = transactionsToCsv(
    items.map((t) => ({
      occurredOn: t.occurredOn,
      type: t.type,
      categoryName: t.category.name,
      recipeName: t.recipe?.name ?? null,
      amountCents: t.amountCents,
      note: t.note,
    })),
  );

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="transactions.csv"',
      'Cache-Control': 'no-store',
    },
  });
}
