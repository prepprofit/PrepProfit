import { getTranslations } from 'next-intl/server';
import type { EmailSender } from './resend';
import { renderEmail } from './render';
import { emailChrome } from './chrome';
import { emailAppUrl } from '@/lib/env';
import { WelcomeEmail } from '@/emails/WelcomeEmail';
import { SubscriptionEmail } from '@/emails/SubscriptionEmail';
import { PaymentPastDueEmail } from '@/emails/PaymentPastDueEmail';
import { LowStockEmail } from '@/emails/LowStockEmail';

/**
 * Lifecycle notification emails (Sprint 5d; React Email migration). Best-effort,
 * non-critical messages — a welcome on org creation, billing lifecycle notices, and
 * a low-stock digest from the daily cron. They reuse the same injectable
 * `EmailSender` seam as the document email, so tests inject a recording fake and
 * nothing is ever really sent. Copy lives in the `notifications`/`email` i18n
 * namespaces; the app is English-only and these server contexts have no request
 * locale, so we resolve `en` explicitly.
 *
 * Bodies are now React Email templates rendered to `{ html, text }` via
 * {@link renderEmail}; there is NO raw HTML string assembly and no `escapeHtml`
 * helper — React escapes every interpolated value. A CTA is included only when
 * {@link emailAppUrl} resolves an absolute app URL (never load-bearing).
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
 * 500 g)". Pure and unit-tested; the template renders these as escaped text nodes.
 */
export function lowStockSummaryLines(items: LowStockLineItem[]): string[] {
  return items.map((i) => {
    const suffix = UNIT_SUFFIX[i.dimension] ?? '';
    return `${i.name} — ${i.stockCanonical}${suffix} left (threshold ${i.thresholdCanonical}${suffix})`;
  });
}

/** Build an absolute CTA `{ href, label }` when `APP_URL` is set, else undefined. */
async function appCta(
  path: string,
  label: string,
): Promise<{ href: string; label: string } | undefined> {
  const base = emailAppUrl();
  return base ? { href: `${base}${path}`, label } : undefined;
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
  const tEmail = await getTranslations({ locale: 'en', namespace: 'email' });
  const chrome = await emailChrome();
  const subject = t('welcome.subject', { org: params.orgName });
  const { html, text } = await renderEmail(
    <WelcomeEmail
      {...chrome}
      preview={subject}
      heading={subject}
      body={t('welcome.body', { org: params.orgName })}
      cta={await appCta('/dashboard', tEmail('cta.openDashboard'))}
    />,
  );
  await sender.send({ to: params.to, subject, html, text, attachments: [] });
}

/** Which billing transition the email announces. */
export type SubscriptionEmailKind = 'subscribed' | 'upgraded' | 'downgraded';

/**
 * Billing lifecycle email sent from the Clerk billing webhook when an org's plan
 * changes (subscribed / upgraded / downgraded). `to` is the org's billing email.
 * `planLabel` is the already-localized plan name. Deliberately money-free and
 * PII-free: it names the plan and points to the billing page, nothing more.
 */
export async function sendSubscriptionEmail(
  sender: EmailSender,
  params: {
    to: string;
    orgName: string;
    planLabel: string;
    kind: SubscriptionEmailKind;
    idempotencyKey?: string;
  },
): Promise<void> {
  const t = await getTranslations({ locale: 'en', namespace: 'notifications' });
  const tEmail = await getTranslations({ locale: 'en', namespace: 'email' });
  const chrome = await emailChrome();
  const subject = t(`subscription.${params.kind}.subject`, { plan: params.planLabel });
  const { html, text } = await renderEmail(
    <SubscriptionEmail
      {...chrome}
      preview={subject}
      heading={subject}
      body={t(`subscription.${params.kind}.body`, {
        org: params.orgName,
        plan: params.planLabel,
      })}
      cta={await appCta('/billing', tEmail('cta.manageBilling'))}
    />,
  );
  await sender.send({
    to: params.to,
    subject,
    html,
    text,
    attachments: [],
    ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
  });
}

/**
 * Dunning email sent when a subscription goes past due (a payment failed). Asks
 * the org to update its payment method on the billing page. No card data, no
 * amounts — just an actionable nudge.
 */
export async function sendPaymentPastDueEmail(
  sender: EmailSender,
  params: {
    to: string;
    orgName: string;
    planLabel: string;
    idempotencyKey?: string;
  },
): Promise<void> {
  const t = await getTranslations({ locale: 'en', namespace: 'notifications' });
  const tEmail = await getTranslations({ locale: 'en', namespace: 'email' });
  const chrome = await emailChrome();
  const subject = t('pastDue.subject');
  const { html, text } = await renderEmail(
    <PaymentPastDueEmail
      {...chrome}
      preview={subject}
      heading={subject}
      body={t('pastDue.body', { org: params.orgName, plan: params.planLabel })}
      cta={await appCta('/billing', tEmail('cta.manageBilling'))}
    />,
  );
  await sender.send({
    to: params.to,
    subject,
    html,
    text,
    attachments: [],
    ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
  });
}

/**
 * Reverse-trial ending reminder, sent by the daily trial-reminder cron on the single
 * day an org's 14-day full-access trial is {@link TRIAL_REMINDER_DAYS_BEFORE} days
 * from expiry AND it has not subscribed. `to` is the org's business email (settings)
 * or its admin's email. Money-free and PII-free: it names the days left and points to
 * the pricing page. `idempotencyKey` (org + trial deadline) blocks a same-day resend.
 */
export async function sendTrialEndingEmail(
  sender: EmailSender,
  params: { to: string; orgName: string; daysLeft: number; idempotencyKey: string },
): Promise<void> {
  const t = await getTranslations({ locale: 'en', namespace: 'notifications' });
  const tEmail = await getTranslations({ locale: 'en', namespace: 'email' });
  const chrome = await emailChrome();
  const subject = t('trialEnding.subject', { days: params.daysLeft });
  const { html, text } = await renderEmail(
    <SubscriptionEmail
      {...chrome}
      preview={subject}
      heading={subject}
      body={t('trialEnding.body', { org: params.orgName, days: params.daysLeft })}
      cta={await appCta('/pricing', tEmail('cta.viewPlans'))}
    />,
  );
  await sender.send({
    to: params.to,
    subject,
    html,
    text,
    attachments: [],
    idempotencyKey: params.idempotencyKey,
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
  const tEmail = await getTranslations({ locale: 'en', namespace: 'email' });
  const chrome = await emailChrome();
  const subject = t('lowStock.subject', { count: params.items.length });
  const { html, text } = await renderEmail(
    <LowStockEmail
      {...chrome}
      preview={subject}
      heading={subject}
      intro={t('lowStock.body', { org: params.orgName, count: params.items.length })}
      items={lowStockSummaryLines(params.items)}
      cta={await appCta('/inventory', tEmail('cta.reviewStock'))}
    />,
  );
  await sender.send({ to: params.to, subject, html, text, attachments: [] });
}
