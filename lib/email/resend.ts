import { Resend } from 'resend';
import { emailEnv } from '@/lib/env';

/**
 * Resend email seam (Sprint 3.5C). The whole app talks to email through the small
 * `EmailSender` interface, never the SDK directly, so:
 *   - tests `vi.mock('@/lib/email/resend')` and inject a recording/throwing fake
 *     (no network, no real sends), and
 *   - the document-email action stays decoupled from the Resend SDK shape.
 *
 * The default implementation is built lazily from `emailEnv()` (so missing config
 * surfaces only on the send path, never at import time) and THROWS on a provider
 * error — the SDK returns `{ data, error }` rather than throwing, so we translate
 * an `error` into a thrown error the action catches and maps to `EMAIL_FAILED`.
 * The API key is never logged.
 */

/** One attachment: a generated document's bytes plus its download filename. */
export type EmailAttachment = {
  filename: string;
  content: Buffer;
};

export type SendEmailInput = {
  to: string;
  subject: string;
  html: string;
  attachments: EmailAttachment[];
};

export type SendEmailResult = {
  /** The provider message id, recorded in the audit log after acceptance. */
  id: string;
};

export interface EmailSender {
  send(input: SendEmailInput): Promise<SendEmailResult>;
}

/**
 * Build the production Resend-backed sender. Lazy: `emailEnv()` (and thus the
 * config assertion) runs on the first `send`, not at module load, keeping
 * `next build` / CI green without secrets.
 */
export function getEmailSender(): EmailSender {
  return {
    async send(input: SendEmailInput): Promise<SendEmailResult> {
      const { apiKey, from, replyTo } = emailEnv();
      const resend = new Resend(apiKey);

      const { data, error } = await resend.emails.send({
        from,
        ...(replyTo ? { replyTo } : {}),
        to: input.to,
        subject: input.subject,
        html: input.html,
        attachments: input.attachments.map((a) => ({
          filename: a.filename,
          content: a.content,
        })),
      });

      if (error || !data) {
        // Surface a key-free message; the caller logs it and returns EMAIL_FAILED.
        throw new Error(`Resend send failed: ${error?.message ?? 'no data returned'}`);
      }
      return { id: data.id };
    },
  };
}
