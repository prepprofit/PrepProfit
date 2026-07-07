'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { useActionError } from '@/lib/i18n/use-action-error';
import { openConsentBanner } from '@/lib/consent';
import {
  requestAccountDeletionAction,
  cancelAccountDeletionAction,
} from './account-actions';

export type AccountPrivacyProps = {
  /** ISO date the org requested deletion, or null when none is pending. */
  deletionRequestedAt: string | null;
};

/**
 * Data & privacy controls (Sprint 5e): export the org's data (GDPR portability) and
 * request/cancel account deletion (GDPR erasure). The export is a plain authenticated
 * download link to the manager-only route. Deletion only RECORDS the request — an
 * operator fulfils it — so the copy is explicit that nothing is erased instantly.
 */
export function AccountPrivacy({ deletionRequestedAt }: AccountPrivacyProps) {
  const t = useTranslations('settings.privacy');
  const actionError = useActionError();

  const [requestState, requestAction, requestPending] = useActionState(
    requestAccountDeletionAction,
    null,
  );
  const [cancelState, cancelAction, cancelPending] = useActionState(
    cancelAccountDeletionAction,
    null,
  );

  const pendingDeletion = deletionRequestedAt !== null;
  const requestedLabel = deletionRequestedAt
    ? new Date(deletionRequestedAt).toLocaleDateString()
    : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {/* Data export (GDPR portability / access) */}
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium text-foreground">
            {t('export.title')}
          </h3>
          <p className="text-xs text-muted-foreground">{t('export.help')}</p>
          <div>
            <Button asChild variant="outline">
              <a href="/api/account/export" download>
                {t('export.action')}
              </a>
            </Button>
          </div>
        </div>

        {/* Cookie consent (GDPR withdrawal must be as easy as granting) */}
        <div className="flex flex-col gap-2 border-t border-border pt-6">
          <h3 className="text-sm font-medium text-foreground">
            {t('cookies.title')}
          </h3>
          <p className="text-xs text-muted-foreground">{t('cookies.help')}</p>
          <div>
            <Button variant="outline" onClick={openConsentBanner}>
              {t('cookies.action')}
            </Button>
          </div>
        </div>

        {/* Account deletion (GDPR erasure) request */}
        <div className="flex flex-col gap-2 border-t border-border pt-6">
          <h3 className="text-sm font-medium text-foreground">
            {t('delete.title')}
          </h3>
          <p className="text-xs text-muted-foreground">{t('delete.help')}</p>

          {pendingDeletion ? (
            <form action={cancelAction} className="mt-2 flex flex-col gap-3">
              <p
                className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200"
                role="status"
              >
                {requestedLabel
                  ? t('delete.pendingSince', { date: requestedLabel })
                  : t('delete.pending')}
              </p>
              {cancelState && !cancelState.ok && (
                <p className="text-sm text-destructive" role="alert">
                  {actionError(cancelState.code)}
                </p>
              )}
              <div>
                <Button type="submit" variant="outline" disabled={cancelPending}>
                  {t('delete.cancelAction')}
                </Button>
              </div>
            </form>
          ) : (
            <form action={requestAction} className="mt-2 flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="deletionReason">{t('delete.reasonLabel')}</Label>
                <Textarea
                  id="deletionReason"
                  name="reason"
                  rows={3}
                  maxLength={2000}
                  placeholder={t('delete.reasonPlaceholder')}
                />
              </div>
              {requestState && !requestState.ok && (
                <p className="text-sm text-destructive" role="alert">
                  {actionError(requestState.code)}
                </p>
              )}
              <div>
                <Button type="submit" variant="destructive" disabled={requestPending}>
                  {t('delete.requestAction')}
                </Button>
              </div>
            </form>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
