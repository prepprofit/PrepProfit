import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import * as schema from '@/lib/db/schema';
import { aiExtractionAttempts } from '@/lib/db/schema';
import { runInOrg, type TenantDb } from '@/lib/db/tenant';
import {
  countReservedAttempts,
  createExtractionAttempt,
  lockMonthlyExtractionQuota,
  monthStartUtc,
} from '@/lib/data/ai-extraction';

/**
 * REAL-Postgres concurrency proof for the monthly AI-extraction cap (audit F-02).
 *
 * Why opt-in (mirrors po-counter.pg.test.ts): the in-suite route test runs on PGlite,
 * a SINGLE in-process connection, so it cannot run two transactions concurrently and
 * therefore cannot exercise the advisory lock that serializes the cap check — the
 * exact property that stops concurrent uploads from overshooting the quota.
 *
 * Setup: point `TEST_DATABASE_URL` at a DISPOSABLE Neon branch with migrations + RLS
 * applied (`DATABASE_URL=<branch> npm run db:migrate`). Without the env var the whole
 * describe is skipped (CI stays green with no database).
 *
 * The invariant under test: with a cap of LIMIT and K (> LIMIT) concurrent gate
 * attempts, EXACTLY LIMIT reservations are created — never more.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (typeof globalThis.WebSocket === 'undefined') {
  neonConfig.webSocketConstructor = ws;
}

describe.skipIf(!TEST_DATABASE_URL)(
  'AI-extraction monthly cap under real Postgres concurrency',
  () => {
    const ORG = `org_ai_cap_${Date.now()}`;
    let pool: Pool;
    let db: TenantDb;

    beforeAll(() => {
      pool = new Pool({ connectionString: TEST_DATABASE_URL });
      db = drizzle(pool, { schema }) as unknown as TenantDb;
    });

    afterAll(async () => {
      await pool.end();
    });

    it('K concurrent uploads reserve at most the cap (no overshoot)', async () => {
      const LIMIT = 5;
      const K = 20;
      const now = new Date();
      const monthStart = monthStartUtc(now);

      // Each task replays the route's gate: lock → count reserved → reserve if under.
      const outcomes = await Promise.all(
        Array.from({ length: K }, () =>
          runInOrg(db, ORG, async (tx) => {
            await lockMonthlyExtractionQuota(tx, ORG, monthStart);
            const used = await countReservedAttempts(tx, ORG, monthStart, now);
            if (used >= LIMIT) return 'capped' as const;
            await createExtractionAttempt(tx, ORG, {
              actorUserId: 'load_test',
              provider: 'google',
              model: 'gemini-3.5-flash',
              imageCount: 1,
            });
            return 'reserved' as const;
          }),
        ),
      );

      const reserved = outcomes.filter((o) => o === 'reserved').length;
      expect(reserved).toBe(LIMIT);

      // The table agrees: exactly LIMIT pending rows for this org.
      const rows = await runInOrg(db, ORG, (tx) =>
        tx
          .select({ id: aiExtractionAttempts.id })
          .from(aiExtractionAttempts)
          .where(
            and(
              eq(aiExtractionAttempts.organizationId, ORG),
              eq(aiExtractionAttempts.status, 'pending'),
            ),
          ),
      );
      expect(rows).toHaveLength(LIMIT);
    });
  },
);
