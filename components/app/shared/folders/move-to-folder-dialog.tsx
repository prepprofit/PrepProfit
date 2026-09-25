'use client';

import * as React from 'react';
import { Check, Folder, Layers } from 'lucide-react';
import { Command, CommandGroup, CommandInput, CommandList, CommandItem } from '@/components/ui/command';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { folderAncestorLabel, validMoveDestinations, type FolderTreeNode } from '@/lib/folders/tree';

export type MoveToFolderLabels = {
  title: string;
  description: string;
  searchPlaceholder: string;
  topLevel: string;
  moveLabel: string;
  cancelLabel: string;
  noResults: string;
  empty: string;
};

/**
 * The keyboard/tablet-reliable alternative to dragging: search across every
 * folder, a pinned "Top level" destination, each candidate labeled with its
 * full path so it's never ambiguous which folder ("Wibox › Cakes" vs.
 * "Linda › Cakes"), and Move/Cancel. Modeled directly on
 * components/app/ingredients/supplier-picker.tsx's cmdk usage, wrapped in the
 * existing native-`<dialog>`-based `ConfirmDialog` (full keyboard support,
 * focus trap and Escape come from that combination for free).
 *
 * The folder being moved and all of its own descendants are excluded from the
 * list client-side (lib/folders/tree.ts) so an invalid destination is never
 * even offered — the server re-validates the same way regardless.
 */
export function MoveToFolderDialog<T extends FolderTreeNode>({
  open,
  folders,
  folderId,
  pending = false,
  labels,
  onMove,
  onCancel,
}: {
  open: boolean;
  /** The full org folder list — the folder being moved plus every candidate destination. */
  folders: readonly T[];
  /**
   * The FOLDER being moved (it and its descendants are excluded), or `null` when
   * something else is being filed — a RECIPE — for which every folder is a valid
   * destination.
   */
  folderId: string | null;
  pending?: boolean;
  labels: MoveToFolderLabels;
  onMove: (parentId: string | null) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = React.useState('');
  // undefined = nothing chosen yet (Move stays disabled); null = "Top level".
  const [selected, setSelected] = React.useState<string | null | undefined>(undefined);

  React.useEffect(() => {
    if (open) {
      setQuery('');
      setSelected(undefined);
    }
    // Re-arm whenever a different folder is being moved, or the dialog reopens.
  }, [open, folderId]);

  const destinations = React.useMemo(
    () => (folderId === null ? [...folders] : validMoveDestinations(folders, folderId)),
    [folders, folderId],
  );
  const q = query.trim().toLowerCase();
  const filtered = React.useMemo(() => {
    if (q === '') return destinations;
    return destinations.filter((f) =>
      `${folderAncestorLabel(folders, f.id)} ${f.name}`.toLowerCase().includes(q),
    );
  }, [destinations, folders, q]);
  const topLevelMatches = q === '' || labels.topLevel.toLowerCase().includes(q);

  return (
    <ConfirmDialog
      open={open}
      title={labels.title}
      description={labels.description}
      confirmLabel={labels.moveLabel}
      cancelLabel={labels.cancelLabel}
      pending={pending}
      confirmDisabled={selected === undefined}
      onConfirm={() => {
        if (selected !== undefined) onMove(selected);
      }}
      onCancel={onCancel}
    >
      <div
        className="overflow-hidden rounded-lg border border-border bg-surface"
        // Escape closes the picker's own focus, not the whole dialog behind it —
        // ConfirmDialog's own onCancel already handles the dialog-level Escape.
        onKeyDown={(e) => {
          if (e.key === 'Escape') e.stopPropagation();
        }}
      >
        <Command shouldFilter={false} className="gap-0">
          <div className="flex items-center gap-2 border-b border-border px-3">
            <CommandInput
              autoFocus
              value={query}
              onValueChange={setQuery}
              placeholder={labels.searchPlaceholder}
              className="h-10 text-sm"
              disabled={pending}
            />
          </div>
          <CommandList className="max-h-64">
            <CommandGroup>
              {topLevelMatches && (
                <CommandItem value="__top__" onSelect={() => setSelected(null)} className="justify-between">
                  <span className="flex items-center gap-2 truncate">
                    <Layers className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    {labels.topLevel}
                  </span>
                  {selected === null && <Check className="size-4 shrink-0" aria-hidden />}
                </CommandItem>
              )}
              {filtered.map((f) => {
                const path = folderAncestorLabel(folders, f.id);
                return (
                  <CommandItem key={f.id} value={f.id} onSelect={() => setSelected(f.id)} className="justify-between">
                    <span className="flex min-w-0 items-center gap-2">
                      <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate">{f.name}</span>
                        {path && <span className="truncate text-xs text-muted-foreground">{path}</span>}
                      </span>
                    </span>
                    {selected === f.id && <Check className="size-4 shrink-0" aria-hidden />}
                  </CommandItem>
                );
              })}
            </CommandGroup>
            {!topLevelMatches && filtered.length === 0 && (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">{labels.noResults}</p>
            )}
            {destinations.length === 0 && q === '' && (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">{labels.empty}</p>
            )}
          </CommandList>
        </Command>
      </div>
    </ConfirmDialog>
  );
}
