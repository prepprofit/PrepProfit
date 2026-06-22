'use client';

import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
import type { Presence } from '@/lib/allergens/catalog';
import type { MenuAllergen } from '@/lib/calculations/menu';
import { Badge } from '@/components/ui/badge';

const PRESENCE_VARIANT: Record<Presence, 'negative' | 'warning'> = {
  contains: 'negative',
  may_contain: 'warning',
};

/**
 * Read-only allergen rollup for a menu (Sprint 10). OPERATIONAL aid — kitchen and
 * managers alike. Reuses the Sprint 9 wording rules: the disclaimer is load-bearing
 * and "no allergens recorded" is shown (never "allergen-free"); an unreviewed
 * warning never implies safety.
 */
export function MenuAllergenChips({
  allergens,
  hasUnreviewedIngredient,
}: {
  allergens: MenuAllergen[];
  hasUnreviewedIngredient: boolean;
}) {
  const t = useTranslations('allergens');
  const tRecipe = useTranslations('allergens.recipe');
  const tNames = useTranslations('allergens.labels');

  return (
    <div className="flex flex-col gap-2">
      {hasUnreviewedIngredient && (
        <p className="inline-flex items-start gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          {tRecipe('unreviewedWarning')}
        </p>
      )}
      {allergens.length === 0 ? (
        <p className="text-xs text-muted-foreground">{tRecipe('noneRecorded')}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {allergens.map((a) => (
            <Badge key={a.allergen} variant={PRESENCE_VARIANT[a.presence]}>
              {tNames(a.allergen)}
              {a.presence === 'may_contain' ? ` · ${t('presence.may_contain')}` : ''}
            </Badge>
          ))}
        </div>
      )}
      <p className="text-[11px] leading-snug text-muted-foreground">
        {t('disclaimer')}
      </p>
    </div>
  );
}
