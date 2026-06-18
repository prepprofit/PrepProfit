import { getTranslations } from 'next-intl/server';
import { canAccessFinancials, getOrgId, getUserRole } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { getOrgSettings } from '@/lib/data/org-settings';
import { listCustomers } from '@/lib/data/customers';
import { listDraftInvoiceDetails, listInvoices } from '@/lib/data/invoices';
import { centsToAmountInput } from '@/lib/format/money';
import { NoAccess } from '@/components/app/no-access';
import {
  InvoicesView,
  type DraftDetail,
} from '@/components/app/invoices/invoices-view';

/**
 * Invoicing (module 6). Manager-only: the kitchen role gets NoAccess here AND is
 * blocked in every action. Builds the on-screen invoice list + builder; drafts'
 * line items are loaded so the builder can edit them in place (drafts are few).
 */
export default async function InvoicesPage() {
  if (!canAccessFinancials(await getUserRole())) return <NoAccess />;

  const t = await getTranslations('invoices');
  const organizationId = await getOrgId();

  const [data, settings] = await Promise.all([
    withOrg(organizationId, async (tx) => {
      const customers = await listCustomers(tx, organizationId);
      const invoices = await listInvoices(tx, organizationId);
      const draftIds = invoices
        .filter((i) => i.status === 'draft')
        .map((i) => i.id);
      const draftDetails = await listDraftInvoiceDetails(
        tx,
        organizationId,
        draftIds,
      );
      return { customers, invoices, draftDetails };
    }),
    getOrgSettings(),
  ]);

  const drafts: Record<string, DraftDetail> = {};
  for (const detail of data.draftDetails) {
    drafts[detail.invoice.id] = {
      id: detail.invoice.id,
      customerId: detail.invoice.customerId ?? '',
      notes: detail.invoice.notes ?? '',
      lines: detail.items.map((it) => ({
        description: it.description,
        quantity: String(Number(it.quantity)),
        unitPrice: centsToAmountInput(it.unitPriceCents),
        taxRate: String(Number(it.taxRate)),
      })),
    };
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      <InvoicesView
        currency={settings.currency}
        customers={data.customers.map((c) => ({
          id: c.id,
          name: c.name,
          taxId: c.taxId,
          address: c.address,
          email: c.email,
        }))}
        invoices={data.invoices.map((i) => ({
          id: i.id,
          status: i.status,
          number: i.number,
          customerName: i.customerName,
          totalCents: i.totalCents,
          issueDate: i.issueDate,
        }))}
        drafts={drafts}
      />
    </div>
  );
}
