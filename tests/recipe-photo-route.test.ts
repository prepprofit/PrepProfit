import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import { aiExtractionAttempts, auditLog, importJobs, rateLimits } from '@/lib/db/schema';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import { rateLimitKey } from '@/lib/rate-limit';

/**
 * Integration test for the AI photo extraction route (Sprint 4.7). Runs the REAL
 * handler against PGlite under `tenant_app` (RLS enforced), with auth, entitlements,
 * the DB seam, and the Gemini PROVIDER stubbed — the provider is never called for
 * real (CLAUDE.md). Proves the canonical order (RBAC→feature→rate→image→cap), that a
 * success stages a recipe_photo job + a succeeded attempt + an `ai.extract` audit in
 * the active org only, and that a provider failure records a `failed` attempt and
 * stages nothing.
 */
const ORG_A = 'org_a';
const ORG_B = 'org_b';

type ExtractResult = {
  recipe: unknown;
  usage: { inputTokens: number | null; outputTokens: number | null };
  model: string;
  provider: string;
};

const goodRecipe = {
  name: 'Bolo de Cenoura',
  yieldPortions: 8,
  ingredients: [
    { name: 'Farinha', quantity: 300, unit: 'g', confidence: 0.95 },
    { name: 'Cenoura', quantity: 200, unit: 'g', confidence: 0.4 }, // low → flag
  ],
  preparationNotes: null,
  overallConfidence: 0.9,
  imageQuality: 'good',
};

const h = vi.hoisted(() => ({
  db: null as unknown,
  manager: true,
  orgId: 'org_a',
  userId: 'user_1',
  role: 'manager' as 'manager' | 'kitchen',
  monthlyLimit: 50,
  throws: false,
  busy: false,
  result: {
    recipe: null as unknown,
    usage: { inputTokens: 1000, outputTokens: 200 },
    model: 'gemini-3.5-flash',
    provider: 'google',
  } as ExtractResult,
}));

vi.mock('@/lib/auth', () => ({
  isManager: vi.fn(async () => h.manager),
  getOrgId: vi.fn(async () => h.orgId),
  getUserId: vi.fn(async () => h.userId),
  getUserRole: vi.fn(async () => h.role),
}));

vi.mock('@/lib/entitlements', () => ({
  aiExtractionMonthlyLimit: vi.fn(async () => ({ limit: h.monthlyLimit, tier: 'pro' })),
}));

vi.mock('@/lib/db', () => ({
  getDb: () => h.db,
  withOrg: async (org: string, fn: (tx: unknown) => unknown) => {
    const { runInOrg: rio } = await import('@/lib/db/tenant');
    return rio(h.db as TenantDb, org, fn as never);
  },
}));

vi.mock('@/lib/ai/recipe-extraction', () => {
  // Defined inside the factory (vi.mock is hoisted) — mirrors the real class's
  // `retryable` flag so the route can distinguish a busy overload from a hard failure.
  class RecipeExtractionError extends Error {
    readonly retryable: boolean;
    constructor(message: string, options?: { retryable?: boolean }) {
      super(message);
      this.retryable = options?.retryable ?? false;
    }
  }
  return {
    getRecipeExtractor: () => ({
      extract: async () => {
        // `busy` = a transient overload that survived retries (retryable); `throws` =
        // an unexpected non-provider failure. They map to different codes/statuses.
        if (h.busy) throw new RecipeExtractionError('model overloaded', { retryable: true });
        if (h.throws) throw new Error('provider down');
        return h.result;
      },
    }),
    RecipeExtractionError,
    RECIPE_EXTRACTION_MODEL: 'gemini-3.5-flash',
    RECIPE_EXTRACTION_PROVIDER: 'google',
  };
});

// Import the route AFTER the mocks are registered.
import { POST } from '@/app/api/recipes/import/photo/route';

let client: PGlite;
let db: TenantDb;

/** Minimal valid JPEG (SOI + SOF0 with dimensions) — passes the byte sniffer. */
function jpegBytes(width = 1200, height = 900): Buffer {
  const b = Buffer.alloc(11);
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; b[3] = 0xc0;
  b.writeUInt16BE(0x0011, 4);
  b[6] = 8;
  b.writeUInt16BE(height, 7);
  b.writeUInt16BE(width, 9);
  return b;
}

function request(body?: Buffer, type = 'image/jpeg', field = 'image'): Request {
  const fd = new FormData();
  if (body) fd.append(field, new File([new Uint8Array(body)], 'recipe.jpg', { type }));
  return new Request('http://test/api/recipes/import/photo', { method: 'POST', body: fd });
}

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  db = test.db as unknown as TenantDb;
  h.db = db;
  await db.execute(sql.raw('SET ROLE tenant_app;'));
});

afterAll(async () => {
  await db.execute(sql.raw('RESET ROLE;'));
  await client.close();
});

beforeEach(() => {
  h.manager = true;
  h.orgId = ORG_A;
  h.userId = 'user_1';
  h.role = 'manager';
  h.monthlyLimit = 50;
  h.throws = false;
  h.busy = false;
  h.result = {
    recipe: goodRecipe,
    usage: { inputTokens: 1000, outputTokens: 200 },
    model: 'gemini-3.5-flash',
    provider: 'google',
  };
});

describe('POST /api/recipes/import/photo — gates (before the image is read)', () => {
  it('refuses a kitchen user with 403', async () => {
    h.manager = false;
    const res = await POST(request(jpegBytes()));
    expect(res.status).toBe(403);
  });

  it('returns 429 once the aiExtraction rate limit is exceeded', async () => {
    h.userId = 'rl_user';
    const key = rateLimitKey('aiExtraction', `${ORG_A}:rl_user`);
    await db.insert(rateLimits).values({ key, windowStart: sql`now()`, count: 5 });
    const res = await POST(request(jpegBytes()));
    expect(res.status).toBe(429);
  });
});

describe('POST /api/recipes/import/photo — image validation', () => {
  it('rejects a non-image (PDF bytes with an image mime) with 415', async () => {
    const pdf = Buffer.from('%PDF-1.7 not an image', 'ascii');
    const res = await POST(request(pdf, 'image/png'));
    expect(res.status).toBe(415);
  });

  it('rejects a missing file with 400', async () => {
    const res = await POST(request());
    expect(res.status).toBe(400);
  });
});

describe('POST /api/recipes/import/photo — monthly usage cap', () => {
  it('returns 402 USAGE_LIMIT_REACHED when the cap is reached, staging nothing', async () => {
    h.userId = 'cap_user';
    h.monthlyLimit = 0;
    const res = await POST(request(jpegBytes()));
    expect(res.status).toBe(402);
    expect((await res.json()).code).toBe('USAGE_LIMIT_REACHED');

    // No attempt was created for this user's org beyond what other tests made.
    const capUserAttempts = await runInOrg(db, ORG_A, (tx) =>
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(aiExtractionAttempts)
        .where(eq(aiExtractionAttempts.actorUserId, 'cap_user')),
    );
    expect(capUserAttempts[0]?.n).toBe(0);
  });
});

describe('POST /api/recipes/import/photo — success', () => {
  it('stages a recipe_photo job, succeeds the attempt, and audits ai.extract in the active org', async () => {
    h.userId = 'happy_user';
    const res = await POST(request(jpegBytes()));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(typeof body.jobId).toBe('string');
    expect(body.recipePayload.recipes).toHaveLength(1);
    expect(body.recipePayload.recipes[0].lines).toHaveLength(2);
    // The low-confidence ingredient raised a flag.
    expect(body.qualityFlags).toContain('low_confidence');

    // The job is a recipe_photo / photo job in ORG_A.
    const job = await runInOrg(db, ORG_A, (tx) =>
      tx.select().from(importJobs).where(eq(importJobs.id, body.jobId)),
    );
    expect(job[0]?.entity).toBe('recipe_photo');
    expect(job[0]?.format).toBe('photo');
    expect(job[0]?.status).toBe('parsed');

    // The attempt succeeded and links the job.
    const attempt = await runInOrg(db, ORG_A, (tx) =>
      tx
        .select()
        .from(aiExtractionAttempts)
        .where(eq(aiExtractionAttempts.actorUserId, 'happy_user')),
    );
    expect(attempt[0]?.status).toBe('succeeded');
    expect(attempt[0]?.importJobId).toBe(body.jobId);
    expect(attempt[0]?.qualityFlags).toContain('low_confidence');

    // ai.extract audit in ORG_A; ORG_B sees nothing.
    const audited = await runInOrg(db, ORG_A, (tx) =>
      tx
        .select({ action: auditLog.action })
        .from(auditLog)
        .where(and(eq(auditLog.organizationId, ORG_A), eq(auditLog.action, 'ai.extract'))),
    );
    expect(audited.length).toBeGreaterThanOrEqual(1);

    const inB = await runInOrg(db, ORG_B, (tx) =>
      tx.select({ n: sql<number>`count(*)::int` }).from(importJobs),
    );
    expect(inB[0]?.n).toBe(0);
  });
});

describe('POST /api/recipes/import/photo — provider failure', () => {
  it('returns 502 AI_EXTRACTION_FAILED, records a failed attempt, and stages no job', async () => {
    h.userId = 'fail_user';
    h.throws = true;
    const res = await POST(request(jpegBytes()));
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('AI_EXTRACTION_FAILED');

    const attempt = await runInOrg(db, ORG_A, (tx) =>
      tx
        .select()
        .from(aiExtractionAttempts)
        .where(eq(aiExtractionAttempts.actorUserId, 'fail_user')),
    );
    expect(attempt[0]?.status).toBe('failed');
    expect(attempt[0]?.errorCode).toBe('AI_EXTRACTION_FAILED');
    expect(attempt[0]?.importJobId).toBeNull();

    const failAudit = await runInOrg(db, ORG_A, (tx) =>
      tx
        .select({ action: auditLog.action })
        .from(auditLog)
        .where(and(eq(auditLog.organizationId, ORG_A), eq(auditLog.action, 'ai.extractFailed'))),
    );
    expect(failAudit.length).toBeGreaterThanOrEqual(1);
  });

  it('returns 503 AI_EXTRACTION_BUSY on a transient overload (retryable), not 502', async () => {
    h.userId = 'busy_user';
    h.busy = true;
    const res = await POST(request(jpegBytes()));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('AI_EXTRACTION_BUSY');

    const attempt = await runInOrg(db, ORG_A, (tx) =>
      tx
        .select()
        .from(aiExtractionAttempts)
        .where(eq(aiExtractionAttempts.actorUserId, 'busy_user')),
    );
    expect(attempt[0]?.status).toBe('failed');
    expect(attempt[0]?.errorCode).toBe('AI_EXTRACTION_BUSY');
    expect(attempt[0]?.importJobId).toBeNull();
  });
});
