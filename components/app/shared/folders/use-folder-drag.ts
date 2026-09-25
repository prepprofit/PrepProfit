'use client';

import * as React from 'react';
import { folderDescendantIds, type FolderTreeNode } from '@/lib/folders/tree';

/**
 * Hand-rolled folder drag-and-drop with native Pointer Events — no library (the
 * app installs none; this mirrors the pointer-capture + `elementFromPoint`
 * pattern already proven for ingredient-line reordering in
 * components/app/recipes/workspace/recipe-input-list.tsx).
 *
 * Touch vs. scroll: a touch drag only ARMS after a short hold (HOLD_MS) with
 * no more than a few pixels of movement. Until armed, we never call
 * `preventDefault()` and never capture the pointer, so an ordinary touch-scroll
 * that starts moving immediately is left completely alone — the timer sees the
 * movement, cancels itself, and the drag never engages. A mouse/pen drag arms
 * on a small movement threshold instead (no scroll ambiguity to protect
 * against there). Once armed we capture the pointer (mouse has no implicit
 * capture like touch does) so `pointermove`/`pointerup` keep reaching us
 * wherever the pointer travels, and `elementFromPoint` finds the tile
 * currently underneath it. A target must be hovered continuously for
 * COMMIT_MS before it switches from "candidate" to "will move here".
 *
 * Pointer Events (not Touch Events) are used deliberately: React attaches
 * `touchstart`/`touchmove`/`wheel` listeners as passive (so `preventDefault`
 * inside them is silently ignored), but pointer listeners are not — the same
 * reason the existing reorder pattern uses them.
 */

const TOUCH_HOLD_MS = 400;
const TOUCH_CANCEL_DISTANCE = 10;
const POINTER_ARM_DISTANCE = 4;
const COMMIT_MS = 500;

export type FolderDropState = 'candidate' | 'commit';

export function useFolderDragAndDrop<T extends FolderTreeNode>({
  folders,
  onMove,
  disabled = false,
}: {
  /** Every folder tile actually rendered (or the full org list) — used to reject self/descendant drop targets. */
  folders: readonly T[];
  onMove: (id: string, newParentId: string) => void;
  disabled?: boolean;
}) {
  const [draggingId, setDraggingId] = React.useState<string | null>(null);
  const [overId, setOverId] = React.useState<string | null>(null);
  const [committing, setCommitting] = React.useState(false);

  const tileRefs = React.useRef(new Map<string, HTMLElement>());
  const start = React.useRef<{
    x: number;
    y: number;
    pointerId: number;
    pointerType: string;
    folderId: string;
    armed: boolean;
  } | null>(null);
  const holdTimer = React.useRef<number | null>(null);
  const commitTimer = React.useRef<number | null>(null);
  const suppressNextClick = React.useRef<Set<string>>(new Set());

  const excludedIds = React.useMemo(() => {
    if (!draggingId) return new Set<string>();
    const ids = folderDescendantIds(folders, draggingId);
    ids.add(draggingId);
    return ids;
  }, [folders, draggingId]);

  const clearHoldTimer = React.useCallback(() => {
    if (holdTimer.current !== null) {
      window.clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
  }, []);
  const clearCommitTimer = React.useCallback(() => {
    if (commitTimer.current !== null) {
      window.clearTimeout(commitTimer.current);
      commitTimer.current = null;
    }
  }, []);

  const reset = React.useCallback(() => {
    clearHoldTimer();
    clearCommitTimer();
    start.current = null;
    setDraggingId(null);
    setOverId(null);
    setCommitting(false);
  }, [clearHoldTimer, clearCommitTimer]);

  function arm(folderId: string) {
    if (!start.current) return;
    start.current.armed = true;
    setDraggingId(folderId);
    try {
      tileRefs.current.get(folderId)?.setPointerCapture(start.current.pointerId);
    } catch {
      // Pointer may already be gone (e.g. a fast pointerup raced the timer) — the
      // subsequent pointerup/pointercancel handler still resets cleanly.
    }
  }

  React.useEffect(() => {
    if (!draggingId) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') reset();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [draggingId, reset]);

  React.useEffect(() => () => {
    clearHoldTimer();
    clearCommitTimer();
  }, [clearHoldTimer, clearCommitTimer]);

  function getTileProps(folderId: string) {
    if (disabled) {
      return {
        ref: undefined,
        'data-folder-tile-id': folderId,
      } as const;
    }
    return {
      ref: (el: HTMLElement | null) => {
        if (el) tileRefs.current.set(folderId, el);
        else tileRefs.current.delete(folderId);
      },
      'data-folder-tile-id': folderId,
      'data-dragging': draggingId === folderId ? 'true' : undefined,
      'data-drop-candidate': overId === folderId && !committing ? 'true' : undefined,
      'data-drop-commit': overId === folderId && committing ? 'true' : undefined,
      onPointerDown: (e: React.PointerEvent) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        start.current = {
          x: e.clientX,
          y: e.clientY,
          pointerId: e.pointerId,
          pointerType: e.pointerType,
          folderId,
          armed: false,
        };
        if (e.pointerType === 'touch') {
          clearHoldTimer();
          const pointerId = e.pointerId;
          holdTimer.current = window.setTimeout(() => {
            if (start.current?.pointerId === pointerId && !start.current.armed) arm(folderId);
          }, TOUCH_HOLD_MS);
        }
      },
      onPointerMove: (e: React.PointerEvent) => {
        const s = start.current;
        if (!s || s.pointerId !== e.pointerId) return;

        if (!s.armed) {
          const distance = Math.hypot(e.clientX - s.x, e.clientY - s.y);
          if (s.pointerType === 'touch') {
            if (distance > TOUCH_CANCEL_DISTANCE) reset(); // a real scroll/pan — never arm
            return; // otherwise keep waiting for the hold timer
          }
          if (distance > POINTER_ARM_DISTANCE) arm(folderId);
          return;
        }

        e.preventDefault();
        const el = document
          .elementFromPoint(e.clientX, e.clientY)
          ?.closest<HTMLElement>('[data-folder-tile-id]');
        const targetId = el?.dataset.folderTileId ?? null;
        const valid = targetId !== null && targetId !== s.folderId && !excludedIds.has(targetId);

        if (!valid) {
          if (overId !== null) {
            setOverId(null);
            setCommitting(false);
            clearCommitTimer();
          }
          return;
        }
        if (targetId !== overId) {
          setOverId(targetId);
          setCommitting(false);
          clearCommitTimer();
          commitTimer.current = window.setTimeout(() => setCommitting(true), COMMIT_MS);
        }
      },
      onPointerUp: (e: React.PointerEvent) => {
        const s = start.current;
        if (!s || s.pointerId !== e.pointerId) return;
        if (s.armed) {
          suppressNextClick.current.add(s.folderId);
          window.setTimeout(() => suppressNextClick.current.delete(s.folderId), 0);
          if (overId) onMove(s.folderId, overId);
        }
        reset();
      },
      onPointerCancel: (e: React.PointerEvent) => {
        if (start.current?.pointerId === e.pointerId) reset();
      },
      onClick: (e: React.MouseEvent) => {
        if (suppressNextClick.current.has(folderId)) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
    } as const;
  }

  return { draggingId, overId, committing, getTileProps };
}
