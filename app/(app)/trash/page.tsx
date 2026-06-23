import { getTranslations } from 'next-intl/server';
import { canAccessFinancials, getOrgId, getUserRole } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { listTrashedRecipes } from '@/lib/data/recipes';
import { listTrashedMenus } from '@/lib/data/menus';
import { listTrashedProductions } from '@/lib/data/productions';
import { listTrashedIngredients } from '@/lib/data/ingredients';
import { listTrashedTransactions } from '@/lib/data/transactions';
import { listTrashedCustomers } from '@/lib/data/customers';
import { listTrashedInvoices } from '@/lib/data/invoices';
import { getOrgSettings } from '@/lib/data/org-settings';
import { formatMoney } from '@/lib/format/money';
import { daysLeft } from '@/lib/trash';
import { NoAccess } from '@/components/app/no-access';
import { TrashView } from '@/components/app/trash/trash-view';

export default async function TrashPage() {
  // Manager-only: the trash exposes financial records (transactions, customers,
  // invoices) and destructive purges with financial side-effects. Enforced again
  // on every restore/purge action.
  if (!canAccessFinancials(await getUserRole())) return <NoAccess />;

  const t = await getTranslations('trash');
  const organizationId = await getOrgId();

  const [
    recipes,
    menus,
    productions,
    ingredients,
    transactions,
    customers,
    invoices,
    settings,
  ] = await Promise.all([
    withOrg(organizationId, (tx) => listTrashedRecipes(tx, organizationId)),
    withOrg(organizationId, (tx) => listTrashedMenus(tx, organizationId)),
    withOrg(organizationId, (tx) => listTrashedProductions(tx, organizationId)),
    withOrg(organizationId, (tx) => listTrashedIngredients(tx, organizationId)),
    withOrg(organizationId, (tx) => listTrashedTransactions(tx, organizationId)),
    withOrg(organizationId, (tx) => listTrashedCustomers(tx, organizationId)),
    withOrg(organizationId, (tx) => listTrashedInvoices(tx, organizationId)),
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
  const toProductionItem = (r: {
    id: string;
    reference: string | null;
    plannedFor: string | null;
    deletedAt: Date | null;
  }) => ({
    id: r.id,
    name: r.reference ?? r.plannedFor ?? t('sections.productions'),
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
        menus={menus.map(toItem)}
        productions={productions.map(toProductionItem)}
        ingredients={ingredients.map(toItem)}
        transactions={transactions.map(toTransactionItem)}
        customers={customers.map(toItem)}
        invoices={invoices.map(toInvoiceItem)}
      />
    </div>
  );
}
