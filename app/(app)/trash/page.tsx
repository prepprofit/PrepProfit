import { getTranslations } from 'next-intl/server';
import { canAccessFinancials, getOrgId, getUserRole } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { listTrashedRecipes } from '@/lib/data/recipes';
import { listTrashedIngredients } from '@/lib/data/ingredients';
import { listTrashedTransactions } from '@/lib/data/transactions';
import { listTrashedCustomers } from '@/lib/data/customers';
import { listTrashedInvoices } from '@/lib/data/invoices';
import { getOrgSettings } from '@/lib/data/org-settings';
import { formatMoney } from '@/lib/format/money';
import { daysLeft } from '@/lib/trash';
import { TrashView } from '@/components/app/trash/trash-view';

export default async function TrashPage() {
  const t = await getTranslations('trash');
  const organizationId = await getOrgId();
  const canSeeFinance = canAccessFinancials(await getUserRole());

  const [recipes, ingredients, transactions, customers, invoices, settings] =
    await Promise.all([
      withOrg(organizationId, (tx) => listTrashedRecipes(tx, organizationId)),
      withOrg(organizationId, (tx) => listTrashedIngredients(tx, organizationId)),
      // Financial data — only managers see these in the trash too.
      canSeeFinance
        ? withOrg(organizationId, (tx) =>
            listTrashedTransactions(tx, organizationId),
          )
        : Promise.resolve([]),
      canSeeFinance
        ? withOrg(organizationId, (tx) => listTrashedCustomers(tx, organizationId))
        : Promise.resolve([]),
      canSeeFinance
        ? withOrg(organizationId, (tx) => listTrashedInvoices(tx, organizationId))
        : Promise.resolve([]),
      getOrgSettings(),
    ]);

  // Compute "days left" on the server so the client gets a plain, lean shape.
  const now = new Date();
  const toItem = (r: { id: string; name: string; deletedAt: Date | null }) => ({
    id: r.id,
    name: r.name,
    daysLeft: r.deletedAt ? daysLeft(r.deletedAt, now) : 0,
  });
  const toTransactionItem = (r: {
    id: string;
    amountCents: number;
    occurredOn: string;
    deletedAt: Date | null;
  }) => ({
    id: r.id,
    name: `${formatMoney(r.amountCents, settings.currency)} · ${r.occurredOn}`,
    daysLeft: r.deletedAt ? daysLeft(r.deletedAt, now) : 0,
  });
  const toInvoiceItem = (r: {
    id: string;
    number: string | null;
    customerName: string | null;
    totalCents: number;
    deletedAt: Date | null;
  }) => ({
    id: r.id,
    name: `${r.number ?? r.customerName ?? t('sections.invoices')} · ${formatMoney(
      r.totalCents,
      settings.currency,
    )}`,
    daysLeft: r.deletedAt ? daysLeft(r.deletedAt, now) : 0,
  });

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      <TrashView
        recipes={recipes.map(toItem)}
        ingredients={ingredients.map(toItem)}
        transactions={transactions.map(toTransactionItem)}
        customers={customers.map(toItem)}
        invoices={invoices.map(toInvoiceItem)}
      />
    </div>
  );
}
