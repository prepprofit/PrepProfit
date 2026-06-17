'use client';

import { useRouter } from 'next/navigation';
import { Select } from '@/components/ui/select';

export function DashboardPeriodSelect({
  value,
  options,
}: {
  value: string;
  options: { key: string; label: string }[];
}) {
  const router = useRouter();

  return (
    <div className="w-44">
      <Select
        value={value}
        onChange={(e) => router.push(`/dashboard?period=${e.target.value}`)}
        className="h-9"
        aria-label="Select period"
      >
        {options.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label}
          </option>
        ))}
      </Select>
    </div>
  );
}
