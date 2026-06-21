'use server';

import { revalidatePath } from 'next/cache';
import { getOrgId } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import {
  replaceIngredientAllergens,
  type AllergenTag,
} from '@/lib/data/allergens';
import { auditActor, writeAuditEvent } from '@/lib/data/audit';
import { ingredientAllergensSchema } from '@/lib/validation/allergens';
import type { ActionResult } from '@/lib/action-result';

/**
 * Server Action: replace an ingredient's allergen tags (Sprint 9). OPERATIONAL —
 * kitchen MAY edit (no manager gate), but every change is AUDITED with the editor's
 * identity (the kitchen user becomes `allergens_reviewed_by`). RULE #1: org id from
 * the server, validated input, the atomic replace + audit run in one `withOrg` tx.
 *
 * An empty allergen set is valid: it marks the ingredient reviewed with no allergens
 * ("no allergens recorded", never "allergen-free").
 */
export async function setIngredientAllergensAction(
  ingredientId: string,
  input: unknown,
): Promise<ActionResult<{ allergens: AllergenTag[] }>> {
  const parsed = ingredientAllergensSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();

  const outcome = await withOrg(organizationId, async (tx) => {
    const result = await replaceIngredientAllergens(
      tx,
      organizationId,
      ingredientId,
      parsed.data.allergens,
      actor.userId,
    );
    if (result.status === 'not_found') return result;

    // metadata = before/after presence SETS (slugs + presence only, non-PII). The
    // reviewer is recorded as `actor_user_id`; never a free-text reason here.
    await writeAuditEvent(tx, organizationId, actor, {
      action: 'allergen.ingredientReview',
      entityType: 'ingredient',
      entityId: ingredientId,
      metadata: { before: result.before, after: result.after },
    });
    return result;
  });

  if (outcome.status === 'not_found') return { ok: false, code: 'NOT_FOUND' };

  // The recipe rollup derives from ingredient tags — refresh recipe views too.
  revalidatePath('/ingredients');
  revalidatePath('/recipes');
  return { ok: true, data: { allergens: outcome.after } };
}
