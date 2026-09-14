'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { startWorkflow } from '@flows/react';
import { Plus } from 'lucide-react';
import { createRecipeAction } from '@/app/(app)/recipes/actions';
import { useActionError } from '@/lib/i18n/use-action-error';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';

/**
 * Compact "Add recipe" button: asks for a name (and the folder, preselected when
 * opened from inside one), creates the recipe and opens it. The server action
 * enforces the role rules and the plan's recipe cap.
 */
export function AddRecipeButton({
  folders,
  defaultFolderId,
  className,
}: {
  folders: { id: string; name: string }[];
  /** The folder the new recipe is filed into unless the user picks another. */
  defaultFolderId: string | null;
  className?: string;
}) {
  const t = useTranslations('recipes.home');
  const tRecipes = useTranslations('recipes');
  const tFolders = useTranslations('recipes.folders');
  const tCommon = useTranslations('common');
  const actionError = useActionError();
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState('');
  const [folderId, setFolderId] = React.useState(defaultFolderId);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  function start() {
    setName('');
    setFolderId(defaultFolderId);
    setError(null);
    setOpen(true);
  }

  function create() {
    const trimmed = name.trim();
    if (trimmed === '') {
      setError(tRecipes('errors.nameRequired'));
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await createRecipeAction({
        name: trimmed,
        folderId,
        yieldPortions: 1,
        yieldPercentage: 100,
        laborCostCents: 0,
        energyCostCents: 0,
        packagingCostCents: 0,
      });
      if (!result.ok) {
        setError(actionError(result.code));
        return;
      }
      // Best-effort celebratory nudge — never block navigation on Flows.
      void startWorkflow('first-recipe-created').catch(() => undefined);
      router.push(`/recipes/${result.data.id}`);
    });
  }

  return (
    <>
      <Button type="button" onClick={start} className={className}>
        <Plus className="size-4" />
        {t('addRecipe')}
      </Button>
      <ConfirmDialog
        open={open}
        title={t('addRecipe')}
        description={t('addRecipeDescription')}
        confirmLabel={tRecipes('actions.create')}
        cancelLabel={tCommon('cancel')}
        pending={pending}
        onConfirm={create}
        onCancel={() => setOpen(false)}
      >
        <div className="flex flex-col gap-3 pt-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-recipe-name">{tRecipes('newName')}</Label>
            <Input
              id="new-recipe-name"
              autoFocus
              value={name}
              maxLength={200}
              placeholder={tRecipes('placeholders.name')}
              disabled={pending}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  create();
                }
              }}
            />
          </div>
          {folders.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-recipe-folder">{t('folderLabel')}</Label>
              <Select
                id="new-recipe-folder"
                value={folderId ?? ''}
                disabled={pending}
                onChange={(e) => setFolderId(e.target.value === '' ? null : e.target.value)}
              >
                <option value="">{tFolders('noFolder')}</option>
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </Select>
            </div>
          )}
          {error && (
            <p role="alert" className="text-sm text-red-700 dark:text-red-300">
              {error}
            </p>
          )}
        </div>
      </ConfirmDialog>
    </>
  );
}
