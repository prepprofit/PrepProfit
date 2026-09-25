import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { FolderDropState } from './use-folder-drag';

export type BreadcrumbCrumb = {
  key: string;
  label: string;
  href: string;
  /**
   * Makes this crumb a DROP TARGET for a dragged folder/recipe — a folder id, or
   * `ROOT_DROP_ID` for "top level" / "No folder". Omit for a plain crumb.
   */
  dropId?: string;
};

/**
 * Clickable ancestor chain: "Recipes › Wibox › Linda › Cakes". Wraps onto a
 * second line on narrow screens instead of overflowing; the current (last)
 * crumb is not a link. Callers build `crumbs` from lib/folders/tree.ts's
 * `folderPath` plus the section's own root crumb.
 *
 * With `getDropProps`/`dropStateOf` (from `useFolderDragAndDrop`) each crumb
 * carrying a `dropId` also accepts a dragged folder — that is how a folder is
 * moved back UP the hierarchy, including all the way to top level.
 */
export function FolderBreadcrumb({
  crumbs,
  className,
  getDropProps,
  dropStateOf,
}: {
  crumbs: BreadcrumbCrumb[];
  className?: string;
  getDropProps?: (dropId: string) => Record<string, unknown>;
  dropStateOf?: (dropId: string) => FolderDropState | null;
}) {
  return (
    <nav aria-label="Breadcrumb" className={cn('flex flex-wrap items-center gap-1 text-sm', className)}>
      {crumbs.map((crumb, index) => {
        const isLast = index === crumbs.length - 1;
        const dropState = crumb.dropId && dropStateOf ? dropStateOf(crumb.dropId) : null;
        const dropProps = crumb.dropId && getDropProps ? getDropProps(crumb.dropId) : undefined;
        const dropClass = cn(
          'rounded-md px-1 py-0.5 transition-colors',
          dropState === 'candidate' && 'bg-accent-50 ring-1 ring-accent-300 dark:bg-accent-500/15',
          dropState === 'commit' && 'bg-accent-50 ring-2 ring-accent-500 dark:bg-accent-500/15',
        );
        return (
          <span key={crumb.key} className="flex min-w-0 items-center gap-1">
            {index > 0 && <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
            {isLast ? (
              <span {...dropProps} className={cn('truncate font-medium text-foreground', dropClass)} aria-current="page">
                {crumb.label}
              </span>
            ) : (
              <Link
                href={crumb.href}
                {...dropProps}
                className={cn(
                  'truncate text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:underline',
                  dropClass,
                )}
              >
                {crumb.label}
              </Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}
