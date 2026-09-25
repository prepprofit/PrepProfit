import Link from 'next/link';
import { ArrowLeft, Folder, Inbox, Layers } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { getOrgId } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { listKitchenScaleRecipes } from '@/lib/data/recipes';
import { listFoldersWithCounts } from '@/lib/data/recipe-folders';
import { KitchenScaleHome } from '@/components/app/kitchen-scale/kitchen-scale-home';
import { KitchenScaleFolderList } from '@/components/app/kitchen-scale/kitchen-scale-folder-list';
import { cn } from '@/lib/utils';

/**
 * Kitchen Scale — folder-first, like Recipes (Kitchen Scale redesign §1).
 * OPERATIONAL + MONEY-FREE for BOTH roles by DTO type — no `NoAccess` gate, no
 * money field ever leaves the server. Read-only: recipe/folder management
 * stays on `/recipes`; Kitchen Scale reuses the SAME folders.
 *
 * Two views on one route, so `?folder=` links are bookmarkable:
 * - Home (no folder): a large search across every recipe, then folder tiles
 *   only — no recipe grid alongside them.
 * - Folder (`?folder=<id>`, `none` for Unfiled, `all` for every recipe):
 *   full-width recipe list.
 */
export default async function KitchenScalePage({
  searchParams,
}: {
  searchParams: Promise<{ folder?: string }>;
}) {
  const t = await getTranslations('kitchenScale');
  const tHome = await getTranslations('kitchenScale.home');
  const organizationId = await getOrgId();
  const { folder } = await searchParams;

  const [recipes, listing] = await Promise.all([
    withOrg(organizationId, (tx) => listKitchenScaleRecipes(tx, organizationId)),
    withOrg(organizationId, (tx) => listFoldersWithCounts(tx, organizationId)),
  ]);
  const searchItems = recipes.map((r) => ({
    id: r.id,
    name: r.name,
    folderId: r.folderId,
    recentActivityAt: r.recentActivityAt,
  }));

  const activeFolder =
    folder && folder !== 'none' && folder !== 'all'
      ? (listing.folders.find((f) => f.id === folder) ?? null)
      : null;
  const inUnfiled = folder === 'none';
  const inAll = folder === 'all';

  // ── Home ──────────────────────────────────────────────────────────────────
  if (!activeFolder && !inUnfiled && !inAll) {
    return (
      <div className="flex flex-col gap-5">
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        <KitchenScaleHome listing={listing} recipes={searchItems} />
      </div>
    );
  }

  // ── Folder view ───────────────────────────────────────────────────────────
  const activeKey = activeFolder ? activeFolder.id : inAll ? 'all' : 'none';
  const visibleRecipes = inAll
    ? searchItems
    : searchItems.filter((r) =>
        activeFolder ? r.folderId === activeFolder.id : r.folderId === null,
      );
  const href = `/kitchen-scale?folder=${activeKey}`;

  return (
    <div className="flex w-full flex-col gap-5">
      <div className="flex flex-col gap-3">
        <Link
          href="/kitchen-scale"
          className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          {tHome('back')}
        </Link>
        <div className="flex items-center gap-3">
          <span
            className={cn(
              'flex size-10 shrink-0 items-center justify-center rounded-xl',
              activeFolder || inAll
                ? 'bg-accent-50 text-accent-700 dark:bg-accent-500/15 dark:text-accent-300'
                : 'bg-surface-2 text-muted-foreground',
            )}
          >
            {activeFolder?.icon ? (
              <span aria-hidden className="text-xl leading-none">
                {activeFolder.icon}
              </span>
            ) : activeFolder ? (
              <Folder className="size-5" aria-hidden />
            ) : inAll ? (
              <Layers className="size-5" aria-hidden />
            ) : (
              <Inbox className="size-5" aria-hidden />
            )}
          </span>
          <div className="flex min-w-0 flex-col">
            <h2 className="truncate font-display text-2xl font-semibold tracking-tight text-foreground">
              {activeFolder ? activeFolder.name : inAll ? tHome('allTitle') : tHome('unfiled')}
            </h2>
            <p className="text-xs text-muted-foreground">
              {tHome('recipeCount', { count: visibleRecipes.length })}
            </p>
          </div>
        </div>
      </div>

      <KitchenScaleFolderList recipes={visibleRecipes} href={href} />
    </div>
  );
}
