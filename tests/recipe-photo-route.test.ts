import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import {
  aiExtractionAttempts,
  auditLog,
  importJobs,
  ingredients,
  ingredientSuppliers,
  rateLimits,
  suppliers,
} from '@/lib/db/schema';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import { rateLimitKey } from '@/lib/rate-limit';

/**
 * Integration test for the AI photo extraction + stage routes (Sprint 4.7, improvement
 * plan §4). Runs the REAL handlers against PGlite under `tenant_app` (RLS enforced),
 * with auth, entitlements, the DB seam, and the Gemini PROVIDER stubbed — the provider
 * is never called for real (CLAUDE.md). Proves the canonical order
 * (RBAC→feature→rate→image→cap), that extraction returns an editable DRAFT + a
 * succeeded attempt with NO job yet + an `ai.extract` audit (active org only), that a
 * provider failure records a `failed` attempt and stages nothing, and that the stage
 * endpoint validates the edited draft server-side (ownership, needs_review blocking),
 * builds the recipe_photo job, and links it to the attempt (`ai.stage`).
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

// Import the routes AFTER the mocks are registered.
import { POST } from '@/app/api/recipes/import/photo/route';
import { POST as stagePOST } from '@/app/api/recipes/import/photo/stage/route';

/** Build a stage request from an extraction draft body (optionally patching lines). */
function stageRequest(
  draft: { attemptId: string; recipe: { name: string; yieldPortions: number | null; preparationNotes: string | null; lines: unknown[] } },
  lines?: unknown[],
): Request {
  const body = {
    attemptId: draft.attemptId,
    recipe: {
      name: draft.recipe.name,
      yieldPortions: draft.recipe.yieldPortions,
      preparationNotes: draft.recipe.preparationNotes,
      lines: lines ?? draft.recipe.lines,
    },
  };
  return new Request('http://test/api/recipes/import/photo/stage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

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

describe('POST /api/recipes/import/photo — success returns an editable draft', () => {
  it('returns a line-complete draft, succeeds the attempt WITHOUT a job, audits ai.extract', async () => {
    h.userId = 'happy_user';
    const res = await POST(request(jpegBytes()));
    expect(res.status).toBe(200);
    const body = await res.json();

    // The response is the editable draft — no job is staged yet.
    expect(typeof body.attemptId).toBe('string');
    expect(body.recipe.lines).toHaveLength(2);
    expect(body.recipe.lines.every((l: { status: string }) => l.status === 'ready')).toBe(true);
    expect(body.qualityFlags).toContain('low_confidence');

    // The attempt is succeeded but carries NO job link yet (§4.3).
    const attempt = await runInOrg(db, ORG_A, (tx) =>
      tx
        .select()
        .from(aiExtractionAttempts)
        .where(eq(aiExtractionAttempts.actorUserId, 'happy_user')),
    );
    expect(attempt[0]?.status).toBe('succeeded');
    expect(attempt[0]?.importJobId).toBeNull();
    expect(attempt[0]?.qualityFlags).toContain('low_confidence');

    // No import job was staged by extraction.
    const jobs = await runInOrg(db, ORG_A, (tx) =>
      tx.select({ n: sql<number>`count(*)::int` }).from(importJobs),
    );
    expect(jobs[0]?.n).toBe(0);

    // ai.extract audit in ORG_A; ORG_B sees nothing.
    const audited = await runInOrg(db, ORG_A, (tx) =>
      tx
        .select({ action: auditLog.action })
        .from(auditLog)
        .where(and(eq(auditLog.organizationId, ORG_A), eq(auditLog.action, 'ai.extract'))),
    );
    expect(audited.length).toBeGreaterThanOrEqual(1);
  });
});

describe('POST /api/recipes/import/photo — Phase 6 supplier pack inference', () => {
  it('fills a descriptor line\'s pack size from the org\'s supplier pack (→ ready)', async () => {
    h.userId = 'pack_user';
    // Seed an existing ingredient with a single supplier pack: 250 g of Butter.
    await runInOrg(db, ORG_A, async (tx) => {
      await tx
        .insert(ingredients)
        .values({
          id: 'ing_butter',
          organizationId: ORG_A,
          name: 'Butter',
          dimension: 'weight',
          priceCents: 0,
          needsPricing: true,
        });
      await tx
        .insert(suppliers)
        .values({ id: 'sup_dairy', organizationId: ORG_A, name: 'Dairy Co', normalizedName: 'dairy co' });
      await tx.insert(ingredientSuppliers).values({
        organizationId: ORG_A,
        ingredientId: 'ing_butter',
        supplierId: 'sup_dairy',
        packSize: '250',
        packUnit: 'g',
        isDefault: true,
      });
    });

    // The AI reads "1 block butter" — a descriptor with no pack size of its own.
    h.result = {
      recipe: {
        name: 'Buttered Toast',
        yieldPortions: 2,
        ingredients: [{ name: 'Butter', quantity: 1, unit: 'block', confidence: 0.95 }],
        preparationNotes: null,
        overallConfidence: 0.9,
        imageQuality: 'good',
      },
      usage: { inputTokens: 100, outputTokens: 20 },
      model: 'gemini-3.5-flash',
      provider: 'google',
    };

    const res = await POST(request(jpegBytes()));
    expect(res.status).toBe(200);
    const body = await res.json();

    const line = body.recipe.lines[0];
    expect(line.unitToken).toBe('block');
    // The supplier pack (250 g) was inferred → the line is now ready, no price touched.
    expect(line.packageSizeValue).toBe(250);
    expect(line.packageSizeUnitToken).toBe('g');
    expect(line.status).toBe('ready');

    // The audit records the count of inferred packs (PII-free).
    const audited = await runInOrg(db, ORG_A, (tx) =>
      tx
        .select({ metadata: auditLog.metadata })
        .from(auditLog)
        .where(and(eq(auditLog.organizationId, ORG_A), eq(auditLog.action, 'ai.extract'))),
    );
    const mine = audited.find((a) => (a.metadata as { packsResolved?: number }).packsResolved === 1);
    expect(mine).toBeDefined();
  });

  it('leaves the descriptor needs_review when the ingredient is unknown to the org', async () => {
    h.userId = 'nopack_user';
    h.result = {
      recipe: {
        name: 'Mystery Bake',
        yieldPortions: 1,
        ingredients: [{ name: 'Phyllo Pastry', quantity: 1, unit: 'pkt', confidence: 0.95 }],
        preparationNotes: null,
        overallConfidence: 0.9,
        imageQuality: 'good',
      },
      usage: { inputTokens: 100, outputTokens: 20 },
      model: 'gemini-3.5-flash',
      provider: 'google',
    };

    const body = await (await POST(request(jpegBytes()))).json();
    const line = body.recipe.lines[0];
    expect(line.packageSizeValue).toBeNull();
    expect(line.status).toBe('needs_review');
  });
});

describe('POST /api/recipes/import/photo/stage — server trust boundary', () => {
  it('stages the edited draft into a recipe_photo job, links the attempt, audits ai.stage', async () => {
    h.userId = 'stage_user';
    const draft = await (await POST(request(jpegBytes()))).json();

    const res = await stagePOST(stageRequest(draft));
    expect(res.status).toBe(200);
    const preview = await res.json();
    expect(typeof preview.jobId).toBe('string');
    expect(preview.recipePayload.recipes).toHaveLength(1);
    expect(preview.recipePayload.recipes[0].lines).toHaveLength(2);

    const job = await runInOrg(db, ORG_A, (tx) =>
      tx.select().from(importJobs).where(eq(importJobs.id, preview.jobId)),
    );
    expect(job[0]?.entity).toBe('recipe_photo');
    expect(job[0]?.format).toBe('photo');
    expect(job[0]?.status).toBe('parsed');

    // The attempt now links the staged job.
    const attempt = await runInOrg(db, ORG_A, (tx) =>
      tx
        .select()
        .from(aiExtractionAttempts)
        .where(eq(aiExtractionAttempts.actorUserId, 'stage_user')),
    );
    expect(attempt[0]?.importJobId).toBe(preview.jobId);

    const staged = await runInOrg(db, ORG_A, (tx) =>
      tx
        .select({ action: auditLog.action })
        .from(auditLog)
        .where(and(eq(auditLog.organizationId, ORG_A), eq(auditLog.action, 'ai.stage'))),
    );
    expect(staged.length).toBeGreaterThanOrEqual(1);

    const inB = await runInOrg(db, ORG_B, (tx) =>
      tx.select({ n: sql<number>`count(*)::int` }).from(importJobs),
    );
    expect(inB[0]?.n).toBe(0);
  });

  it('blocks staging (400) while an active line is still needs_review', async () => {
    h.userId = 'block_user';
    const draft = await (await POST(request(jpegBytes()))).json();
    // Make one line an unresolved descriptor (no pack size) → must block.
    const lines = draft.recipe.lines.map((l: Record<string, unknown>, i: number) =>
      i === 0 ? { ...l, unitToken: 'pkt', packageSizeValue: null, packageSizeUnitToken: null } : l,
    );
    const res = await stagePOST(stageRequest(draft, lines));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('INVALID_INPUT');
  });

  it('rejects an unknown / cross-context attempt id with 404', async () => {
    h.userId = 'owner_user';
    const draft = await (await POST(request(jpegBytes()))).json();
    const res = await stagePOST(stageRequest({ ...draft, attemptId: 'att_does_not_exist' }));
    expect(res.status).toBe(404);
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
