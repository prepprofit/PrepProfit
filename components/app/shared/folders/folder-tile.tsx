'use client';

import * as React from 'react';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import type { FolderDropState } from './use-folder-drag';

/**
 * One folder (or "All" / "Unfiled" / "New folder") card — the shape shared by
 * Recipes, Menus and Kitchen Scale's folder grids (previously three near-
 * identical copies: recipe-home.tsx, menu-home.tsx, kitchen-scale-home.tsx).
 *
 * Drag state is purely visual here — `useFolderDragAndDrop` owns the actual
 * pointer logic; a caller wraps this in `<div className="relative">` alongside
 * a `FolderMenu`, exactly like the pre-existing per-section layout.
 */
export function FolderTile({
  href,
  name,
  caption,
  icon,
  muted = false,
  dragProps,
  isDragSource = false,
  dropState = null,
}: {
  href: string;
  name: string;
  caption: string;
  icon: React.ReactNode;
  muted?: boolean;
  /** Spread from `useFolderDragAndDrop().getTileProps(id)` — omit for a non-draggable tile (e.g. "All", "Unfiled", Kitchen Scale). */
  dragProps?: Record<string, unknown>;
  /** True while THIS tile is the one being dragged (dims it). */
  isDragSource?: boolean;
  /** Set while another dragged folder is hovering this tile as a drop target. */
  dropState?: FolderDropState | null;
}) {
  return (
    <Link
      href={href}
      {...dragProps}
      className={cn(
        'flex min-h-28 touch-manipulation flex-col justify-between gap-3 rounded-2xl border border-border bg-surface p-4 shadow-sm transition hover:-translate-y-0.5 hover:border-accent-300 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        muted && 'bg-surface-2/60 shadow-none',
        isDragSource && 'opacity-40',
        dropState === 'candidate' && 'border-accent-300 ring-1 ring-accent-300',
        dropState === 'commit' && 'border-accent-500 bg-accent-50 ring-2 ring-accent-500 dark:bg-accent-500/15',
      )}
    >
      <span
        className={cn(
          'flex size-10 items-center justify-center rounded-xl',
          muted
            ? 'bg-surface-2 text-muted-foreground'
            : 'bg-accent-50 text-accent-700 dark:bg-accent-500/15 dark:text-accent-300',
        )}
      >
        {icon}
      </span>
      <span className="flex min-w-0 flex-col pr-6">
        <span className="truncate font-medium text-foreground">{name}</span>
        <span className="text-xs text-muted-foreground">{caption}</span>
      </span>
    </Link>
  );
}
