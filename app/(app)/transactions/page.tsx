import { getTranslations } from 'next-intl/server';
import { getOrgId, canAccessFinancials, getUserRole } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { getOrgSettings } from '@/lib/data/org-settings';
import { listTransactions, type TransactionFilter } from '@/lib/data/transactions';
import { listCategories } from '@/lib/data/transaction-categories';
import { ensureCategoriesSeeded } from '@/lib/data/transaction-categories';
import { listRecipes } from '@/lib/data/recipes';
import { categoryLabel } from '@/lib/finance/categories';
import { NoAccess } from '@/components/app/no-access';
import { TransactionsView } from '@/components/app/finance/transactions-view';

const isDate = (v: unknown): v is string =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

/**
 * Financials — the income/expense ledger. Manager-only (the kitchen role gets
 * NoAccess here AND is blocked in every action). Filters come from the URL so
 * the list, the CSV export, and a shared link all agree.
 */
export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!canAccessFinancials(await getUserRole())) return <NoAccess />;

  const t = await getTranslations('finance.transactions');
  const tCat = await getTranslations('finance.categories');
  const organizationId = await getOrgId();
  const sp = await searchParams;

  const typeParam =
    sp.type === 'income' || sp.type === 'expense' ? sp.type : undefined;
  const fromParam = isDate(sp.from) ? sp.from : undefined;
  const toParam = isDate(sp.to) ? sp.to : undefined;
  const categoryParam =
    typeof sp.category === 'string' && sp.category ? sp.category : undefined;
  const highlightId = typeof sp.highlight === 'string' ? sp.highlight : undefined;

  const filter: TransactionFilter = {
    type: typeParam,
    from: fromParam,
    to: toParam,
    categoryId: categoryParam,
  };

  const [data, settings] = await Promise.all([
    withOrg(organizationId, async (tx) => {
      await ensureCategoriesSeeded(tx, organizationId);
      const categories = await listCategories(tx, organizationId);
      const recipes = await listRecipes(tx, organizationId);
      const transactions = await listTransactions(tx, organizationId, filter);
      return { categories, recipes, transactions };
    }),
    getOrgSettings(),
  ]);

  const label = (c: { slug: string | null; name: string }) =>
    categoryLabel(c, (slug) => tCat(slug));

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      <TransactionsView
        currency={settings.currency}
        categories={data.categories.map((c) => ({
          id: c.id,
          kind: c.kind,
          label: label(c),
        }))}
        recipes={data.recipes.map((r) => ({ id: r.id, name: r.name }))}
        rows={data.transactions.map((tr) => ({
          id: tr.id,
          type: tr.type,
          occurredOn: tr.occurredOn,
          amountCents: tr.amountCents,
          note: tr.note,
          categoryId: tr.category.id,
          categoryLabel: label(tr.category),
          recipeId: tr.recipe?.id ?? null,
          recipeName: tr.recipe?.name ?? null,
        }))}
        filter={{
          type: typeParam ?? '',
          from: fromParam ?? '',
          to: toParam ?? '',
          category: categoryParam ?? '',
        }}
        highlightId={highlightId}
      />
    </div>
  );
}
