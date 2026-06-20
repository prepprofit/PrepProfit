import { getTranslations } from 'next-intl/server';
import type { EmailSender } from './resend';

/**
 * Lifecycle notification emails (Sprint 5d). Best-effort, non-critical messages —
 * a welcome on org creation and a low-stock digest from the daily cron. They reuse
 * the same injectable `EmailSender` seam as the document email (Sprint 3.5C), so
 * tests inject a recording fake and nothing is ever really sent. Copy lives in the
 * `notifications` i18n namespace (English-only for now); the app is English-only,
 * and server contexts here have no request locale, so we resolve `en` explicitly.
 *
 * Call sites guard with `isEmailConfigured()` (lib/env.ts) and wrap in try/catch:
 * a missing provider or a send failure must never break a webhook or the cron job.
 */

/** Canonical unit suffix per ingredient dimension, for the low-stock digest lines. */
const UNIT_SUFFIX: Record<string, string> = {
  weight: ' g',
  volume: ' ml',
  count: '',
};

export type LowStockLineItem = {
  name: string;
  stockCanonical: number;
  thresholdCanonical: number;
  dimension: string;
};

/**
 * One human line per low-stock ingredient, e.g. "Butter — 200 g left (threshold
 * 500 g)". Pure and unit-tested; the HTML builder maps these into `<li>`s.
 */
export function lowStockSummaryLines(items: LowStockLineItem[]): string[] {
  return items.map((i) => {
    const suffix = UNIT_SUFFIX[i.dimension] ?? '';
    return `${i.name} — ${i.stockCanonical}${suffix} left (threshold ${i.thresholdCanonical}${suffix})`;
  });
}

/** Escape the few characters that matter when interpolating text into HTML. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Welcome email sent when a new organization is created (wired into the
 * `organization.created` Clerk webhook). `to` is the creating admin's email.
 */
export async function sendWelcomeEmail(
  sender: EmailSender,
  params: { to: string; orgName: string },
): Promise<void> {
  const t = await getTranslations({ locale: 'en', namespace: 'notifications' });
  const html = `<p>${escapeHtml(
    t('welcome.body', { org: params.orgName }),
  )}</p>`;
  await sender.send({
    to: params.to,
    subject: t('welcome.subject', { org: params.orgName }),
    html,
    attachments: [],
  });
}

/**
 * Low-stock digest emailed by the daily cron when an org has ingredients at/below
 * their threshold. `to` is the org's billing/business email (settings). The body
 * lists the depleted ingredients; no money, no PII.
 */
export async function sendLowStockEmail(
  sender: EmailSender,
  params: { to: string; orgName: string; items: LowStockLineItem[] },
): Promise<void> {
  const t = await getTranslations({ locale: 'en', namespace: 'notifications' });
  const lines = lowStockSummaryLines(params.items);
  const list = lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('');
  const html = `<p>${escapeHtml(
    t('lowStock.body', { org: params.orgName, count: params.items.length }),
  )}</p><ul>${list}</ul>`;
  await sender.send({
    to: params.to,
    subject: t('lowStock.subject', { count: params.items.length }),
    html,
    attachments: [],
  });
}
