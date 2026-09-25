'use client';

import * as React from 'react';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import type { FolderDropState } from './use-folder-drag';

/**
 * One folder (or "All" / "Unfiled") shortcut — the shape shared by Recipes,
 * Menus and Kitchen Scale's folder grids.
 *
 * Deliberately COMPACT: a small icon, the name, and a small count on one row,
 * in a rectangular card that stays a comfortable click/touch/drag target
 * (min-h-14) without the oversized icon, heavy shadow and whitespace the
 * previous min-h-28 tile had. The caption is the INCLUSIVE recipe count (own +
 * every subfolder's) — see lib/folders/recipe-scope.ts.
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
  isInvalidTarget = false,
  onNavigate,
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
  /** Set while a dragged folder/recipe is hovering this tile as a drop target. */
  dropState?: FolderDropState | null;
  /** A drag is in flight and this tile can never accept it (itself / its own subtree). */
  isInvalidTarget?: boolean;
  /** Fired on an ordinary click-through (used to remember list state). */
  onNavigate?: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      {...dragProps}
      className={cn(
        'flex min-h-14 touch-manipulation items-center gap-2.5 rounded-xl border border-border bg-surface px-3 py-2.5 pr-9 transition-colors hover:border-accent-300 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        muted && 'bg-surface-2/60',
        isDragSource && 'opacity-40',
        isInvalidTarget && 'cursor-not-allowed border-dashed opacity-50',
        dropState === 'candidate' && 'border-accent-300 ring-1 ring-accent-300',
        dropState === 'commit' && 'border-accent-500 bg-accent-50 ring-2 ring-accent-500 dark:bg-accent-500/15',
      )}
    >
      <span
        className={cn(
          'flex size-8 shrink-0 items-center justify-center rounded-lg text-[15px]',
          muted
            ? 'bg-surface-2 text-muted-foreground'
            : 'bg-accent-50 text-accent-700 dark:bg-accent-500/15 dark:text-accent-300',
        )}
      >
        {icon}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium text-foreground">{name}</span>
        <span className="truncate text-xs text-muted-foreground">{caption}</span>
      </span>
    </Link>
  );
}
