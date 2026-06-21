'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Plus, X } from 'lucide-react';
import {
  ALLERGEN_CATALOG,
  type AllergenSlug,
  type Presence,
} from '@/lib/allergens/catalog';
import type { RecipeAllergenRollup } from '@/lib/calculations/allergens';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  addRecipeOverrideAction,
  clearRecipeOverrideAction,
} from '@/app/(app)/recipes/allergen-actions';
import { useActionError } from '@/lib/i18n/use-action-error';

const PRESENCE_VARIANT: Record<Presence, 'negative' | 'warning'> = {
  contains: 'negative',
  may_contain: 'warning',
};

/**
 * Recipe allergen panel (Sprint 9). OPERATIONAL — kitchen and managers alike see
 * the derived-vs-added rollup, can ADD/ESCALATE an override (never downgrade), and
 * clear a manual addition. Derived and added presence are shown SEPARATELY
 * (provenance). The disclaimer is load-bearing and "no allergens recorded" is used
 * (never "allergen-free"); an unreviewed-ingredient warning never implies safety.
 */
export function RecipeAllergenPanel({
  recipeId,
  initialRollup,
}: {
  recipeId: string;
  initialRollup: RecipeAllergenRollup;
}) {
  const t = useTranslations('allergens');
  const tNames = useTranslations('allergens.labels');
  const actionError = useActionError();
  const [rollup, setRollup] = React.useState(initialRollup);
  const [newAllergen, setNewAllergen] = React.useState<AllergenSlug | ''>('');
  const [newPresence, setNewPresence] = React.useState<Presence>('contains');
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  const presenceLabel = (p: Presence) => t(`presence.${p}`);

  const onAdd = () => {
    if (newAllergen === '') return;
    setError(null);
    startTransition(async () => {
      const result = await addRecipeOverrideAction(recipeId, {
        allergen: newAllergen,
        presence: newPresence,
      });
      if (result.ok) {
        setRollup(result.data);
        setNewAllergen('');
      } else {
        setError(actionError(result.code));
      }
    });
  };

  const onClear = (allergen: AllergenSlug) => {
    setError(null);
    startTransition(async () => {
      const result = await clearRecipeOverrideAction(recipeId, { allergen });
      if (result.ok) setRollup(result.data);
      else setError(actionError(result.code));
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('recipe.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs text-muted-foreground">
          {t('disclaimer')}
        </p>

        {rollup.hasUnreviewedIngredient && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>{t('recipe.unreviewedWarning')}</span>
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
          >
            {error}
          </div>
        )}

        {rollup.allergens.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('recipe.noneRecorded')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {rollup.allergens.map((a) => {
              const hasOverride = a.overridePresence !== null;
              const provenance =
                a.derivedPresence !== null && hasOverride
                  ? t('recipe.fromBoth')
                  : a.derivedPresence !== null
                    ? t('recipe.fromIngredients')
                    : t('recipe.added');
              return (
                <li
                  key={a.allergen}
                  className="flex items-center justify-between gap-3 py-2"
                >
                  <div className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium text-foreground">
                      {tNames(a.allergen)}
                    </span>
                    <span className="text-xs text-muted-foreground">{provenance}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={PRESENCE_VARIANT[a.effectivePresence]}>
                      {presenceLabel(a.effectivePresence)}
                    </Badge>
                    {hasOverride && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={t('recipe.clearOverride')}
                        title={t('recipe.clearOverride')}
                        disabled={pending}
                        onClick={() => onClear(a.allergen)}
                      >
                        <X className="size-4" />
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {/* Add or escalate — add/escalate only (a downgrade is refused server-side). */}
        <div className="grid grid-cols-1 gap-2 rounded-lg border border-dashed border-border p-3 sm:grid-cols-[1fr_auto_auto] sm:items-center">
          <Select
            aria-label={t('recipe.addAllergen')}
            value={newAllergen}
            disabled={pending}
            onChange={(e) => setNewAllergen(e.target.value as AllergenSlug | '')}
          >
            <option value="">{t('recipe.selectAllergen')}</option>
            {ALLERGEN_CATALOG.map((entry) => (
              <option key={entry.slug} value={entry.slug}>
                {tNames(entry.slug)}
              </option>
            ))}
          </Select>
          <Select
            aria-label={t('recipe.presence')}
            className="w-40"
            value={newPresence}
            disabled={pending}
            onChange={(e) => setNewPresence(e.target.value as Presence)}
          >
            <option value="contains">{t('presence.contains')}</option>
            <option value="may_contain">{t('presence.may_contain')}</option>
          </Select>
          <Button
            type="button"
            onClick={onAdd}
            disabled={pending || newAllergen === ''}
          >
            <Plus className="size-4" />
            {t('recipe.add')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
