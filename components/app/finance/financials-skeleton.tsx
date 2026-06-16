import { Card } from '@/components/ui/card';

/**
 * Design-matched skeleton for the financials data (the heavier query). Mirrors
 * the real layout — three KPI cards over two panels — so the shift on load is
 * minimal. Shown via the page's Suspense boundary only; there is no blanket
 * route loading fallback (removed in Sprint 1.7).
 */
export function FinancialsSkeleton() {
  return (
    <div className="flex animate-pulse flex-col gap-4" aria-hidden>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Card key={i} className="flex flex-col gap-3 p-5">
            <div className="h-4 w-24 rounded bg-surface-2" />
            <div className="h-8 w-32 rounded bg-surface-2" />
            <div className="h-3 w-20 rounded bg-surface-2" />
          </Card>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {[0, 1].map((i) => (
          <Card key={i} className="flex flex-col gap-4 p-5">
            <div className="h-4 w-28 rounded bg-surface-2" />
            <div className="h-40 w-full rounded bg-surface-2" />
          </Card>
        ))}
      </div>
    </div>
  );
}
