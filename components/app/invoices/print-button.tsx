'use client';

import { Button } from '@/components/ui/button';
import { Printer } from 'lucide-react';

/**
 * Triggers the browser print dialog for the invoice print view. Client-only (it
 * calls `window.print()`); hidden from the printed output via `print:hidden` on
 * its toolbar wrapper.
 */
export function PrintButton({ label }: { label: string }) {
  return (
    <Button type="button" size="sm" onClick={() => window.print()}>
      <Printer className="size-4" />
      {label}
    </Button>
  );
}
