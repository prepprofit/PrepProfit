'use server';

import { redirect } from 'next/navigation';
import { getOrgId, isManager } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { markOnboarded } from '@/lib/data/org-settings';
import { auditActor, writeAuditEvent } from '@/lib/data/audit';
import type { ActionResult } from '@/lib/action-result';

/**
 * Marks the post-signup onboarding flow complete (Sprint 4d) and sends the
 * manager to their dashboard. RULE #1: the org id is derived from Clerk on the
 * server; the write runs inside `withOrg` so RLS is active. Manager-only — the
 * page already gates kitchen, and this refuses a forged POST with `FORBIDDEN`
 * BEFORE any data access (defense-in-depth).
 *
 * `markOnboarded` is set-once, so finishing twice is a harmless no-op. On success
 * we `redirect` (throws NEXT_REDIRECT, which the client transition follows); only
 * the failure path returns a result. Takes no args — the client calls it directly
 * inside a transition (no form payload to read).
 */
export async function completeOnboardingAction(): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  await withOrg(organizationId, async (tx) => {
    await markOnboarded(tx, organizationId);
    await writeAuditEvent(tx, organizationId, actor, {
      action: 'onboarding.complete',
      entityType: 'organization',
      entityId: organizationId,
      metadata: {},
    });
  });

  redirect('/dashboard');
}
