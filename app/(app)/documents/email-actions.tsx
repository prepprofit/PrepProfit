'use server';

import { getTranslations } from 'next-intl/server';
import { getOrgId, getUserId, isManager } from '@/lib/auth';
import { getDb, withOrg } from '@/lib/db';
import { writeAuditEvent } from '@/lib/data/audit';
import { enforceRateLimit } from '@/lib/rate-limit';
import { renderDocumentForEmail } from '@/lib/documents/render';
import { getEmailSender } from '@/lib/email/resend';
import { renderEmail } from '@/lib/email/render';
import { emailChrome } from '@/lib/email/chrome';
import { DocumentEmail } from '@/emails/DocumentEmail';
import { logError } from '@/lib/observability';
import {
  documentEmailSchema,
  type DocumentEmailInput,
} from '@/lib/validation/document-email';
import type { ActionResult } from '@/lib/action-result';

/**
 * Email a server-generated document to an allowed recipient (Sprint 3.5C).
 *
 * Manager-only and org-scoped (RULE #1). The client sends ONLY `documentType` +
 * the entity id/period + `recipient` — never PDF bytes, an `organization_id`, or a
 * document URL; the org id is derived from Clerk and the document is regenerated
 * server-side inside `withOrg`, so it can never attach another org's document.
 *
 * Canonical order: RBAC → org/user → rate limit → Zod → render (NOT_FOUND on a
 * foreign/trashed id) → send via the injected/mockable Resend client → audit
 * `document.email` ONLY after the provider accepts. A send/config failure logs the
 * technical detail (never the API key) and returns the stable `EMAIL_FAILED` code,
 * leaving no audit record of a send that did not happen.
 */
export async function emailDocumentAction(
  input: DocumentEmailInput,
): Promise<ActionResult<{ id: string }>> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };

  const organizationId = await getOrgId();
  const userId = await getUserId();

  // Abuse control: dedicated, tighter `documentEmail` bucket, per org+user.
  const limit = await enforceRateLimit(
    getDb(),
    'documentEmail',
    `${organizationId}:${userId}`,
  );
  if (!limit.allowed) return { ok: false, code: 'RATE_LIMITED' };

  const parsed = documentEmailSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const rendered = await renderDocumentForEmail(organizationId, parsed.data);
  if (!rendered) return { ok: false, code: 'NOT_FOUND' };

  const t = await getTranslations('documentEmail');
  const chrome = await emailChrome();
  const subject = t(`subject.${parsed.data.documentType}`, { name: rendered.displayName });
  const { html, text } = await renderEmail(
    <DocumentEmail
      {...chrome}
      preview={subject}
      heading={subject}
      body={t('body', { name: rendered.displayName })}
    />,
  );

  let messageId: string;
  try {
    const result = await getEmailSender().send({
      to: parsed.data.recipient,
      subject,
      html,
      text,
      attachments: [{ filename: rendered.filename, content: rendered.pdf }],
    });
    messageId = result.id;
  } catch (err) {
    // Never log the recipient or the API key — just the failure context.
    logError({ action: 'document.email', orgId: organizationId }, err);
    return { ok: false, code: 'EMAIL_FAILED' };
  }

  // Audit only now that the provider accepted. Metadata is non-PII: the document
  // type and the provider message id — never the recipient, amounts, or names.
  await withOrg(organizationId, (tx) =>
    writeAuditEvent(
      tx,
      organizationId,
      { userId, role: 'manager', requestId: crypto.randomUUID() },
      {
        action: 'document.email',
        entityType: rendered.entityType,
        entityId: rendered.entityId,
        metadata: { documentType: parsed.data.documentType, providerMessageId: messageId },
      },
    ),
  );

  return { ok: true, data: { id: messageId } };
}
