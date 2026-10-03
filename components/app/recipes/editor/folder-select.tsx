'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Check, ChevronDown, Folder, FolderPlus } from 'lucide-react';
import { Command, CommandItem, CommandList } from '@/components/ui/command';
import { Command as CommandPrimitive } from 'cmdk';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { createFolderAction } from '@/app/(app)/recipes/folder-actions';
import { folderLabel, folderTreeOrder, type FolderTreeNode } from '@/lib/folders/tree';
import { useActionError } from '@/lib/i18n/use-action-error';

/**
 * Compact folder dropdown under the recipe name: searchable, shows the hierarchy,
 * allows "No folder", and creates + selects a new folder in place ("+ New folder")
 * so the chef never leaves the editor. Choosing only updates the draft — the recipe
 * is filed when it is saved.
 */
export function FolderSelect({
  folders,
  value,
  onChange,
  onFolderCreated,
}: {
  folders: FolderTreeNode[];
  value: string | null;
  onChange: (folderId: string | null) => void;
  onFolderCreated: (folder: FolderTreeNode) => void;
}) {
  const t = useTranslations('recipes.editor.folder');
  const actionError = useActionError();
  const [open, setOpen] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [newName, setNewName] = React.useState('');
  const [parentId, setParentId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  const ordered = React.useMemo(() => folderTreeOrder(folders), [folders]);
  const currentLabel = value ? folderLabel(folders, value) || t('none') : t('none');

  const reset = () => {
    setCreating(false);
    setQuery('');
    setNewName('');
    setError(null);
  };

  const choose = (folderId: string | null) => {
    onChange(folderId);
    setOpen(false);
    reset();
  };

  const startCreate = () => {
    setNewName(query.trim());
    setParentId(null);
    setError(null);
    setCreating(true);
  };

  const create = () => {
    const name = newName.trim();
    if (name === '') {
      setError(t('nameRequired'));
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await createFolderAction({ name, parentId });
      if (!result.ok) {
        setError(actionError(result.code));
        return;
      }
      onFolderCreated({ id: result.data.id, name, parentId });
      choose(result.data.id);
    });
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t('label') + ': ' + currentLabel}
          className="inline-flex min-h-9 max-w-full items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1 text-sm text-muted-foreground transition-colors hover:border-muted-foreground/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Folder className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{currentLabel}</span>
          <ChevronDown className="size-3.5 shrink-0" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(22rem,calc(100vw-2rem))] p-0">
        {creating ? (
          <form
            className="flex flex-col gap-3 p-3"
            onSubmit={(e) => {
              e.preventDefault();
              create();
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="editor-new-folder-name">{t('newName')}</Label>
              <Input
                id="editor-new-folder-name"
                autoFocus
                value={newName}
                maxLength={80}
                placeholder={t('newNamePlaceholder')}
                disabled={pending}
                onChange={(e) => setNewName(e.target.value)}
              />
            </div>
            {folders.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="editor-new-folder-parent">{t('inside')}</Label>
                <Select
                  id="editor-new-folder-parent"
                  value={parentId ?? ''}
                  disabled={pending}
                  onChange={(e) => setParentId(e.target.value === '' ? null : e.target.value)}
                >
                  <option value="">{t('topLevel')}</option>
                  {ordered.map(({ folder }) => (
                    <option key={folder.id} value={folder.id}>
                      {folderLabel(folders, folder.id)}
                    </option>
                  ))}
                </Select>
              </div>
            ) : null}
            {error ? (
              <p role="alert" className="text-xs text-red-700 dark:text-red-300">
                {error}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setCreating(false)} disabled={pending}>
                {t('back')}
              </Button>
              <Button type="submit" size="sm" disabled={pending}>
                {pending ? t('creating') : t('create')}
              </Button>
            </div>
          </form>
        ) : (
          <Command className="gap-0" loop>
            <div className="border-b border-border px-3">
              <CommandPrimitive.Input
                autoFocus
                value={query}
                onValueChange={setQuery}
                placeholder={t('search')}
                aria-label={t('search')}
                className="h-11 w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
              />
            </div>
            <CommandList className="max-h-72 p-1">
              <CommandPrimitive.Empty className="px-3 py-2 text-sm text-muted-foreground">{t('empty')}</CommandPrimitive.Empty>
              <CommandItem value={t('none')} onSelect={() => choose(null)} className="min-h-10 rounded-lg">
                <span className="flex-1 text-muted-foreground">{t('none')}</span>
                {value === null ? <Check className="size-4 text-accent-700 dark:text-accent-300" aria-hidden /> : null}
              </CommandItem>
              {ordered.map(({ folder, depth }) => {
                const path = folderLabel(folders, folder.id);
                const searching = query.trim() !== '';
                return (
                  <CommandItem
                    key={folder.id}
                    value={path}
                    onSelect={() => choose(folder.id)}
                    className="min-h-10 rounded-lg"
                  >
                    <span
                      className="flex min-w-0 flex-1 items-center gap-2"
                      style={searching ? undefined : { paddingLeft: `${depth * 14}px` }}
                    >
                      <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="truncate">{searching ? path : folder.name}</span>
                    </span>
                    {value === folder.id ? <Check className="size-4 text-accent-700 dark:text-accent-300" aria-hidden /> : null}
                  </CommandItem>
                );
              })}
              <CommandItem
                forceMount
                value="__new_folder__"
                onSelect={startCreate}
                className="mt-1 min-h-10 rounded-lg border-t border-border font-medium text-accent-700 dark:text-accent-300"
              >
                <FolderPlus className="size-4" aria-hidden />
                {t('new')}
              </CommandItem>
            </CommandList>
          </Command>
        )}
      </PopoverContent>
    </Popover>
  );
}
