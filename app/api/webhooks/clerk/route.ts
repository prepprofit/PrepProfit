import { verifyWebhook } from '@clerk/nextjs/webhooks';
import { clerkClient } from '@clerk/nextjs/server';
import type { NextRequest } from 'next/server';
import { withOrg } from '@/lib/db';
import { isEmailConfigured } from '@/lib/env';
import { getEmailSender } from '@/lib/email/resend';
import { sendWelcomeEmail } from '@/lib/email/notifications';
import { writeAuditEvent, type AuditActor } from '@/lib/data/audit';
import { ensureOrgSettingsRow } from '@/lib/data/org-settings';
import { ensureDefaultArea } from '@/lib/data/storage-areas';
import { ensureCategoriesSeeded } from '@/lib/data/transaction-categories';
import {
  resolveCurrentPeriodEnd,
  resolvePlanTier,
  upsertSubscriptionMirror,
  type SubscriptionItemInput,
} from '@/lib/data/subscriptions';
import { logError } from '@/lib/observability';

/**
 * Clerk webhook endpoint (Sprint 4c). Receives billing + org-lifecycle events and
 * keeps the per-org `subscriptions` MIRROR in sync, plus an audit trail.
 *
 * Clerk Billing is backed by Stripe but Clerk re-emits the billing events itself,
 * so this single verified endpoint covers "Clerk/Stripe" — there is no separate
 * Stripe webhook. We listen to `subscription.*` (which embed their items), not the
 * finer-grained `subscriptionItem.*`, plus `organization.deleted/.updated` and
 * `organizationMembership.*`.
 *
 * SECURITY / SAFETY:
 *  - Every request is signature-verified with `verifyWebhook` (reads
 *    CLERK_WEBHOOK_SIGNING_SECRET); a bad/forged signature → 400, no DB touch.
 *  - The org id comes ONLY from the VERIFIED payload, never the client, and all
 *    writes run inside `withOrg(orgId)` so RLS stays active (cron-purge pattern).
 *  - The mirror never gates access (entitlements read Clerk live, fail-closed), so
 *    a lapse/delete here only records state — it NEVER deletes tenant data.
 *  - Verified-but-unexpected failures return 500 so Svix retries; verified no-op
 *    events return 200.
 *
 * Must be a public route (middleware.ts) — there is no Clerk session here.
 */

// neon-serverless Pool (WebSocket) + node:crypto require the Node runtime, never
// Edge; force-dynamic so the POST is never cached.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Active-ish subscription statuses are written as-is; this is just for display. */
function buildActor(requestId: string): AuditActor {
  // Clerk delivers webhooks — there is no logged-in user → the `system` actor.
  return { userId: null, role: 'system', requestId };
}

export async function POST(req: NextRequest): Promise<Response> {
  let evt;
  try {
    evt = await verifyWebhook(req);
  } catch (err) {
    // Spoofed / malformed signature, or the signing secret is unset. Never 5xx
    // here — that would make Svix retry an unverifiable request forever.
    logError({ action: 'clerkWebhook.verify' }, err);
    return new Response('Webhook verification failed', { status: 400 });
  }

  // Correlate retries of the same delivery (Svix resends with a stable svix-id).
  const requestId = req.headers.get('svix-id') ?? crypto.randomUUID();
  const actor = buildActor(requestId);

  try {
    // ---- Billing: subscription lifecycle (org-payer subscriptions only) -----
    if (
      evt.type === 'subscription.created' ||
      evt.type === 'subscription.updated' ||
      evt.type === 'subscription.active' ||
      evt.type === 'subscription.pastDue'
    ) {
      const orgId = evt.data.payer?.organization_id;
      // User-payer subscriptions don't map to a tenant — acknowledge & ignore.
      if (!orgId) return new Response('OK', { status: 200 });

      const items: SubscriptionItemInput[] = (evt.data.items ?? []).map(
        (item) => ({
          status: item.status,
          planSlug: item.plan?.slug ?? null,
          periodEnd: item.period_end ?? null,
        }),
      );
      const plan = resolvePlanTier(items);
      const currentPeriodEnd = resolveCurrentPeriodEnd(items);
      const eventAt = new Date(evt.data.updated_at);

      await withOrg(orgId, async (tx) => {
        await upsertSubscriptionMirror(tx, orgId, {
          plan,
          status: evt.data.status,
          clerkSubscriptionId: evt.data.id,
          currentPeriodEnd,
          eventType: evt.type,
          eventAt,
        });
        await writeAuditEvent(tx, orgId, actor, {
          // past_due is the only downgrade signal among these → 'lapse'.
          action:
            evt.type === 'subscription.pastDue'
              ? 'subscription.lapse'
              : 'subscription.update',
          entityType: 'subscription',
          entityId: evt.data.id,
          metadata: { eventType: evt.type, plan, status: evt.data.status },
        });
      });
      return new Response('OK', { status: 200 });
    }

    // ---- Org created: prime tenant defaults (Sprint 4d) ---------------------
    // Seed the predefined transaction categories and a settings row eagerly the
    // moment an org is provisioned, so a new manager starts with a primed tenant.
    // Both writes are idempotent (lazy seeding remains the safety net if this
    // endpoint is unconfigured), and the onboarding flow itself is gated by the
    // app, not by this event.
    if (evt.type === 'organization.created') {
      const orgId = evt.data.id;
      if (!orgId) return new Response('OK', { status: 200 });
      await withOrg(orgId, async (tx) => {
        await ensureCategoriesSeeded(tx, orgId);
        await ensureOrgSettingsRow(tx, orgId);
        // Seed the immutable "Main" default storage area (Sprint 12c) so the org always
        // has a concrete default to show + transfer into.
        await ensureDefaultArea(tx, orgId);
        await writeAuditEvent(tx, orgId, actor, {
          action: 'organization.create',
          entityType: 'organization',
          entityId: orgId,
          metadata: { eventType: evt.type },
        });
      });

      // Best-effort welcome email (Sprint 5d) to the creating admin. Guarded by
      // `isEmailConfigured` so an unconfigured environment skips QUIETLY, and fully
      // try/caught so a Clerk/user-lookup or send failure never 500s the webhook
      // (which would make Svix retry a delivery that already seeded the tenant).
      if (isEmailConfigured()) {
        try {
          const createdBy = evt.data.created_by;
          if (createdBy) {
            const user = await (await clerkClient()).users.getUser(createdBy);
            const to = user.primaryEmailAddress?.emailAddress;
            if (to) {
              await sendWelcomeEmail(getEmailSender(), {
                to,
                orgName: evt.data.name ?? 'your organization',
              });
            }
          }
        } catch (err) {
          logError({ action: 'clerkWebhook.welcomeEmail' }, err);
        }
      }
      return new Response('OK', { status: 200 });
    }

    // ---- Org deleted: lapse the mirror, never delete tenant data ------------
    if (evt.type === 'organization.deleted') {
      const orgId = evt.data.id;
      if (!orgId) return new Response('OK', { status: 200 });
      const now = new Date();
      await withOrg(orgId, async (tx) => {
        await upsertSubscriptionMirror(tx, orgId, {
          plan: 'starter',
          status: 'canceled',
          clerkSubscriptionId: null,
          currentPeriodEnd: null,
          eventType: evt.type,
          eventAt: now,
        });
        await writeAuditEvent(tx, orgId, actor, {
          action: 'subscription.lapse',
          entityType: 'organization',
          entityId: orgId,
          metadata: { eventType: evt.type },
        });
      });
      return new Response('OK', { status: 200 });
    }

    // ---- Org updated: lifecycle visibility (audit only) ---------------------
    if (evt.type === 'organization.updated') {
      const orgId = evt.data.id;
      if (orgId) {
        await withOrg(orgId, (tx) =>
          writeAuditEvent(tx, orgId, actor, {
            action: 'organization.update',
            entityType: 'organization',
            entityId: orgId,
            metadata: { eventType: evt.type },
          }),
        );
      }
      return new Response('OK', { status: 200 });
    }

    // ---- Membership lifecycle: seat visibility (audit only) -----------------
    if (
      evt.type === 'organizationMembership.created' ||
      evt.type === 'organizationMembership.updated' ||
      evt.type === 'organizationMembership.deleted'
    ) {
      const orgId = evt.data.organization?.id;
      if (orgId) {
        await withOrg(orgId, (tx) =>
          writeAuditEvent(tx, orgId, actor, {
            action: 'organization.membership',
            entityType: 'organizationMembership',
            entityId: evt.data.public_user_data?.user_id ?? null,
            metadata: { eventType: evt.type, role: evt.data.role },
          }),
        );
      }
      return new Response('OK', { status: 200 });
    }

    // Any other verified event: acknowledge so Svix does not retry.
    return new Response('OK', { status: 200 });
  } catch (err) {
    // Verified but processing failed (e.g. transient DB error). Return 500 so
    // Svix retries the delivery on its schedule.
    logError({ action: `clerkWebhook:${evt.type}` }, err);
    return new Response('Webhook processing failed', { status: 500 });
  }
}
