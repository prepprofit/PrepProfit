'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ChevronRight, Plus, Trash2 } from 'lucide-react';
import type { Recipe } from '@/lib/db/schema';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  createRecipeAction,
  deleteRecipeAction,
} from '@/app/(app)/recipes/actions';

export function RecipeList({ initialRecipes }: { initialRecipes: Recipe[] }) {
  const t = useTranslations('recipes');
  const router = useRouter();
  const [rows, setRows] = React.useState<Recipe[]>(initialRecipes);
  const [name, setName] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  const onCreate = () => {
    const trimmed = name.trim();
    if (trimmed === '') {
      setError(t('errors.nameRequired'));
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await createRecipeAction({
        name: trimmed,
        yieldPortions: 1,
        yieldPercentage: 100,
        laborCostCents: 0,
        energyCostCents: 0,
        packagingCostCents: 0,
      });
      if (result.ok) {
        router.push(`/recipes/${result.data.id}`);
      } else {
        setError(result.error);
      }
    });
  };

  const onDelete = (id: string) => {
    setError(null);
    startTransition(async () => {
      const result = await deleteRecipeAction(id);
      if (result.ok) {
        setRows((prev) => prev.filter((r) => r.id !== id));
      } else {
        setError(result.error);
      }
    });
  };

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
        >
          {error}
        </div>
      )}

      <div className="flex flex-col gap-2 rounded-xl border border-dashed border-border bg-surface p-3 sm:flex-row sm:items-center">
        <Input
          aria-label={t('newName')}
          placeholder={t('placeholders.name')}
          value={name}
          disabled={pending}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onCreate();
          }}
        />
        <Button type="button" onClick={onCreate} disabled={pending}>
          <Plus className="size-4" />
          {t('actions.create')}
        </Button>
      </div>

      {rows.length === 0 ? (
        <p className="px-1 py-8 text-center text-sm text-muted-foreground">
          {t('empty')}
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {rows.map((recipe) => (
            <li
              key={recipe.id}
              className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface p-4"
            >
              <Link
                href={`/recipes/${recipe.id}`}
                className="group flex min-w-0 flex-1 items-center justify-between gap-2"
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium text-foreground">
                    {recipe.name}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {t('portions', { count: recipe.yieldPortions })}
                  </span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
              </Link>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={t('actions.delete')}
                disabled={pending}
                onClick={() => onDelete(recipe.id)}
              >
                <Trash2 className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
