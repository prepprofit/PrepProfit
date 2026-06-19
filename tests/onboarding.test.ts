import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import { organizationSettings } from '@/lib/db/schema';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import {
  ensureOrgSettingsRow,
  markOnboarded,
} from '@/lib/data/org-settings';

/**
 * Sprint 4d — onboarding data layer. Proves (under the non-privileged tenant_app
 * role, RLS on): `markOnboarded` is SET-ONCE (never overwrites the first stamp),
 * creates the settings row when none exists, leaves seller identity untouched,
 * and is org-isolated; `ensureOrgSettingsRow` is an idempotent priming insert.
 */
describe('onboarding data layer (PGlite, RLS-scoped)', () => {
  const ORG_A = 'org_a';
  const ORG_B = 'org_b';
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

  function read(org: string) {
    return runInOrg(db, org, (tx) =>
      tx
        .select()
        .from(organizationSettings)
        .where(eq(organizationSettings.organizationId, org)),
    );
  }

  it('marks onboarding, creating the row when none exists', async () => {
    expect(await read(ORG_A)).toHaveLength(0);

    await runInOrg(db, ORG_A, (tx) => markOnboarded(tx, ORG_A));

    const rows = await read(ORG_A);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.onboardedAt).toBeInstanceOf(Date);
    // Defaults applied by the DB on the implicit insert.
    expect(rows[0]?.currency).toBe('EUR');
  });

  it('is set-once: a second call never overwrites the first timestamp', async () => {
    const first = (await read(ORG_A))[0]?.onboardedAt;
    expect(first).toBeInstanceOf(Date);

    await runInOrg(db, ORG_A, (tx) => markOnboarded(tx, ORG_A));

    const second = (await read(ORG_A))[0]?.onboardedAt;
    expect(second).toEqual(first);
  });

  it('preserves existing seller identity when marking onboarded', async () => {
    // Org B already saved its business name (e.g. via /settings) before onboarding.
    await runInOrg(db, ORG_B, (tx) =>
      tx
        .insert(organizationSettings)
        .values({ organizationId: ORG_B, businessName: 'Chez B' }),
    );

    await runInOrg(db, ORG_B, (tx) => markOnboarded(tx, ORG_B));

    const rows = await read(ORG_B);
    expect(rows[0]?.businessName).toBe('Chez B');
    expect(rows[0]?.onboardedAt).toBeInstanceOf(Date);
  });

  it('ensureOrgSettingsRow primes a row without onboarding, idempotently', async () => {
    const ORG_C = 'org_c';
    await runInOrg(db, ORG_C, (tx) => ensureOrgSettingsRow(tx, ORG_C));
    await runInOrg(db, ORG_C, (tx) => ensureOrgSettingsRow(tx, ORG_C));

    const rows = await read(ORG_C);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.onboardedAt).toBeNull();
  });

  it('does not let ensureOrgSettingsRow clobber existing settings', async () => {
    // Org B already has a name + onboarded stamp from the test above.
    const before = (await read(ORG_B))[0];
    await runInOrg(db, ORG_B, (tx) => ensureOrgSettingsRow(tx, ORG_B));
    const after = (await read(ORG_B))[0];
    expect(after?.businessName).toBe('Chez B');
    expect(after?.onboardedAt).toEqual(before?.onboardedAt);
  });

  it('isolates settings per org (RLS)', async () => {
    const fromA = await runInOrg(db, ORG_A, (tx) =>
      tx.select().from(organizationSettings),
    );
    // ORG_A sees only its own row, never ORG_B/ORG_C.
    expect(fromA).toHaveLength(1);
    expect(fromA[0]?.organizationId).toBe(ORG_A);
  });
});
