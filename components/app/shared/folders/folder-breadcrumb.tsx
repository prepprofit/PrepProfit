import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

export type BreadcrumbCrumb = { key: string; label: string; href: string };

/**
 * Clickable ancestor chain: "Recipes › Wibox › Linda › Cakes". Wraps onto a
 * second line on narrow screens instead of overflowing; the current (last)
 * crumb is not a link. Callers build `crumbs` from lib/folders/tree.ts's
 * `folderPath` plus the section's own root crumb.
 */
export function FolderBreadcrumb({ crumbs, className }: { crumbs: BreadcrumbCrumb[]; className?: string }) {
  return (
    <nav aria-label="Breadcrumb" className={cn('flex flex-wrap items-center gap-1 text-sm', className)}>
      {crumbs.map((crumb, index) => {
        const isLast = index === crumbs.length - 1;
        return (
          <span key={crumb.key} className="flex min-w-0 items-center gap-1">
            {index > 0 && <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
            {isLast ? (
              <span className="truncate font-medium text-foreground" aria-current="page">
                {crumb.label}
              </span>
            ) : (
              <Link
                href={crumb.href}
                className="truncate text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:underline"
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
