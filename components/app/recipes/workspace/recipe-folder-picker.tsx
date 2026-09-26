'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Folder } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useActionError } from '@/lib/i18n/use-action-error';
import { MoveToFolderDialog } from '@/components/app/shared/folders/move-to-folder-dialog';
import { folderLabel, type FolderTreeNode } from '@/lib/folders/tree';
import { moveRecipeToFolderAction } from '@/app/(app)/recipes/folder-actions';

/**
 * The compact "beneath the name" folder control the redesigned workspace header
 * needs — a small button naming the current folder that opens the existing
 * recipe move dialog/action, so filing a recipe never requires leaving this page.
 */
export function RecipeFolderPicker({
  recipeId,
  recipeName,
  folderId,
  folders,
}: {
  recipeId: string;
  recipeName: string;
  folderId: string | null;
  folders: readonly FolderTreeNode[];
}) {
  const t = useTranslations('recipes.folders');
  const tCommon = useTranslations('common');
  const actionError = useActionError();
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

  const currentName = folderId ? folderLabel(folders, folderId) || t('noFolder') : t('noFolder');

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
        onClick={() => setOpen(true)}
      >
        <Folder className="size-3.5" aria-hidden />
        {currentName}
      </Button>
      {error ? <p className="text-xs text-red-700 dark:text-red-300">{error}</p> : null}
      <MoveToFolderDialog
        open={open}
        folders={folders}
        folderId={null}
        pending={pending}
        labels={{
          title: t('moveRecipeDialog.title'),
          description: t('moveRecipeDialog.description', { name: recipeName }),
          searchPlaceholder: t('moveDialog.search'),
          topLevel: t('noFolder'),
          moveLabel: t('moveDialog.move'),
          cancelLabel: tCommon('cancel'),
          noResults: t('moveDialog.empty'),
          empty: t('moveRecipeDialog.empty'),
        }}
        onMove={(newFolderId) => {
          setError(null);
          startTransition(async () => {
            const result = await moveRecipeToFolderAction(recipeId, { folderId: newFolderId });
            if (!result.ok) {
              setError(actionError(result.code));
              return;
            }
            setOpen(false);
            router.refresh();
          });
        }}
        onCancel={() => setOpen(false)}
      />
    </>
  );
}
