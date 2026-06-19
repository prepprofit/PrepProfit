import { and, eq } from 'drizzle-orm';
import { importJobs } from '@/lib/db/schema';
import type { ImportJob } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';
import type {
  ImportEntity,
  ImportFormat,
  ImportNormalizedRows,
  ImportRowIssue,
} from '@/lib/import/types';

/**
 * Data access for staged import jobs (Sprint 4.5). ALWAYS org-scoped (RULE #1) —
 * the org id is derived server-side, RLS (lib/db/rls.ts) is the second layer. The
 * confirm path locks the job row FOR UPDATE and flips its status in one
 * transaction, so a job can be applied exactly once (idempotent re-confirm).
 */

export type CreateImportJobInput = {
  actorUserId: string;
  entity: ImportEntity;
  format: ImportFormat;
  sourceFilename: string | null;
  rowCount: number;
  normalizedRows: ImportNormalizedRows;
  issues: ImportRowIssue[];
  idempotencyKey: string | null;
  expiresAt: Date;
};

/** Insert a new `parsed` job and return it. */
export async function createImportJob(
  db: TenantClient,
  organizationId: string,
  input: CreateImportJobInput,
): Promise<ImportJob> {
  const [row] = await db
    .insert(importJobs)
    .values({
      organizationId,
      actorUserId: input.actorUserId,
      entity: input.entity,
      format: input.format,
      status: 'parsed',
      sourceFilename: input.sourceFilename,
      rowCount: input.rowCount,
      normalizedRows: input.normalizedRows,
      issues: input.issues,
      idempotencyKey: input.idempotencyKey,
      expiresAt: input.expiresAt,
    })
    .returning();
  if (!row) throw new Error('Failed to create import job.');
  return row;
}

/**
 * Take a FOR UPDATE lock on a job (org-scoped) and return it, so confirm reads its
 * status under the lock and no concurrent confirm can apply it twice. MUST run
 * inside the confirm `withOrg` transaction.
 */
export async function lockImportJob(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<ImportJob | null> {
  const rows = await db
    .select()
    .from(importJobs)
    .where(
      and(eq(importJobs.organizationId, organizationId), eq(importJobs.id, id)),
    )
    .for('update')
    .limit(1);
  return rows[0] ?? null;
}

/** Flip a job to `committed` (its terminal, immutable state). */
export async function markImportJobCommitted(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<void> {
  await db
    .update(importJobs)
    .set({ status: 'committed' })
    .where(
      and(eq(importJobs.organizationId, organizationId), eq(importJobs.id, id)),
    );
}

/** Flip a job to `expired` (past its TTL before confirm). */
export async function markImportJobExpired(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<void> {
  await db
    .update(importJobs)
    .set({ status: 'expired' })
    .where(
      and(eq(importJobs.organizationId, organizationId), eq(importJobs.id, id)),
    );
}
