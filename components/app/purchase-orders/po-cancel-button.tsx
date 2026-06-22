'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useActionError } from '@/lib/i18n/use-action-error';
import { cancelPurchaseOrderAction } from '@/app/(app)/purchase-orders/actions';

/** Cancel button for the PO detail page (sent orders). Client island. */
export function PoCancelButton({ id }: { id: string }) {
  const t = useTranslations('purchaseOrders.actions');
  const tCommon = useTranslations('common');
  const actionError = useActionError();
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

  const confirm = () => {
    setOpen(false);
    setError(null);
    startTransition(async () => {
      const result = await cancelPurchaseOrderAction(id);
      if (result.ok) router.refresh();
      else setError(actionError(result.code));
    });
  };

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={pending}
        onClick={() => setOpen(true)}
      >
        {t('cancel')}
      </Button>
      {error && (
        <span role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </span>
      )}
      <ConfirmDialog
        open={open}
        title={t('cancelTitle')}
        description={t('cancelBody')}
        confirmLabel={t('cancel')}
        cancelLabel={tCommon('cancel')}
        destructive
        pending={pending}
        onConfirm={confirm}
        onCancel={() => setOpen(false)}
      />
    </>
  );
}
