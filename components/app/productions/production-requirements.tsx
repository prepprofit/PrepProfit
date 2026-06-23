import { getTranslations } from 'next-intl/server';
import { AlertTriangle, Info } from 'lucide-react';
import type { ProductionExplosionView } from '@/lib/data/productions';
import type { MeasurementSystem } from '@/lib/db/schema';
import { formatQuantity } from '@/lib/units';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Money-free mise-en-place view (Sprint 11a), shared by both roles. A COMPLETE
 * explosion shows needed / on-hand / shortfall per ingredient with the "calculated
 * at" + "not reserved" copy (shortfall is an advisory, never a reservation). An
 * INCOMPLETE explosion shows a clearly-labelled partial preview (needed only, no
 * shortfall, no "order N" callout) and a blocking warning — it is never presented as
 * a final order list.
 */
export async function ProductionRequirements({
  explosion,
  system,
}: {
  explosion: ProductionExplosionView;
  system: MeasurementSystem;
}) {
  const t = await getTranslations('productions');

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('requirements.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!explosion.complete && (
          <p
            role="status"
            className="inline-flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300"
          >
            <AlertTriangle className="size-4 shrink-0" />
            {explosion.incompleteReason === 'overflow'
              ? t('incomplete.overflow')
              : t('incomplete.managerBody')}
          </p>
        )}

        {explosion.complete && explosion.requirements.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {t('requirements.empty')}
          </p>
        )}

        {explosion.complete && explosion.requirements.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  <th className="pb-2">{t('requirements.ingredient')}</th>
                  <th className="pb-2 text-right">{t('requirements.needed')}</th>
                  <th className="pb-2 text-right">{t('requirements.onHand')}</th>
                  <th className="pb-2 text-right">{t('requirements.shortfall')}</th>
                </tr>
              </thead>
              <tbody>
                {explosion.requirements.map((req) => (
                  <tr
                    key={req.ingredientId}
                    className="border-b border-border last:border-0"
                  >
                    <td className="py-2 pr-2 font-medium text-foreground">
                      {req.ingredientName}
                    </td>
                    <td className="py-2 pr-2 text-right tabular-nums text-foreground">
                      {formatQuantity(req.neededCanonical, req.dimension, system)}
                    </td>
                    <td className="py-2 pr-2 text-right tabular-nums text-muted-foreground">
                      {formatQuantity(req.onHandCanonical, req.dimension, system)}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {req.shortfallCanonical > 0 ? (
                        <span className="font-medium text-red-600 dark:text-red-400">
                          {formatQuantity(
                            req.shortfallCanonical,
                            req.dimension,
                            system,
                          )}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!explosion.complete && explosion.partialRequirements.length > 0 && (
          <div className="flex flex-col gap-2">
            <Badge variant="neutral" className="self-start">
              {t('incomplete.preview')}
            </Badge>
            <div className="overflow-x-auto opacity-70">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    <th className="pb-2">{t('requirements.ingredient')}</th>
                    <th className="pb-2 text-right">{t('requirements.needed')}</th>
                  </tr>
                </thead>
                <tbody>
                  {explosion.partialRequirements.map((req) => (
                    <tr
                      key={req.ingredientId}
                      className="border-b border-border last:border-0"
                    >
                      <td className="py-2 pr-2 font-medium text-foreground">
                        {req.ingredientName}
                      </td>
                      <td className="py-2 text-right tabular-nums text-foreground">
                        {formatQuantity(req.neededCanonical, req.dimension, system)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {explosion.complete && explosion.requirements.length > 0 && (
          <div className="flex flex-col gap-1 text-xs text-muted-foreground">
            <span>
              {t('requirements.calculatedAt', {
                time: new Date(explosion.calculatedAt).toLocaleString(),
              })}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Info className="size-3.5 shrink-0" />
              {t('requirements.notReserved')}
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
