import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import { runInOrg } from '@/lib/db/tenant';
import type { TenantDb } from '@/lib/db/tenant';
import {
  aiOperationAttempts,
  supplierInvoiceImports,
  supplierInvoiceImportLines,
} from '@/lib/db/schema';
import {
  createOperationAttempt,
  markOperationSucceeded,
  markOperationFailed,
  countReservedOperations,
  countSucceededOperationsSince,
  monthStartUtc,
} from '@/lib/data/ai-operation-attempts';

/**
 * Data-layer + RLS tests for the generic AI operation ledger and the supplier
 * invoice import tables (Sprint 2, AI margin roadmap). Covers the attempt lifecycle,
 * per-FEATURE monthly reserved count (succeeded + in-flight pending), org isolation,
 * the RLS guarantees (SELECT scoping, INSERT WITH CHECK, UPDATE retag), and the
 * composite cross-tenant FKs. No provider is involved — pure persistence.
 */

const ORG_A = 'org_a';
const ORG_B = 'org_b';
const FEATURE = 'supplier_invoice_extraction';

let client: PGlite;
let db: TenantDb;

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  db = test.db as unknown as TenantDb;
});

afterAll(async () => {
  await client.close();
});

describe('operation attempt lifecycle', () => {
  it('creates a pending attempt then flips it to succeeded with usage + result pointer', async () => {
    const attempt = await runInOrg(db, ORG_A, (tx) =>
      createOperationAttempt(tx, ORG_A, {
        actorUserId: 'user_a',
        feature: FEATURE,
        provider: 'google',
        model: 'gemini-2.5-flash',
      }),
    );
    expect(attempt.status).toBe('pending');
    expect(attempt.feature).toBe(FEATURE);

    await runInOrg(db, ORG_A, (tx) =>
      markOperationSucceeded(tx, ORG_A, attempt.id, {
        inputTokens: 900,
        outputTokens: 200,
        costMicros: 3000,
        qualityFlags: ['low_confidence'],
        resultType: 'supplier_invoice_import',
        resultId: 'imp_1',
      }),
    );

    const [row] = await db
      .select()
      .from(aiOperationAttempts)
      .where(eq(aiOperationAttempts.id, attempt.id));
    expect(row?.status).toBe('succeeded');
    expect(row?.inputTokens).toBe(900);
    expect(row?.qualityFlags).toEqual(['low_confidence']);
    expect(row?.resultType).toBe('supplier_invoice_import');
    expect(row?.resultId).toBe('imp_1');
    expect(row?.errorCode).toBeNull();
  });

  it('marks an attempt failed with a stable error code', async () => {
    const attempt = await runInOrg(db, ORG_A, (tx) =>
      createOperationAttempt(tx, ORG_A, {
        actorUserId: 'user_a',
        feature: FEATURE,
        provider: 'google',
        model: 'gemini-2.5-flash',
      }),
    );
    await runInOrg(db, ORG_A, (tx) =>
      markOperationFailed(tx, ORG_A, attempt.id, { errorCode: 'AI_INVOICE_FAILED' }),
    );
    const [row] = await db
      .select()
      .from(aiOperationAttempts)
      .where(eq(aiOperationAttempts.id, attempt.id));
    expect(row?.status).toBe('failed');
    expect(row?.errorCode).toBe('AI_INVOICE_FAILED');
  });
});

describe('monthly reserved count (the cap gate)', () => {
  it('counts succeeded + in-flight pending, excludes failed, scoped per feature', async () => {
    const org = 'org_count';
    const now = new Date();
    const monthStart = monthStartUtc(now);

    // Two succeeded + one (fresh) pending = 3 reserved; one failed released.
    for (let i = 0; i < 2; i++) {
      const a = await runInOrg(db, org, (tx) =>
        createOperationAttempt(tx, org, {
          actorUserId: 'u',
          feature: FEATURE,
          provider: 'google',
          model: 'gemini-2.5-flash',
        }),
      );
      await runInOrg(db, org, (tx) =>
        markOperationSucceeded(tx, org, a.id, {
          inputTokens: null,
          outputTokens: null,
          costMicros: null,
          qualityFlags: [],
        }),
      );
    }
    await runInOrg(db, org, (tx) =>
      createOperationAttempt(tx, org, {
        actorUserId: 'u',
        feature: FEATURE,
        provider: 'google',
        model: 'gemini-2.5-flash',
      }),
    );
    const failed = await runInOrg(db, org, (tx) =>
      createOperationAttempt(tx, org, {
        actorUserId: 'u',
        feature: FEATURE,
        provider: 'google',
        model: 'gemini-2.5-flash',
      }),
    );
    await runInOrg(db, org, (tx) =>
      markOperationFailed(tx, org, failed.id, { errorCode: 'AI_INVOICE_FAILED' }),
    );

    const reserved = await runInOrg(db, org, (tx) =>
      countReservedOperations(tx, org, FEATURE, monthStart, now),
    );
    expect(reserved).toBe(3);

    // A different feature's attempts never count toward this feature's cap.
    const otherReserved = await runInOrg(db, org, (tx) =>
      countReservedOperations(tx, org, 'daily_close_summary', monthStart, now),
    );
    expect(otherReserved).toBe(0);

    // Succeeded-only count (usage display) excludes the pending one.
    const succeeded = await runInOrg(db, org, (tx) =>
      countSucceededOperationsSince(tx, org, FEATURE, monthStart),
    );
    expect(succeeded).toBe(2);
  });

  it('a stale pending (older than the in-flight horizon) stops reserving a slot', async () => {
    const org = 'org_stale';
    const now = new Date();
    const monthStart = monthStartUtc(now);
    const a = await runInOrg(db, org, (tx) =>
      createOperationAttempt(tx, org, {
        actorUserId: 'u',
        feature: FEATURE,
        provider: 'google',
        model: 'gemini-2.5-flash',
      }),
    );
    // Backdate the pending row well past the 5-minute horizon.
    await db
      .update(aiOperationAttempts)
      .set({ createdAt: new Date(now.getTime() - 60 * 60_000) })
      .where(eq(aiOperationAttempts.id, a.id));

    const reserved = await runInOrg(db, org, (tx) =>
      countReservedOperations(tx, org, FEATURE, monthStart, now),
    );
    expect(reserved).toBe(0);
  });
});

describe('org isolation + RLS', () => {
  it('RLS scopes an unfiltered SELECT to the active org', async () => {
    await runInOrg(db, ORG_B, (tx) =>
      createOperationAttempt(tx, ORG_B, {
        actorUserId: 'user_b',
        feature: FEATURE,
        provider: 'google',
        model: 'gemini-2.5-flash',
      }),
    );
    await db.execute(sql.raw('SET ROLE tenant_app;'));
    try {
      const rows = await runInOrg(db, ORG_A, (tx) =>
        tx.select({ org: aiOperationAttempts.organizationId }).from(aiOperationAttempts),
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.org === ORG_A)).toBe(true);
    } finally {
      await db.execute(sql.raw('RESET ROLE;'));
    }
  });

  it('without an org context, RLS returns nothing (secure by default)', async () => {
    await db.execute(sql.raw('SET ROLE tenant_app;'));
    try {
      const rows = await db.select().from(aiOperationAttempts);
      expect(rows).toHaveLength(0);
    } finally {
      await db.execute(sql.raw('RESET ROLE;'));
    }
  });
});

describe('RLS WITH CHECK rejects cross-org writes', () => {
  beforeAll(async () => {
    await db.execute(sql.raw('SET ROLE tenant_app;'));
  });
  afterAll(async () => {
    await db.execute(sql.raw('RESET ROLE;'));
  });

  it('rejects an INSERT carrying another org id (WITH CHECK)', async () => {
    await expect(
      runInOrg(db, ORG_A, (tx) =>
        tx.insert(aiOperationAttempts).values({
          organizationId: ORG_B,
          actorUserId: 'smuggler',
          feature: FEATURE,
          provider: 'google',
          model: 'gemini-2.5-flash',
        }),
      ),
    ).rejects.toThrow();
  });

  it('rejects re-tagging a row to another org via UPDATE (WITH CHECK)', async () => {
    const id = await runInOrg(db, ORG_A, (tx) =>
      tx
        .insert(aiOperationAttempts)
        .values({
          organizationId: ORG_A,
          actorUserId: 'user_a',
          feature: FEATURE,
          provider: 'google',
          model: 'gemini-2.5-flash',
        })
        .returning({ id: aiOperationAttempts.id }),
    ).then((r) => r[0]?.id);

    await expect(
      runInOrg(db, ORG_A, (tx) =>
        tx
          .update(aiOperationAttempts)
          .set({ organizationId: ORG_B })
          .where(eq(aiOperationAttempts.id, id!)),
      ),
    ).rejects.toThrow();
  });
});

describe('supplier invoice import tables — persistence + composite FKs', () => {
  it('persists a draft import with lines and cascades on delete', async () => {
    const importId = await runInOrg(db, ORG_A, async (tx) => {
      const [header] = await tx
        .insert(supplierInvoiceImports)
        .values({
          organizationId: ORG_A,
          actorUserId: 'user_a',
          supplierNameRaw: 'ACME Foods',
          currencyCode: 'EUR',
          status: 'draft',
        })
        .returning();
      await tx.insert(supplierInvoiceImportLines).values({
        organizationId: ORG_A,
        importId: header!.id,
        sortOrder: 0,
        itemNameRaw: 'Butter 5kg',
        unitPriceCents: 970,
        status: 'needs_review',
      });
      return header!.id;
    });

    const linesBefore = await db
      .select()
      .from(supplierInvoiceImportLines)
      .where(eq(supplierInvoiceImportLines.importId, importId));
    expect(linesBefore).toHaveLength(1);

    await db.delete(supplierInvoiceImports).where(eq(supplierInvoiceImports.id, importId));
    const linesAfter = await db
      .select()
      .from(supplierInvoiceImportLines)
      .where(eq(supplierInvoiceImportLines.importId, importId));
    expect(linesAfter).toHaveLength(0);
  });

  it('composite FK blocks linking an import to another org’s AI attempt', async () => {
    const attemptB = await runInOrg(db, ORG_B, (tx) =>
      createOperationAttempt(tx, ORG_B, {
        actorUserId: 'user_b',
        feature: FEATURE,
        provider: 'google',
        model: 'gemini-2.5-flash',
      }),
    );
    // Superuser bypasses RLS, but the composite (org, ai_attempt_id) FK still applies:
    // (ORG_A, attemptB) has no matching parent → the DB rejects the link.
    await expect(
      db.insert(supplierInvoiceImports).values({
        organizationId: ORG_A,
        actorUserId: 'user_a',
        aiAttemptId: attemptB.id,
        status: 'draft',
      }),
    ).rejects.toThrow();
  });

  it('rejects a negative unit price via the CHECK constraint', async () => {
    const importId = await runInOrg(db, ORG_A, (tx) =>
      tx
        .insert(supplierInvoiceImports)
        .values({ organizationId: ORG_A, actorUserId: 'user_a', status: 'draft' })
        .returning({ id: supplierInvoiceImports.id }),
    ).then((r) => r[0]!.id);

    await expect(
      db.insert(supplierInvoiceImportLines).values({
        organizationId: ORG_A,
        importId,
        itemNameRaw: 'Bad price',
        unitPriceCents: -5,
        status: 'needs_review',
      }),
    ).rejects.toThrow();
  });
});
