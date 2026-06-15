'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import type { ActionErrorCode } from '@/lib/action-result';

/**
 * Maps a Server-Action `ActionErrorCode` to a localized message, so client
 * components show translated errors instead of the raw code (CLAUDE.md: "UI
 * strings always via next-intl"). Pair with the `actionErrors.<code>` block in
 * the message catalogue.
 *
 *   const actionError = useActionError();
 *   if (!result.ok) setError(actionError(result.code));
 */
export function useActionError(): (code: ActionErrorCode) => string {
  const t = useTranslations('actionErrors');
  return useCallback((code: ActionErrorCode) => t(code), [t]);
}
