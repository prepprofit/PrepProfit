import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ArrowLeft } from 'lucide-react';
import { canAccessFinancials, getOrgId, getUserRole } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { getSupplierById } from '@/lib/data/suppliers';
import { listIngredientsForSupplier } from '@/lib/data/ingredient-suppliers';
import { getOrgSettings } from '@/lib/data/org-settings';
import { formatMoney } from '@/lib/format/money';
import { unitLabel, type Unit } from '@/lib/units';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { NoAccess } from '@/components/app/no-access';

/**
 * Supplier detail (Sprint 7). MANAGER-ONLY. Shows the supplier's contact details +
 * the active ingredients it supplies, with each link's pack. Read-only — editing
 * the supplier happens on the list; ingredient packs are edited from the ingredient.
 */
export default async function SupplierDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  if (!canAccessFinancials(await getUserRole())) return <NoAccess />;

  const { id } = await params;
  const t = await getTranslations('suppliers');
  const organizationId = await getOrgId();

  const [data, settings] = await Promise.all([
    withOrg(organizationId, async (tx) => ({
      supplier: await getSupplierById(tx, organizationId, id),
      ingredients: await listIngredientsForSupplier(tx, organizationId, id),
    })),
    getOrgSettings(),
  ]);

  if (!data.supplier) notFound();
  const { supplier, ingredients } = data;

  const formatPack = (
    packSize: number | null,
    packUnit: string | null,
    packPriceCents: number | null,
  ): string => {
    if (packSize == null || packUnit == null) return t('detail.noPack');
    const label = unitLabel(packUnit as Unit) || packUnit;
    const size = `${packSize} ${label}`.trim();
    return packPriceCents != null
      ? `${size} · ${formatMoney(packPriceCents, settings.currency)}`
      : size;
  };

  const contactRows: { label: string; value: string }[] = [
    supplier.email ? { label: t('form.email'), value: supplier.email } : null,
    supplier.phone ? { label: t('form.phone'), value: supplier.phone } : null,
    supplier.address ? { label: t('form.address'), value: supplier.address } : null,
    supplier.taxId ? { label: t('form.taxId'), value: supplier.taxId } : null,
  ].filter((r): r is { label: string; value: string } => r !== null);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <Link
          href="/suppliers"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          {t('detail.back')}
        </Link>
        {!supplier.active && <Badge variant="neutral">{t('archivedBadge')}</Badge>}
      </div>

      <div>
        <h2 className="font-display text-2xl font-semibold text-foreground">
          {supplier.name}
        </h2>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t('detail.contactHeading')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {contactRows.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('detail.noContact')}</p>
            ) : (
              <dl className="flex flex-col gap-2 text-sm">
                {contactRows.map((r) => (
                  <div key={r.label} className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">{r.label}</dt>
                    <dd className="text-right text-foreground">{r.value}</dd>
                  </div>
                ))}
              </dl>
            )}
            {supplier.notes && (
              <div className="mt-2 border-t border-border pt-2">
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  {t('detail.notesHeading')}
                </p>
                <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">
                  {supplier.notes}
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('detail.ingredientsHeading')}</CardTitle>
          </CardHeader>
          <CardContent>
            {ingredients.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t('detail.noIngredients')}
              </p>
            ) : (
              <ul className="flex flex-col divide-y divide-border">
                {ingredients.map((ing) => (
                  <li
                    key={ing.ingredientId}
                    className="flex items-center justify-between gap-3 py-2"
                  >
                    <Link
                      href={`/ingredients?highlight=${ing.ingredientId}`}
                      className="text-sm font-medium text-foreground hover:text-accent-700 hover:underline dark:hover:text-accent-300"
                    >
                      {ing.ingredientName}
                    </Link>
                    <span className="text-sm text-muted-foreground">
                      {formatPack(ing.packSize, ing.packUnit, ing.packPriceCents)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
