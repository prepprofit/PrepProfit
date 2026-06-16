import { getTranslations } from 'next-intl/server';
import { canAccessFinancials, getOrgId, getUserRole } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { listTrashedRecipes } from '@/lib/data/recipes';
import { listTrashedIngredients } from '@/lib/data/ingredients';
import { listTrashedTransactions } from '@/lib/data/transactions';
import { getOrgSettings } from '@/lib/data/org-settings';
import { formatMoney } from '@/lib/format/money';
import { daysLeft } from '@/lib/trash';
import { TrashView } from '@/components/app/trash/trash-view';

export default async function TrashPage() {
  const t = await getTranslations('trash');
  const organizationId = await getOrgId();
  const canSeeFinance = canAccessFinancials(await getUserRole());

  const [recipes, ingredients, transactions, settings] = await Promise.all([
    withOrg(organizationId, (tx) => listTrashedRecipes(tx, organizationId)),
    withOrg(organizationId, (tx) => listTrashedIngredients(tx, organizationId)),
    // Transactions are financial data — only managers see them in the trash too.
    canSeeFinance
      ? withOrg(organizationId, (tx) => listTrashedTransactions(tx, organizationId))
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

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      <TrashView
        recipes={recipes.map(toItem)}
        ingredients={ingredients.map(toItem)}
        transactions={transactions.map(toTransactionItem)}
      />
    </div>
  );
}
