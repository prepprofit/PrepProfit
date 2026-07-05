'use client';

import * as React from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ChevronRight, Search } from 'lucide-react';
import type { KitchenScaleRecipeListItem } from '@/lib/data/recipes';
import { type MeasurementSystem, formatQuantity } from '@/lib/units';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';

export type KitchenScaleFolderOption = { id: string; name: string };

/**
 * Kitchen Scale recipe picker (money-free by prop type for BOTH roles). Pure
 * client-side filtering — search by name plus an optional folder filter — over the
 * server-provided operational listing. Cards only navigate; all recipe management
 * stays on /recipes.
 */
export function KitchenScaleRecipeList({
  recipes,
  folders,
  measurementSystem,
}: {
  recipes: KitchenScaleRecipeListItem[];
  folders: KitchenScaleFolderOption[];
  measurementSystem: MeasurementSystem;
}) {
  const t = useTranslations('kitchenScale');
  const [query, setQuery] = React.useState('');
  // '' = all folders; 'none' = recipes with no folder; else a folder id.
  const [folderFilter, setFolderFilter] = React.useState('');

  const folderNames = React.useMemo(
    () => new Map(folders.map((f) => [f.id, f.name])),
    [folders],
  );

  const q = query.trim().toLowerCase();
  const visible = recipes.filter((r) => {
    if (q !== '' && !r.name.toLowerCase().includes(q)) return false;
    if (folderFilter === 'none') return r.folderId === null;
    if (folderFilter !== '') return r.folderId === folderFilter;
    return true;
  });

  return (
    <div className="flex flex-col gap-4">
      {/* Search + folder filter */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label={t('searchPlaceholder')}
            className="pl-9"
            placeholder={t('searchPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <Select
          aria-label={t('folderFilter')}
          className="w-48"
          value={folderFilter}
          onChange={(e) => setFolderFilter(e.target.value)}
        >
          <option value="">{t('allFolders')}</option>
          <option value="none">{t('noFolder')}</option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </Select>
      </div>

      {visible.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
          {recipes.length === 0 ? t('empty') : t('noMatches')}
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((r) => {
            const folderName =
              r.folderId != null ? folderNames.get(r.folderId) : undefined;
            return (
              <li key={r.id}>
                <Link
                  href={`/kitchen-scale/${r.id}`}
                  className="group flex h-full flex-col gap-2 rounded-lg border border-border bg-surface p-4 transition-colors hover:border-accent-600/40 hover:bg-surface-2"
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-medium text-foreground">{r.name}</span>
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                  </div>
                  {folderName && (
                    <div>
                      <Badge variant="neutral">{folderName}</Badge>
                    </div>
                  )}
                  <div className="mt-auto flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>{t('cardPortions', { count: r.yieldPortions })}</span>
                    <span>{t('cardLines', { count: r.lineCount })}</span>
                    <span>{t('cardPresets', { count: r.presetCount })}</span>
                    {r.yieldWeightGrams != null && r.yieldWeightGrams > 0 && (
                      <span className="tabular-nums">
                        {t('cardYieldWeight', {
                          weight: formatQuantity(
                            r.yieldWeightGrams,
                            'weight',
                            measurementSystem,
                          ),
                        })}
                      </span>
                    )}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
