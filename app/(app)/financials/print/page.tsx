import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ArrowLeft } from 'lucide-react';
import { canAccessFinancials, getUserRole } from '@/lib/auth';
import { requireDocumentAccess } from '@/lib/entitlements';
import {
  currentPeriodKey,
  isValidPeriodKey,
  type PeriodView,
} from '@/lib/finance/period';
import { loadPlDocument } from '@/lib/documents/pl-loader';
import { buildPlLabels } from '@/lib/documents/pl-labels';
import { formatMoney } from '@/lib/documents/format';
import { Button } from '@/components/ui/button';
import { NoAccess } from '@/components/app/no-access';
import { UpgradeRequired } from '@/components/app/upgrade-required';
import { PrintButton } from '@/components/app/invoices/print-button';
import { PrintLogo } from '@/components/app/invoices/print-logo';
import { SendDocumentDialog } from '@/components/app/send-document-dialog';

// Always render fresh; manager-only sensitive financial document.
export const dynamic = 'force-dynamic';

/**
 * Print-friendly P&L view (Sprint 3.5B). Manager-only — the role is checked BEFORE
 * any data access (kitchen gets NoAccess). Reuses the SAME `loadPlDocument` as the
 * PDF route so the printed statement reconciles with `/financials`.
 */
export default async function PlPrintPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!canAccessFinancials(await getUserRole())) return <NoAccess />;
  // Advanced-document gate via the entitlement matrix (audit F-08).
  if (await requireDocumentAccess('financials_print')) return <UpgradeRequired />;

  const sp = await searchParams;
  const view: PeriodView = sp.view === 'year' ? 'year' : 'month';
  const periodKey =
    typeof sp.period === 'string' && isValidPeriodKey(view, sp.period)
      ? sp.period
      : currentPeriodKey(view);

  const [t, tCat, tDoc] = await Promise.all([
    getTranslations('plDocument'),
    getTranslations('finance.categories'),
    getTranslations('reports.print'),
  ]);
  const data = await loadPlDocument({ view, periodKey, tCat: (s) => tCat(s) });
  const labels = buildPlLabels((k) => t(k));
  const money = (cents: number) => formatMoney(cents, data.currency);
  const { seller } = data;
  const backHref = `/financials?view=${view}&period=${periodKey}`;

  return (
    <>
      <style>{`@media print {
        body * { visibility: hidden !important; }
        #pl-print, #pl-print * { visibility: visible !important; }
        #pl-print { position: absolute; left: 0; top: 0; width: 100%; }
      }`}</style>

      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <div className="flex items-center justify-between gap-3 print:hidden">
          <Button asChild variant="ghost" size="sm">
            <Link href={backHref}>
              <ArrowLeft className="size-4" />
              {tDoc('back')}
            </Link>
          </Button>
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <a href={`/api/financials/pl/pdf?view=${view}&period=${periodKey}`}>
                {tDoc('downloadPdf')}
              </a>
            </Button>
            <Button asChild variant="outline" size="sm">
              <a href={`/api/financials/pl/xlsx?view=${view}&period=${periodKey}`}>
                {tDoc('downloadXlsx')}
              </a>
            </Button>
            <PrintButton label={tDoc('print')} />
            <SendDocumentDialog doc={{ documentType: 'pl', view, period: periodKey }} />
          </div>
        </div>

        <div
          id="pl-print"
          className="rounded-lg border border-border bg-white p-10 text-sm text-neutral-800 shadow-sm print:rounded-none print:border-0 print:shadow-none"
        >
          <div className="flex items-start justify-between gap-6">
            <div className="flex flex-col gap-0.5">
              {seller.logoUrl && <PrintLogo src={seller.logoUrl} alt={seller.name} />}
              {seller.name !== '' && (
                <span className="text-base font-semibold text-neutral-900">
                  {seller.name}
                </span>
              )}
            </div>
            <div className="flex flex-col items-end gap-0.5">
              <span className="text-xl font-bold tracking-wide text-[#c2410c]">
                {labels.title}
              </span>
              <span className="font-semibold text-neutral-900">
                {data.periodLabel}
              </span>
            </div>
          </div>

          {/* Summary */}
          <div className="mt-8 grid grid-cols-3 gap-3">
            {[
              { label: labels.income, value: data.incomeCents, loss: false },
              { label: labels.expenses, value: data.expenseCents, loss: false },
              {
                label: labels.profit,
                value: data.profitCents,
                loss: data.profitCents < 0,
              },
            ].map((c) => (
              <div key={c.label} className="rounded border border-neutral-200 p-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                  {c.label}
                </div>
                <div
                  className={`text-lg font-bold ${c.loss ? 'text-red-700' : 'text-neutral-900'}`}
                >
                  {money(c.value)}
                </div>
              </div>
            ))}
          </div>

          {/* By category */}
          <PrintTable
            title={labels.byCategory}
            head={[labels.category, labels.amount]}
            rows={data.byCategory.map((c) => [c.name, money(c.totalCents)])}
            empty={labels.empty}
          />

          {/* Top products */}
          <PrintTable
            title={labels.topProducts}
            head={[labels.product, labels.amount]}
            rows={data.topProducts.map((p) => [p.name, money(p.totalCents)])}
            empty={labels.empty}
          />

          {/* Monthly (year view) */}
          {data.monthly && (
            <PrintTable
              title={labels.monthly}
              head={[labels.month, labels.income, labels.expenses, labels.profit]}
              rows={data.monthly.map((m) => [
                m.label,
                money(m.incomeCents),
                money(m.expenseCents),
                money(m.profitCents),
              ])}
              empty={labels.empty}
            />
          )}
        </div>
      </div>
    </>
  );
}

function PrintTable({
  title,
  head,
  rows,
  empty,
}: {
  title: string;
  head: string[];
  rows: string[][];
  empty: string;
}) {
  return (
    <div className="mt-8">
      <h2 className="mb-2 text-sm font-semibold text-neutral-900">{title}</h2>
      <table className="w-full">
        <thead>
          <tr className="border-b border-neutral-800 text-xs uppercase tracking-wide text-neutral-500">
            {head.map((h, i) => (
              <th
                key={i}
                className={`py-2 font-semibold ${i === 0 ? 'pr-3 text-left' : 'px-3 text-right'}`}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={head.length} className="py-2 text-neutral-500">
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((r, ri) => (
              <tr key={ri} className="border-b border-neutral-200">
                {r.map((cell, ci) => (
                  <td
                    key={ci}
                    className={`py-2 ${ci === 0 ? 'pr-3 text-neutral-800' : 'px-3 text-right text-neutral-600'}`}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
