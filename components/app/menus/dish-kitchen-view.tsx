'use client';

import * as React from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ArrowLeft } from 'lucide-react';
import type { KitchenDishDetail } from '@/lib/data/menus';
import { markDishOpenedAction } from '@/app/(app)/menus/actions';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { MenuAllergenChips } from './menu-allergen-chips';
import { numberToField } from './dish-format';

/**
 * Read-only dish for the kitchen role: what goes in it and in what amounts, plus
 * allergens. Money-free by type (`KitchenDishDetail` carries no price or cost).
 */
export function DishKitchenView({ dish }: { dish: KitchenDishDetail }) {
  const t = useTranslations('menus.builder');
  const tUnits = useTranslations('menus.units');
  const tBatch = useTranslations('menus.batch');

  React.useEffect(() => {
    void markDishOpenedAction(dish.id);
  }, [dish.id]);

  const lines = [
    ...dish.recipeLines.map((l) => ({
      key: `r:${l.recipeId}`,
      name: l.recipeName,
      amount: `${numberToField(l.quantity)} ${tUnits(l.unit)}`,
      available: l.available,
    })),
    ...dish.ingredientLines.map((l) => ({
      key: `i:${l.ingredientId}`,
      name: l.ingredientName,
      amount: `${numberToField(l.quantity)} ${tUnits(l.unit)}`,
      available: l.available,
    })),
  ];

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Link
          href={dish.folderId ? `/menus/folders/${dish.folderId}` : '/menus/folders/unfiled'}
          className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          {t('back')}
        </Link>
        <h2 className="font-display text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
          {dish.name}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t('output.makes')}{' '}
          <span className="font-medium text-foreground">
            {tBatch('makes', {
              unit: dish.output.unit,
              count: dish.output.quantity,
              amount: numberToField(dish.output.quantity),
            })}
          </span>
          {dish.output.sizeDescription && ` · ${dish.output.sizeDescription}`}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('composition')}</CardTitle>
        </CardHeader>
        <CardContent>
          {lines.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('recipes.empty')}</p>
          ) : (
            <ul className="divide-y divide-border">
              {lines.map((line) => (
                <li key={line.key} className="flex items-center justify-between gap-3 py-2.5">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-foreground">{line.name}</span>
                    {!line.available && <Badge variant="negative">{t('unavailable')}</Badge>}
                  </span>
                  <span className="shrink-0 text-sm tabular-nums text-muted-foreground">{line.amount}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <MenuAllergenChips allergens={dish.allergens} hasUnreviewedIngredient={dish.hasUnreviewedIngredient} />

      {dish.notes && (
        <Card>
          <CardContent className="whitespace-pre-wrap pt-6 text-sm text-foreground">{dish.notes}</CardContent>
        </Card>
      )}
    </div>
  );
}
