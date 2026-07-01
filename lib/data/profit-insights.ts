import { and, eq, inArray, sql } from 'drizzle-orm';
import { profitInsights } from '@/lib/db/schema';
import type { ProfitInsight } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';
import type { ProfitLeakExplanationData } from '@/lib/ai/operation-types';
import type {
  ProfitLeakFindingType,
  ProfitLeakFinding,
} from '@/lib/calculations/profit-leaks';

/**
 * Profit-insight sidecar data layer (Sprint 4, AI margin roadmap). ALWAYS org-scoped
 * (RULE #1) — the org id is derived server-side, RLS (lib/db/rls.ts) is the second
 * layer. Findings are recomputed on read (lib/data/profit-leaks.ts); this module only
 * reads/writes the per-finding sidecar (cached AI explanation + dismiss flag), keyed by
 * the finding's stable `fingerprint`.
 *
 * No finding/detection logic lives here: callers re-derive the deterministic finding
 * and pass its descriptors in, so a sidecar row can only ever be written for a real
 * finding (plan §9: an explanation cannot exist without one).
 */

/** The finding descriptors persisted alongside the sidecar state (no PII, ids only). */
export type InsightDescriptor = {
  fingerprint: string;
  findingType: ProfitLeakFindingType;
  entityType: ProfitLeakFinding['entityType'];
  entityId: string;
};

/** Derive the storable descriptor from a live finding. */
export function insightDescriptor(finding: ProfitLeakFinding): InsightDescriptor {
  return {
    fingerprint: finding.fingerprint,
    findingType: finding.type,
    entityType: finding.entityType,
    entityId: finding.entityId,
  };
}

/** The sidecar state merged into a finding for rendering. */
export type InsightState = {
  explanation: ProfitLeakExplanationData | null;
  dismissedAt: Date | null;
};

/** Fetch one sidecar row by fingerprint, or null when the finding was never touched. */
export async function getProfitInsight(
  db: TenantClient,
  organizationId: string,
  fingerprint: string,
): Promise<ProfitInsight | null> {
  const rows = await db
    .select()
    .from(profitInsights)
    .where(
      and(
        eq(profitInsights.organizationId, organizationId),
        eq(profitInsights.fingerprint, fingerprint),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export type UpsertExplanationInput = {
  descriptor: InsightDescriptor;
  explanation: ProfitLeakExplanationData;
  model: string;
};

/**
 * Cache an AI explanation for a finding (insert-or-update on the unique (org,
 * fingerprint) key). Preserves any existing `dismissed_at` — explaining a finding does
 * not un-dismiss it. MUST run inside `withOrg`. Returns the stored row.
 */
export async function upsertExplanation(
  db: TenantClient,
  organizationId: string,
  input: UpsertExplanationInput,
): Promise<ProfitInsight> {
  const { descriptor, explanation, model } = input;
  const [row] = await db
    .insert(profitInsights)
    .values({
      organizationId,
      fingerprint: descriptor.fingerprint,
      findingType: descriptor.findingType,
      entityType: descriptor.entityType,
      entityId: descriptor.entityId,
      explanation,
      explanationModel: model,
    })
    .onConflictDoUpdate({
      target: [profitInsights.organizationId, profitInsights.fingerprint],
      set: {
        explanation,
        explanationModel: model,
        // Keep descriptors fresh in case the finding's entity fields shifted.
        findingType: descriptor.findingType,
        entityType: descriptor.entityType,
        entityId: descriptor.entityId,
        updatedAt: sql`now()`,
      },
    })
    .returning();
  if (!row) throw new Error('Failed to upsert profit insight explanation.');
  return row;
}

/**
 * Set (or clear) the dismissed flag for a finding. `dismissed=true` stamps `now()`;
 * `false` clears it (restore). Upserts so a never-explained finding can still be
 * dismissed. Preserves any cached explanation. MUST run inside `withOrg`.
 */
export async function setDismissed(
  db: TenantClient,
  organizationId: string,
  descriptor: InsightDescriptor,
  dismissed: boolean,
): Promise<ProfitInsight> {
  const dismissedAt = dismissed ? sql`now()` : null;
  const [row] = await db
    .insert(profitInsights)
    .values({
      organizationId,
      fingerprint: descriptor.fingerprint,
      findingType: descriptor.findingType,
      entityType: descriptor.entityType,
      entityId: descriptor.entityId,
      dismissedAt: dismissed ? new Date() : null,
    })
    .onConflictDoUpdate({
      target: [profitInsights.organizationId, profitInsights.fingerprint],
      set: {
        dismissedAt,
        findingType: descriptor.findingType,
        entityType: descriptor.entityType,
        entityId: descriptor.entityId,
        updatedAt: sql`now()`,
      },
    })
    .returning();
  if (!row) throw new Error('Failed to set profit insight dismissed state.');
  return row;
}

/**
 * Load the sidecar state (explanation + dismissed flag) for a set of fingerprints,
 * returned as a Map so the caller merges them into the recomputed findings. Empty set
 * → empty map (no query). Org-scoped; RLS is the second layer.
 */
export async function listInsightStates(
  db: TenantClient,
  organizationId: string,
  fingerprints: string[],
): Promise<Map<string, InsightState>> {
  const result = new Map<string, InsightState>();
  if (fingerprints.length === 0) return result;

  const rows = await db
    .select({
      fingerprint: profitInsights.fingerprint,
      explanation: profitInsights.explanation,
      dismissedAt: profitInsights.dismissedAt,
    })
    .from(profitInsights)
    .where(
      and(
        eq(profitInsights.organizationId, organizationId),
        inArray(profitInsights.fingerprint, fingerprints),
      ),
    );

  for (const row of rows) {
    result.set(row.fingerprint, {
      explanation: row.explanation ?? null,
      dismissedAt: row.dismissedAt ?? null,
    });
  }
  return result;
}
