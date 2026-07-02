import { NextResponse } from 'next/server';
import { clerkClient } from '@clerk/nextjs/server';
import { getDb, withOrg } from '@/lib/db';
import { getOrgSettingsRow } from '@/lib/data/org-settings';
import { resolveSystemJobTier } from '@/lib/data/system-entitlements';
import {
  isTrialReminderDue,
  parseTrialEndsAt,
  trialReminderDaysLeft,
} from '@/lib/entitlements';
import { sendTrialEndingEmail } from '@/lib/email/notifications';
import { getEmailSender } from '@/lib/email/resend';
import { isCronAuthorized } from '@/lib/cron-auth';
import { enforceRateLimit } from '@/lib/rate-limit';
import { serverEnv, isEmailConfigured } from '@/lib/env';
import { logError } from '@/lib/observability';

// neon-serverless Pool needs Node; recompute the sweep fresh each run.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 100;

/**
 * Reverse-trial ending reminder cron (pricing 4-tier plan, Slice 6). Once a day it
 * walks every Clerk organization and, for each org whose 14-day full-access trial is
 * exactly TRIAL_REMINDER_DAYS_BEFORE days from expiry AND that has NOT subscribed,
 * sends one "your trial ends soon" email pointing at the pricing page.
 *
 * Authenticated by CRON_SECRET (Vercel Cron), NOT a user session — excluded from
 * Clerk in middleware.ts. RULE #1 preserved: the tier resolution + settings read run
 * inside that org's own `withOrg` (RLS active); there is NO cross-tenant query.
 *
 * Storage-free by design (Decision B): the trial deadline is read straight from the
 * Clerk org's `public_metadata.trial_ends_at` — no DB mirror, no migration. Idempotent
 * WITHOUT a durable row: the reminder fires on the SINGLE UTC calendar day the trial
 * is N days out, and the send carries a Resend idempotency key
 * (`trial_reminder:<org>:<trialEnd>`) so a same-day retry never double-sends.
 */
export async function GET(req: Request): Promise<NextResponse> {
  const authHeader = req.headers.get('authorization');
  if (!isCronAuthorized(authHeader, serverEnv().CRON_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const limit = await enforceRateLimit(getDb(), 'trialReminder', authHeader ?? '');
  if (!limit.allowed) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  }

  // No email provider configured → nothing to send (keeps build/CI green without keys
  // and lets the feature stay dormant until email is set up).
  if (!isEmailConfigured()) {
    return NextResponse.json({ ok: true, skipped: 'email-not-configured' });
  }

  const now = new Date();
  const sender = getEmailSender();
  const client = await clerkClient();

  let offset = 0;
  let reminded = 0;

  for (;;) {
    const { data, totalCount } = await client.organizations.getOrganizationList({
      limit: PAGE_SIZE,
      offset,
    });
    if (data.length === 0) break;

    for (const org of data) {
      try {
        const trialEndsAt = parseTrialEndsAt(
          (org.publicMetadata as Record<string, unknown> | undefined)?.trial_ends_at,
        );
        // Only the single day the trial is exactly N days out.
        if (!isTrialReminderDue(trialEndsAt, now)) continue;

        // Skip orgs that already picked a plan (or are comped) — the mirror resolves a
        // non-starter tier — and read the org's business email, all in one RLS tx. A
        // `null` result means "subscribed, skip"; a present object carries the (maybe
        // empty) business email of a still-trialing starter org.
        const trialing = await withOrg(org.id, async (tx) => {
          const tier = await resolveSystemJobTier(tx, org.id);
          if (tier !== 'starter') return null;
          const settings = await getOrgSettingsRow(tx, org.id);
          return { email: settings?.businessEmail ?? null };
        });
        if (!trialing) continue;

        // Business email if set, else the org's admin (a new trial org often has no
        // business email yet). Only looked up for the few orgs in the window.
        const to = trialing.email || (await resolveOrgAdminEmail(org.id));
        if (!to) continue;

        await sendTrialEndingEmail(sender, {
          to,
          orgName: org.name ?? 'your organization',
          daysLeft: trialReminderDaysLeft(trialEndsAt!, now),
          idempotencyKey: `trial_reminder:${org.id}:${trialEndsAt!.toISOString()}`,
        });
        reminded += 1;
      } catch (err) {
        logError({ action: 'cron.trialReminder', orgId: org.id }, err);
      }
    }

    offset += data.length;
    if (offset >= totalCount) break;
  }

  return NextResponse.json({ ok: true, reminded });
}

/**
 * Best-effort admin email for an org via Clerk, used only when the org has no business
 * email set. Prefers the first admin's identifier, falling back to a user lookup.
 * Returns null when none can be resolved (the caller then skips quietly).
 */
async function resolveOrgAdminEmail(organizationId: string): Promise<string | null> {
  const client = await clerkClient();
  const members = await client.organizations.getOrganizationMembershipList({
    organizationId,
    limit: 20,
  });
  const admin = members.data.find((m) => m.role === 'org:admin');
  const identifier = admin?.publicUserData?.identifier;
  if (identifier?.includes('@')) return identifier;
  if (admin?.publicUserData?.userId) {
    const user = await client.users.getUser(admin.publicUserData.userId);
    return user.primaryEmailAddress?.emailAddress ?? null;
  }
  return null;
}
