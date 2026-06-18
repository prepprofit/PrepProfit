import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import { auditLog } from '@/lib/db/schema';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import { writeAuditEvent } from '@/lib/data/audit';
import type { AuditActor } from '@/lib/data/audit';

/**
 * The append-only, org-scoped audit log (Sprint 3.1). Run under the
 * non-privileged `tenant_app` role so RLS is actually enforced (the superuser
 * bypasses FORCE RLS). Proves org isolation on read + write AND that the log is
 * append-only at the DB layer: with select/insert-only policies, UPDATE and
 * DELETE match zero rows.
 */
const ORG_A = 'org_a';
const ORG_B = 'org_b';

const MANAGER: AuditActor = { userId: 'user_1', role: 'manager', requestId: 'req_1' };
const SYSTEM: AuditActor = { userId: null, role: 'system', requestId: 'req_cron' };

let client: PGlite;
let db: TenantDb;

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  db = test.db as unknown as TenantDb;
  await db.execute(sql.raw('SET ROLE tenant_app;'));
});

afterAll(async () => {
  await db.execute(sql.raw('RESET ROLE;'));
  await client.close();
});

describe('writeAuditEvent — org isolation', () => {
  it('writes events (incl. a null-user system actor) to the active org only', async () => {
    await runInOrg(db, ORG_A, async (tx) => {
      await writeAuditEvent(tx, ORG_A, MANAGER, {
        action: 'transaction.create',
        entityType: 'transaction',
        entityId: 't1',
        metadata: { type: 'income', amountCents: 1000 },
      });
      // Cron's org-less actor: null user id + 'system' role inserts cleanly.
      await writeAuditEvent(tx, ORG_A, SYSTEM, {
        action: 'cron.purge',
        entityType: 'trash',
        metadata: { recipes: 2 },
      });
    });

    const seenByA = await runInOrg(db, ORG_A, (tx) =>
      tx.select({ value: sql<number>`count(*)::int` }).from(auditLog),
    );
    expect(seenByA[0]?.value).toBe(2);

    const seenByB = await runInOrg(db, ORG_B, (tx) =>
      tx.select({ value: sql<number>`count(*)::int` }).from(auditLog),
    );
    expect(seenByB[0]?.value).toBe(0);
  });

  it('rejects an INSERT carrying another org id (WITH CHECK)', async () => {
    await expect(
      runInOrg(db, ORG_A, (tx) =>
        writeAuditEvent(tx, ORG_B, MANAGER, {
          action: 'settings.update',
          entityType: 'organizationSettings',
          entityId: ORG_B,
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('audit_log — append-only (no UPDATE/DELETE policy)', () => {
  it('an UPDATE on an existing audit row affects zero rows', async () => {
    const updated = await runInOrg(db, ORG_A, (tx) =>
      tx
        .update(auditLog)
        .set({ action: 'tampered' })
        .where(eq(auditLog.organizationId, ORG_A))
        .returning({ id: auditLog.id }),
    );
    expect(updated).toHaveLength(0);
  });

  it('a DELETE on an existing audit row affects zero rows', async () => {
    const deleted = await runInOrg(db, ORG_A, (tx) =>
      tx
        .delete(auditLog)
        .where(eq(auditLog.organizationId, ORG_A))
        .returning({ id: auditLog.id }),
    );
    expect(deleted).toHaveLength(0);
  });

  it('the original events survive the tamper attempts', async () => {
    const rows = await runInOrg(db, ORG_A, (tx) =>
      tx
        .select({ action: auditLog.action })
        .from(auditLog)
        .where(and(eq(auditLog.organizationId, ORG_A), eq(auditLog.entityId, 't1'))),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('transaction.create');
  });
});
