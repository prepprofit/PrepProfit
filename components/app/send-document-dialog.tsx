'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Mail } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useActionError } from '@/lib/i18n/use-action-error';
import { emailDocumentAction } from '@/app/(app)/documents/email-actions';

/**
 * "Send by email" control for a generated document (Sprint 3.5C). Reuses
 * `ConfirmDialog` (native modal: focus trap, Escape, backdrop) and owns the
 * recipient field. The client passes ONLY the document identity + recipient — the
 * server derives the org, regenerates the PDF, and attaches it. Errors surface as
 * localized `ActionErrorCode` messages via `useActionError`.
 */
type DocPayload =
  | { documentType: 'invoice'; invoiceId: string }
  | { documentType: 'recipeCard'; recipeId: string }
  | { documentType: 'pl'; view: 'month' | 'year'; period?: string };

export function SendDocumentDialog({
  doc,
  defaultRecipient,
}: {
  doc: DocPayload;
  defaultRecipient?: string | null;
}) {
  const t = useTranslations('documentEmail');
  const actionError = useActionError();

  const [open, setOpen] = React.useState(false);
  const [recipient, setRecipient] = React.useState(defaultRecipient ?? '');
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [sent, setSent] = React.useState(false);
  const inputId = React.useId();

  function openDialog() {
    setRecipient(defaultRecipient ?? '');
    setError(null);
    setSent(false);
    setOpen(true);
  }

  async function onConfirm() {
    setPending(true);
    setError(null);
    const result = await emailDocumentAction({ ...doc, recipient: recipient.trim() });
    setPending(false);
    if (result.ok) {
      setSent(true);
      setOpen(false);
    } else {
      setError(actionError(result.code));
    }
  }

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={openDialog}>
        <Mail className="size-4" />
        {t('trigger')}
      </Button>
      {sent && (
        <span className="text-sm text-muted-foreground" role="status">
          {t('sent')}
        </span>
      )}
      <ConfirmDialog
        open={open}
        title={t('title')}
        description={t('description')}
        confirmLabel={pending ? t('sending') : t('send')}
        cancelLabel={t('cancel')}
        pending={pending}
        onConfirm={onConfirm}
        onCancel={() => setOpen(false)}
      >
        <div className="mt-2 flex flex-col gap-1.5">
          <Label htmlFor={inputId}>{t('recipient')}</Label>
          <Input
            id={inputId}
            type="email"
            value={recipient}
            placeholder={t('recipientPlaceholder')}
            onChange={(e) => setRecipient(e.target.value)}
            disabled={pending}
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
      </ConfirmDialog>
    </>
  );
}
