'use client';

import { useRouter } from 'next/navigation';
import { ChevronDown } from 'lucide-react';

export function DashboardPeriodSelect({
  value,
  options,
}: {
  value: string;
  options: { key: string; label: string }[];
}) {
  const router = useRouter();

  return (
    <div className="relative inline-flex items-center">
      <select
        value={value}
        onChange={(e) => router.push(`/dashboard?period=${e.target.value}`)}
        className="appearance-none cursor-pointer rounded-lg border border-border bg-surface py-1.5 pl-3 pr-8 text-sm font-medium text-foreground transition-colors hover:bg-surface-2 focus:outline-none focus:ring-2 focus:ring-accent-500"
        aria-label="Select period"
      >
        {options.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 size-3.5 text-muted-foreground" />
    </div>
  );
}
