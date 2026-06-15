'use server';

import { revalidatePath } from 'next/cache';
import { getOrgId } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { upsertOrgSettings } from '@/lib/data/org-settings';
import { orgSettingsSchema } from '@/lib/validation/org-settings';

/**
 * Saves the current org's settings. RULE #1: the org id is derived from Clerk on
 * the server (never the client), and the write runs inside `withOrg` so RLS is
 * active. Input is validated with Zod on the server.
 */
export async function updateOrgSettingsAction(formData: FormData): Promise<void> {
  const organizationId = await getOrgId();
  const input = orgSettingsSchema.parse({
    currency: formData.get('currency'),
    measurementSystem: formData.get('measurementSystem'),
  });
  await withOrg(organizationId, (tx) =>
    upsertOrgSettings(tx, organizationId, input),
  );
  revalidatePath('/settings');
}
