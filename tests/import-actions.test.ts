import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import { runInOrg } from '@/lib/db/tenant';
import type { TenantDb, TenantTx } from '@/lib/db/tenant';
import { ingredients } from '@/lib/db/schema';

/**
 * Proves the import Server Actions enforce the security contract end-to-end
 * against a real PGlite database wired through a mocked `@/lib/db`:
 *   - RBAC: kitchen is FORBIDDEN before any data access.
 *   - confirm is idempotent (a second confirm applies nothing more).
 *   - a forged confirm with another org active cannot reach the job (NOT_FOUND)
 *     and writes nothing.
 */
const h = vi.hoisted(() => ({
  db: null as unknown as TenantDb,
  withOrg: null as unknown as <T>(org: string, fn: (tx: TenantTx) => Promise<T>) => Promise<T>,
  manager: true,
  org: 'org_a',
  user: 'user_a',
}));

vi.mock('@/lib/auth', () => ({
  isManager: vi.fn(async () => h.manager),
  getOrgId: vi.fn(async () => h.org),
  getUserId: vi.fn(async () => h.user),
  getUserRole: vi.fn(async () => (h.manager ? 'manager' : 'kitchen')),
}));

vi.mock('@/lib/db', () => ({
  getDb: () => h.db,
  withOrg: (org: string, fn: (tx: TenantTx) => unknown) => h.withOrg(org, fn as never),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { previewImportAction, confirmImportAction } from '@/app/(app)/import/actions';

let client: PGlite;

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  h.db = test.db as unknown as TenantDb;
  h.withOrg = (org, fn) => runInOrg(h.db, org, fn);
});

afterAll(async () => {
  await client.close();
});

afterEach(() => {
  h.manager = true;
  h.org = 'org_a';
  h.user = 'user_a';
  vi.clearAllMocks();
});

function previewForm(content: string, filename = 'x.csv'): FormData {
  const fd = new FormData();
  fd.set('entity', 'ingredients');
  fd.set('format', 'csv');
  fd.set('file', new File([content], filename, { type: 'text/csv' }));
  return fd;
}

function confirmForm(jobId: string): FormData {
  const fd = new FormData();
  fd.set('jobId', jobId);
  return fd;
}

const CSV = 'name,dimension,price\nButter,weight,4.50\nSugar,weight,0.90';

async function countNamed(org: string, name: string): Promise<number> {
  const rows = await h.db
    .select()
    .from(ingredients)
    .where(and(eq(ingredients.organizationId, org), eq(ingredients.name, name)));
  return rows.length;
}

describe('import actions — RBAC', () => {
  it('kitchen is FORBIDDEN on both preview and confirm', async () => {
    h.manager = false;
    expect(await previewImportAction(null, previewForm(CSV))).toEqual({
      ok: false,
      code: 'FORBIDDEN',
    });
    expect(await confirmImportAction(null, confirmForm('job_x'))).toEqual({
      ok: false,
      code: 'FORBIDDEN',
    });
  });
});

describe('import actions — preview then confirm', () => {
  it('stages a preview and applies it once, idempotently', async () => {
    const preview = await previewImportAction(null, previewForm(CSV));
    if (!preview.ok || preview.phase !== 'preview') throw new Error('expected preview');
    expect(preview.preview.counts).toMatchObject({ importable: 2, invalid: 0 });
    const { jobId } = preview.preview;

    const first = await confirmImportAction(null, confirmForm(jobId));
    expect(first).toMatchObject({ ok: true, phase: 'committed', created: 2 });
    expect(await countNamed('org_a', 'Butter')).toBe(1);

    // Second confirm of the SAME job is a no-op success — no extra rows.
    const second = await confirmImportAction(null, confirmForm(jobId));
    expect(second).toMatchObject({
      ok: true,
      phase: 'committed',
      alreadyCommitted: true,
    });
    expect(await countNamed('org_a', 'Butter')).toBe(1);
  });
});

describe('import actions — forged confirm cannot cross orgs', () => {
  it('confirming org A’s job with org B active is NOT_FOUND and writes nothing', async () => {
    const preview = await previewImportAction(null, previewForm(CSV));
    if (!preview.ok || preview.phase !== 'preview') throw new Error('expected preview');
    const { jobId } = preview.preview;

    // Switch the active org to B and replay the same job id (the only thing a
    // client could forge). The job belongs to A, so org B can never reach it.
    h.org = 'org_b';
    const forged = await confirmImportAction(null, confirmForm(jobId));
    expect(forged).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect(await countNamed('org_b', 'Butter')).toBe(0);
  });
});
