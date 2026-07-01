import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { FileText } from 'lucide-react';
import { canAccessFinancials, getOrgId, getUserRole } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { listSuppliersWithCounts } from '@/lib/data/suppliers';
import { NoAccess } from '@/components/app/no-access';
import { SuppliersView } from '@/components/app/suppliers/suppliers-view';
import { Button } from '@/components/ui/button';

/**
 * Suppliers (module 11, Sprint 7). MANAGER-ONLY: kitchen gets NoAccess here AND is
 * blocked in every action. Lists active + archived suppliers (the view toggles
 * archived) with their ingredient-link counts; create / edit / archive / reactivate
 * happen through manager-only Server Actions.
 */
export default async function SuppliersPage({
  searchParams,
}: {
  searchParams: Promise<{ highlight?: string }>;
}) {
  if (!canAccessFinancials(await getUserRole())) return <NoAccess />;

  const t = await getTranslations('suppliers');
  const tInv = await getTranslations('suppliers.invoices');
  const organizationId = await getOrgId();
  const { highlight } = await searchParams;

  const suppliers = await withOrg(organizationId, (tx) =>
    listSuppliersWithCounts(tx, organizationId, true),
  );

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface-2/40 p-4">
        <div className="flex flex-col">
          <span className="text-sm font-medium text-foreground">{tInv('cardTitle')}</span>
          <span className="text-xs text-muted-foreground">{tInv('cardBody')}</span>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href="/suppliers/invoices/import">
            <FileText className="size-4" />
            {tInv('open')}
          </Link>
        </Button>
      </div>
      <SuppliersView
        suppliers={suppliers.map((s) => ({
          id: s.id,
          name: s.name,
          email: s.email,
          phone: s.phone,
          address: s.address,
          taxId: s.taxId,
          notes: s.notes,
          active: s.active,
          ingredientCount: s.ingredientCount,
        }))}
        highlightId={typeof highlight === 'string' ? highlight : undefined}
      />
    </div>
  );
}
