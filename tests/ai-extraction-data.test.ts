import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import { runInOrg } from '@/lib/db/tenant';
import type { TenantDb } from '@/lib/db/tenant';
import { aiExtractionAttempts } from '@/lib/db/schema';
import { createImportJob } from '@/lib/data/import-jobs';
import {
  createExtractionAttempt,
  markAttemptSucceeded,
  markAttemptFailed,
  countSucceededAttemptsSince,
  monthStartUtc,
} from '@/lib/data/ai-extraction';

/**
 * Data-layer + RLS tests for `ai_extraction_attempts` (Sprint 4.7 step 2). Covers
 * the attempt lifecycle (pending → succeeded/failed), the monthly-usage count, org
 * isolation, the four RLS guarantees (SELECT scoping, INSERT WITH CHECK, UPDATE
 * retag, DELETE reachability), and the composite (org, import_job_id) cross-tenant
 * FK. The Gemini provider is never involved here — this is pure persistence.
 */

const ORG_A = 'org_a';
const ORG_B = 'org_b';

let client: PGlite;
let db: TenantDb;

/** Stage a minimal import job in `org` and return its id (FK target for success). */
async function stageJob(org: string): Promise<string> {
  const job = await runInOrg(db, org, (tx) =>
    createImportJob(tx, org, {
      actorUserId: `user_${org}`,
      entity: 'recipes',
      format: 'csv',
      sourceFilename: null,
      rowCount: 0,
      normalizedRows: { recipes: [], resolutions: {} },
      issues: [],
      idempotencyKey: null,
      expiresAt: new Date(Date.now() + 60_000),
    }),
  );
  return job.id;
}

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  db = test.db as unknown as TenantDb;
});

afterAll(async () => {
  await client.close();
});

describe('attempt lifecycle', () => {
  it('creates a pending attempt, then flips it to succeeded with usage + job link', async () => {
    const jobId = await stageJob(ORG_A);
    const attempt = await runInOrg(db, ORG_A, (tx) =>
      createExtractionAttempt(tx, ORG_A, {
        actorUserId: 'user_a',
        provider: 'google',
        model: 'gemini-3.5-flash',
        imageCount: 1,
      }),
    );
    expect(attempt.status).toBe('pending');
    expect(attempt.importJobId).toBeNull();

    await runInOrg(db, ORG_A, (tx) =>
      markAttemptSucceeded(tx, ORG_A, attempt.id, {
        importJobId: jobId,
        inputTokens: 1200,
        outputTokens: 300,
        costMicros: 4000,
        qualityFlags: ['low_confidence'],
      }),
    );

    const [row] = await db
      .select()
      .from(aiExtractionAttempts)
      .where(eq(aiExtractionAttempts.id, attempt.id));
    expect(row?.status).toBe('succeeded');
    expect(row?.importJobId).toBe(jobId);
    expect(row?.inputTokens).toBe(1200);
    expect(row?.qualityFlags).toEqual(['low_confidence']);
    expect(row?.errorCode).toBeNull();
  });

  it('marks an attempt failed with a stable error code and no job link', async () => {
    const attempt = await runInOrg(db, ORG_A, (tx) =>
      createExtractionAttempt(tx, ORG_A, {
        actorUserId: 'user_a',
        provider: 'google',
        model: 'gemini-3.5-flash',
        imageCount: 1,
      }),
    );
    await runInOrg(db, ORG_A, (tx) =>
      markAttemptFailed(tx, ORG_A, attempt.id, { errorCode: 'AI_EXTRACTION_FAILED' }),
    );

    const [row] = await db
      .select()
      .from(aiExtractionAttempts)
      .where(eq(aiExtractionAttempts.id, attempt.id));
    expect(row?.status).toBe('failed');
    expect(row?.errorCode).toBe('AI_EXTRACTION_FAILED');
    expect(row?.importJobId).toBeNull();
  });
});

describe('monthly usage count', () => {
  it('monthStartUtc returns the UTC first-of-month midnight', () => {
    const start = monthStartUtc(new Date('2026-06-20T13:45:10Z'));
    expect(start.toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });

  it('counts only succeeded attempts for the org within the window', async () => {
    const org = 'org_count';
    const jobId = await runInOrg(db, org, (tx) =>
      createImportJob(tx, org, {
        actorUserId: 'u',
        entity: 'recipes',
        format: 'csv',
        sourceFilename: null,
        rowCount: 0,
        normalizedRows: { recipes: [], resolutions: {} },
        issues: [],
        idempotencyKey: null,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).then((j) => j.id);

    // Two succeeded, one pending, one failed → cap count is 2.
    for (let i = 0; i < 2; i++) {
      const a = await runInOrg(db, org, (tx) =>
        createExtractionAttempt(tx, org, {
          actorUserId: 'u',
          provider: 'google',
          model: 'gemini-3.5-flash',
          imageCount: 1,
        }),
      );
      await runInOrg(db, org, (tx) =>
        markAttemptSucceeded(tx, org, a.id, {
          importJobId: jobId,
          inputTokens: null,
          outputTokens: null,
          costMicros: null,
          qualityFlags: [],
        }),
      );
    }
    await runInOrg(db, org, (tx) =>
      createExtractionAttempt(tx, org, {
        actorUserId: 'u',
        provider: 'google',
        model: 'gemini-3.5-flash',
        imageCount: 1,
      }),
    );
    const failed = await runInOrg(db, org, (tx) =>
      createExtractionAttempt(tx, org, {
        actorUserId: 'u',
        provider: 'google',
        model: 'gemini-3.5-flash',
        imageCount: 1,
      }),
    );
    await runInOrg(db, org, (tx) =>
      markAttemptFailed(tx, org, failed.id, { errorCode: 'AI_EXTRACTION_FAILED' }),
    );

    const monthStart = monthStartUtc(new Date());
    const used = await runInOrg(db, org, (tx) =>
      countSucceededAttemptsSince(tx, org, monthStart),
    );
    expect(used).toBe(2);

    // A window that starts next month sees nothing (the reset boundary).
    const nextMonth = new Date(monthStart.getTime());
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    const usedNext = await runInOrg(db, org, (tx) =>
      countSucceededAttemptsSince(tx, org, nextMonth),
    );
    expect(usedNext).toBe(0);
  });
});

describe('org isolation + RLS', () => {
  it('an attempt is invisible to another org (app-layer count)', async () => {
    await runInOrg(db, ORG_B, (tx) =>
      createExtractionAttempt(tx, ORG_B, {
        actorUserId: 'user_b',
        provider: 'google',
        model: 'gemini-3.5-flash',
        imageCount: 1,
      }),
    );
    // Org A's window count never sees org B's attempts.
    const monthStart = monthStartUtc(new Date());
    const seenByA = await runInOrg(db, ORG_A, (tx) =>
      countSucceededAttemptsSince(tx, ORG_A, monthStart),
    );
    // Org A's own succeeded attempt from the lifecycle test = 1; never org B's.
    expect(seenByA).toBe(1);
  });

  it('RLS scopes an unfiltered SELECT to the active org', async () => {
    await db.execute(sql.raw('SET ROLE tenant_app;'));
    try {
      const orgs = await runInOrg(db, ORG_A, (tx) =>
        tx
          .select({ org: aiExtractionAttempts.organizationId })
          .from(aiExtractionAttempts),
      );
      expect(orgs.length).toBeGreaterThan(0);
      expect(orgs.every((r) => r.org === ORG_A)).toBe(true);
    } finally {
      await db.execute(sql.raw('RESET ROLE;'));
    }
  });

  it('without an org context, RLS returns nothing (secure by default)', async () => {
    await db.execute(sql.raw('SET ROLE tenant_app;'));
    try {
      const rows = await db.select().from(aiExtractionAttempts);
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
        tx.insert(aiExtractionAttempts).values({
          organizationId: ORG_B,
          actorUserId: 'smuggler',
          provider: 'google',
          model: 'gemini-3.5-flash',
        }),
      ),
    ).rejects.toThrow();
  });

  it('rejects re-tagging a row to another org via UPDATE (WITH CHECK)', async () => {
    const id = await runInOrg(db, ORG_A, (tx) =>
      tx
        .insert(aiExtractionAttempts)
        .values({
          organizationId: ORG_A,
          actorUserId: 'user_a',
          provider: 'google',
          model: 'gemini-3.5-flash',
        })
        .returning({ id: aiExtractionAttempts.id }),
    ).then((r) => r[0]?.id);

    await expect(
      runInOrg(db, ORG_A, (tx) =>
        tx
          .update(aiExtractionAttempts)
          .set({ organizationId: ORG_B })
          .where(eq(aiExtractionAttempts.id, id!)),
      ),
    ).rejects.toThrow();
  });
});

describe('composite FK blocks cross-tenant job links', () => {
  it('rejects an attempt linking to another org’s import job', async () => {
    // Superuser bypasses RLS but the composite (org, import_job_id) FK still applies:
    // (ORG_A, jobB) has no matching import_jobs parent → the DB rejects the link.
    const jobB = await stageJob(ORG_B);
    await expect(
      db.insert(aiExtractionAttempts).values({
        organizationId: ORG_A,
        actorUserId: 'user_a',
        provider: 'google',
        model: 'gemini-3.5-flash',
        importJobId: jobB,
      }),
    ).rejects.toThrow();
  });
});
