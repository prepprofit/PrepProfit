import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import { rateLimits } from '@/lib/db/schema';
import type { TenantDb } from '@/lib/db/tenant';
import { checkRateLimit, rateLimitKey } from '@/lib/rate-limit';

/**
 * The Postgres fixed-window limiter (Sprint 3.1). Exercised against a real
 * in-memory Postgres so the atomic upsert + window reset behave exactly as in
 * prod. `rate_limits` has no RLS (infra table), so we use the superuser client.
 */
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

const CONFIG = { limit: 3, windowMs: 60_000 };

describe('checkRateLimit', () => {
  it('allows hits up to the limit, then blocks', async () => {
    const key = rateLimitKey('search', 'org_a:user_1');

    const r1 = await checkRateLimit(db, key, CONFIG);
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);

    const r2 = await checkRateLimit(db, key, CONFIG);
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(1);

    const r3 = await checkRateLimit(db, key, CONFIG);
    expect(r3.allowed).toBe(true);
    expect(r3.remaining).toBe(0);

    // 4th hit in the same window is over the limit.
    const r4 = await checkRateLimit(db, key, CONFIG);
    expect(r4.allowed).toBe(false);
    expect(r4.remaining).toBe(0);
  });

  it('resets once the window has elapsed', async () => {
    const key = rateLimitKey('search', 'org_a:user_2');
    await checkRateLimit(db, key, CONFIG);
    await checkRateLimit(db, key, CONFIG);
    await checkRateLimit(db, key, CONFIG);
    expect((await checkRateLimit(db, key, CONFIG)).allowed).toBe(false);

    // Push the window start into the past so the next hit starts a fresh window.
    await db
      .update(rateLimits)
      .set({ windowStart: sql`now() - interval '2 minutes'` })
      .where(eq(rateLimits.key, key));

    const afterReset = await checkRateLimit(db, key, CONFIG);
    expect(afterReset.allowed).toBe(true);
    expect(afterReset.remaining).toBe(2);
  });

  it('isolates distinct keys (different org/user share no bucket)', async () => {
    const a = rateLimitKey('search', 'org_a:user_3');
    const b = rateLimitKey('search', 'org_b:user_3');

    await checkRateLimit(db, a, CONFIG);
    await checkRateLimit(db, a, CONFIG);
    await checkRateLimit(db, a, CONFIG);
    expect((await checkRateLimit(db, a, CONFIG)).allowed).toBe(false);

    // Same user id, different org → its own fresh bucket.
    const first = await checkRateLimit(db, b, CONFIG);
    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(2);
  });

  it('hashes the scope into an opaque key (no raw id/secret stored)', () => {
    const key = rateLimitKey('cronPurge', 'Bearer super-secret');
    expect(key.startsWith('cronPurge:')).toBe(true);
    expect(key).not.toContain('super-secret');
    // sha256 hex digest is 64 chars after the bucket prefix.
    expect(key.length).toBe('cronPurge:'.length + 64);
  });
});
