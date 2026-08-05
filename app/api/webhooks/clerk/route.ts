import { verifyWebhook } from '@clerk/nextjs/webhooks';
import { clerkClient } from '@clerk/nextjs/server';
import { getTranslations } from 'next-intl/server';
import type { NextRequest } from 'next/server';
import { withOrg } from '@/lib/db';
import { isEmailConfigured } from '@/lib/env';
import { getEmailSender } from '@/lib/email/resend';
import {
  sendWelcomeEmail,
  sendSubscriptionEmail,
  sendPaymentPastDueEmail,
} from '@/lib/email/notifications';
import { writeAuditEvent, type AuditActor } from '@/lib/data/audit';
import {
  ensureOrgSettingsRow,
  getOrgSettingsRow,
  markOnboarded,
} from '@/lib/data/org-settings';
import { ensureDefaultArea } from '@/lib/data/storage-areas';
import { ensureCategoriesSeeded } from '@/lib/data/transaction-categories';
import { ensureVatCategories } from '@/lib/data/vat-categories';
import {
  classifyPlanChange,
  getMirroredPlan,
  resolveCurrentPeriodEnd,
  resolvePlanTier,
  upsertSubscriptionMirror,
  type SubscriptionItemInput,
} from '@/lib/data/subscriptions';
import { logError } from '@/lib/observability';
import { clerkSeatLimit, computeTrialEndsAt } from '@/lib/entitlements';

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

/**
 * Best-effort billing recipient + display name for an org. Prefers the org's own
 * billing email (settings); falls back to the org's first admin via Clerk. Used
 * only for notification copy, off the verified org id. Returns `to: null` when no
 * address can be resolved (the caller then skips quietly).
 */
async function resolveOrgBilling(
  organizationId: string,
  businessEmail: string | null,
  businessName: string | null,
): Promise<{ to: string | null; orgName: string }> {
  let to = businessEmail?.trim() || null;
  let orgName = businessName?.trim() || null;

  if (!to || !orgName) {
    const client = await clerkClient();
    if (!orgName) {
      const org = await client.organizations.getOrganization({ organizationId });
      orgName = org.name ?? null;
    }
    if (!to) {
      const members = await client.organizations.getOrganizationMembershipList({
        organizationId,
        limit: 20,
      });
      const admin = members.data.find((m) => m.role === 'org:admin');
      const identifier = admin?.publicUserData?.identifier;
      to = identifier?.includes('@') ? identifier : null;
      if (!to && admin?.publicUserData?.userId) {
        const user = await client.users.getUser(admin.publicUserData.userId);
        to = user.primaryEmailAddress?.emailAddress ?? null;
      }
    }
  }

  return { to, orgName: orgName ?? 'your organization' };
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

      // Read the previously-mirrored plan + billing identity in the SAME tx, before
      // the upsert, so the email below can classify upgrade vs downgrade.
      const { oldPlan, businessEmail, businessName } = await withOrg(
        orgId,
        async (tx) => {
          const prior = await getMirroredPlan(tx, orgId);
          const settings = await getOrgSettingsRow(tx, orgId);
          await upsertSubscriptionMirror(tx, orgId, {
            plan,
            status: evt.data.status,
            clerkSubscriptionId: evt.data.id,
            currentPeriodEnd,
            eventType: evt.type,
            eventAt,
          });
          // A paid subscription means the manager passed the onboarding plan step
          // (the in-onboarding <PricingTable> checkout navigates away and back,
          // resetting the ephemeral stepper — see onboarding-stepper.tsx). Without
          // this they'd never reach "Finish" and the /dashboard gate would bounce
          // them to /onboarding forever. `markOnboarded` is set-once + idempotent,
          // so this is a harmless no-op for an already-onboarded org and never
          // fires for a free (`starter`) org.
          if (plan !== 'starter') {
            await markOnboarded(tx, orgId);
          }
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
          return {
            oldPlan: prior,
            businessEmail: settings?.businessEmail ?? null,
            businessName: settings?.businessName ?? null,
          };
        },
      );

      // Sync the org's Clerk seat cap to its resolved plan so Clerk itself blocks
      // over-cap invites (Pro = 5, Business = unlimited; a cancellation back to
      // starter clamps to 1 — Clerk keeps existing members, only blocks NEW ones).
      // Best-effort like the billing email: a failure here must never 5xx the
      // webhook (which would retry the whole delivery); the next event re-syncs.
      try {
        await (await clerkClient()).organizations.updateOrganization(orgId, {
          maxAllowedMemberships: clerkSeatLimit(plan),
        });
      } catch (err) {
        logError({ action: 'clerkWebhook.seatSync', orgId }, err);
      }

      // Best-effort billing email (mirrors the welcome-email guard): never let a
      // send/lookup failure 5xx the webhook, which would make Svix retry the whole
      // delivery. `idempotencyKey` = svix-id so a retry never double-sends.
      if (isEmailConfigured()) {
        try {
          const { to, orgName } = await resolveOrgBilling(
            orgId,
            businessEmail,
            businessName,
          );
          if (to) {
            const tPlans = await getTranslations({
              locale: 'en',
              namespace: 'notifications.plans',
            });
            const planLabel = tPlans(plan);
            if (evt.type === 'subscription.pastDue') {
              await sendPaymentPastDueEmail(getEmailSender(), {
                to,
                orgName,
                planLabel,
                idempotencyKey: requestId,
              });
            } else {
              const kind = classifyPlanChange(oldPlan, plan);
              if (kind) {
                await sendSubscriptionEmail(getEmailSender(), {
                  to,
                  orgName,
                  planLabel,
                  kind,
                  idempotencyKey: requestId,
                });
              }
            }
          }
        } catch (err) {
          logError({ action: 'clerkWebhook.billingEmail' }, err);
        }
      }
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
        // Seed the purchase VAT bands (food / alcohol / non-food) so an incl.-VAT
        // supplier quote is convertible from day one. Editable in Settings.
        await ensureVatCategories(tx, orgId);
        await writeAuditEvent(tx, orgId, actor, {
          action: 'organization.create',
          entityType: 'organization',
          entityId: orgId,
          metadata: { eventType: evt.type },
        });
      });

      // Reverse trial (pricing 4-tier plan, Slice 3): stamp the org with a 14-day
      // full-access deadline derived from the org's OWN created_at (immutable, not
      // processing time), so a Svix retry recomputes the identical value. The session
      // token projects this into the `org_trial_ends_at` claim, giving request-time
      // gating the deadline with zero DB reads. This is intentionally NOT wrapped in
      // try/catch: a failure must bubble to the outer 500 so Svix retries — an org
      // that silently missed its trial stamp would never get the trial.
      const trialEndsAt = computeTrialEndsAt(evt.data.created_at);
      const client = await clerkClient();
      await client.organizations.updateOrganizationMetadata(orgId, {
        publicMetadata: { trial_ends_at: trialEndsAt.toISOString() },
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
