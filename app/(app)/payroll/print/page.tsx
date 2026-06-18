import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ArrowLeft } from 'lucide-react';
import { canAccessFinancials, getUserRole } from '@/lib/auth';
import { isValidAnchor, todayAnchor, type PayrollView } from '@/lib/payroll/period';
import { loadPayrollDocument } from '@/lib/documents/payroll-loader';
import { buildPayrollLabels } from '@/lib/documents/payroll-labels';
import { formatHours } from '@/lib/documents/payroll-data';
import { formatMoney } from '@/lib/documents/format';
import { Button } from '@/components/ui/button';
import { NoAccess } from '@/components/app/no-access';
import { PrintButton } from '@/components/app/invoices/print-button';
import { PrintLogo } from '@/components/app/invoices/print-logo';

// Always render fresh; manager-only sensitive payroll document.
export const dynamic = 'force-dynamic';

/**
 * Print-friendly payroll period summary (Sprint 3.5B). Manager-only — the role is
 * checked BEFORE any data access (kitchen gets NoAccess). Reuses the SAME
 * `loadPayrollDocument` as the PDF route so the printed summary reconciles with
 * `/payroll`.
 */
export default async function PayrollPrintPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!canAccessFinancials(await getUserRole())) return <NoAccess />;

  const sp = await searchParams;
  const view: PayrollView = sp.view === 'week' ? 'week' : 'month';
  const anchor =
    typeof sp.d === 'string' && isValidAnchor(sp.d) ? sp.d : todayAnchor();

  const [t, tDoc] = await Promise.all([
    getTranslations('payrollDocument'),
    getTranslations('reports.print'),
  ]);
  const data = await loadPayrollDocument({ view, anchor });
  const labels = buildPayrollLabels((k) => t(k));
  const money = (cents: number) => formatMoney(cents, data.currency);
  const { seller } = data;
  const backHref = `/payroll?view=${view}&d=${anchor}`;

  return (
    <>
      <style>{`@media print {
        body * { visibility: hidden !important; }
        #payroll-print, #payroll-print * { visibility: visible !important; }
        #payroll-print { position: absolute; left: 0; top: 0; width: 100%; }
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
              <a href={`/api/payroll/summary/pdf?view=${view}&d=${anchor}`}>
                {tDoc('downloadPdf')}
              </a>
            </Button>
            <Button asChild variant="outline" size="sm">
              <a href={`/api/payroll/summary/xlsx?view=${view}&d=${anchor}`}>
                {tDoc('downloadXlsx')}
              </a>
            </Button>
            <PrintButton label={tDoc('print')} />
          </div>
        </div>

        <div
          id="payroll-print"
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

          <table className="mt-8 w-full">
            <thead>
              <tr className="border-b border-neutral-800 text-xs uppercase tracking-wide text-neutral-500">
                <th className="py-2 pr-3 text-left font-semibold">{labels.employee}</th>
                <th className="py-2 px-3 text-right font-semibold">{labels.shifts}</th>
                <th className="py-2 px-3 text-right font-semibold">{labels.hours}</th>
                <th className="py-2 pl-3 text-right font-semibold">{labels.pay}</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-3 text-neutral-500">
                    {labels.empty}
                  </td>
                </tr>
              ) : (
                <>
                  {data.rows.map((r, i) => (
                    <tr key={i} className="border-b border-neutral-200">
                      <td className="py-2 pr-3 text-neutral-800">{r.name}</td>
                      <td className="py-2 px-3 text-right text-neutral-600">
                        {r.shiftCount}
                      </td>
                      <td className="py-2 px-3 text-right text-neutral-600">
                        {formatHours(r.workedMinutes)}
                      </td>
                      <td className="py-2 pl-3 text-right font-medium text-neutral-900">
                        {money(r.payDueCents)}
                      </td>
                    </tr>
                  ))}
                  <tr className="border-t border-neutral-800 font-bold text-neutral-900">
                    <td className="py-2 pr-3">{labels.total}</td>
                    <td className="py-2 px-3 text-right">{data.totalShiftCount}</td>
                    <td className="py-2 px-3 text-right">
                      {formatHours(data.totalWorkedMinutes)}
                    </td>
                    <td className="py-2 pl-3 text-right">{money(data.totalPayCents)}</td>
                  </tr>
                </>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
