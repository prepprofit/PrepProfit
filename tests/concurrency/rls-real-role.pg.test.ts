import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import { businessTables } from '@/lib/db/schema';
import { NON_TENANT_RUNTIME_TABLES } from '@/lib/db/runtime-grants';

/**
 * REAL-Postgres proof that RLS isolates a LOGIN role without `BYPASSRLS` — the
 * property production depends on since 2026-08-04 (docs/rls-app-role-plan.md).
 *
 * Why opt-in, and what this adds over `tests/isolation.test.ts`: that suite already
 * exercises the policies properly (it runs under `SET ROLE tenant_app`, and a
 * non-privileged role obeys RLS in PGlite as it does anywhere). What it cannot cover
 * is real Postgres rather than WASM, a real login role rather than `SET ROLE`, and the
 * GRANTs — PGlite's helper hands the test role every privilege, so a missing grant is
 * invisible there. See docs/rls-regression-guard-plan.md §C.
 *
 * Setup (plan D4 — a DISPOSABLE branch made from an EMPTY one, never from production,
 * so no customer data ends up in a test database):
 *
 *   1. create a Neon branch, then:  DATABASE_URL=<branch-owner> npm run db:migrate
 *   2. on that branch, as the owner:
 *        CREATE ROLE test_app LOGIN PASSWORD '…' NOBYPASSRLS;
 *        GRANT USAGE ON SCHEMA public TO test_app;
 *        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO test_app;
 *   3. TEST_DATABASE_URL_APP=<test_app connection string> npm test
 *
 * The variable is deliberately NOT `TEST_DATABASE_URL` (used by the concurrency tests
 * in this folder): those need the OWNER, this one needs a role that is not the owner.
 * Pointing this at an owner string would make every assertion below fail — correctly.
 *
 * Without the variable the whole describe is skipped, so CI stays green with no
 * database and no secret (plan D3).
 */
const TEST_DATABASE_URL_APP = process.env.TEST_DATABASE_URL_APP;

if (typeof globalThis.WebSocket === 'undefined') {
  neonConfig.webSocketConstructor = ws;
}

const ORG = `org_rls_a_${Date.now()}`;
const OTHER_ORG = `org_rls_b_${Date.now()}`;

describe.skipIf(!TEST_DATABASE_URL_APP)(
  'RLS under a real NOBYPASSRLS login role',
  () => {
    let pool: Pool;

    beforeAll(async () => {
      pool = new Pool({ connectionString: TEST_DATABASE_URL_APP });

      const who = await pool.query<{ role: string; bypasses: boolean }>(
        `select current_user::text as role,
                coalesce((select rolbypassrls from pg_roles where rolname = current_user), false) as bypasses`,
      );
      // Guard the guard: if this is pointed at a bypassing role, every expectation
      // below would fail for a confusing reason. Say the real reason instead.
      if (who.rows[0]?.bypasses) {
        throw new Error(
          `TEST_DATABASE_URL_APP connects as "${who.rows[0].role}", which has BYPASSRLS. ` +
            'This test needs a role WITHOUT it — see the header of this file.',
        );
      }
    });

    afterAll(async () => {
      await pool?.end();
    });

    it('returns zero rows from every business table when no org is set', async () => {
      // Iterating the generated list means a table added by a future sprint is covered
      // the day it exists, with no edit here.
      const counts = await Promise.all(
        businessTables.map(async (table) => {
          const r = await pool.query<{ n: number }>(
            `select count(*)::int as n from ${table}`,
          );
          return [table, r.rows[0]?.n] as const;
        }),
      );

      expect(counts.filter(([, n]) => n !== 0)).toEqual([]);
    });

    it('keeps the RLS-free infra tables reachable without any org', async () => {
      // The rate limiter runs BEFORE any withOrg. If this breaks, every rate-limited
      // route breaks with it.
      for (const table of NON_TENANT_RUNTIME_TABLES) {
        await expect(
          pool.query(`select count(*)::int as n from ${table}`),
        ).resolves.toBeTruthy();
      }

      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(
          `insert into rate_limits (key, window_start, count) values ($1, now(), 1)`,
          [`rls-real-role-${Date.now()}`],
        );
        await client.query('rollback');
      } finally {
        client.release();
      }
    });

    it('shows only the active org rows, and rejects cross-org writes', async () => {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(`select set_config('app.current_org_id', $1, true)`, [ORG]);

        await client.query(
          `insert into recipes (id, organization_id, name) values ($1, $2, 'in-org')`,
          [`rls-real-${Date.now()}`, ORG],
        );

        const visible = await client.query<{ n: number; orgs: number }>(
          `select count(*)::int as n, count(distinct organization_id)::int as orgs from recipes`,
        );
        expect(visible.rows[0]?.n).toBe(1);
        expect(visible.rows[0]?.orgs).toBe(1);

        // WITH CHECK must reject a row tagged with a different org: 42501.
        await expect(
          client.query(
            `insert into recipes (id, organization_id, name) values ($1, $2, 'cross-org')`,
            [`rls-real-x-${Date.now()}`, OTHER_ORG],
          ),
        ).rejects.toMatchObject({ code: '42501' });

        await client.query('rollback');
      } finally {
        client.release();
      }
    });

    it('blocks retagging a row into another org', async () => {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(`select set_config('app.current_org_id', $1, true)`, [ORG]);
        await client.query(
          `insert into recipes (id, organization_id, name) values ($1, $2, 'retag me')`,
          [`rls-real-r-${Date.now()}`, ORG],
        );

        await expect(
          client.query(`update recipes set organization_id = $1`, [OTHER_ORG]),
        ).rejects.toMatchObject({ code: '42501' });

        await client.query('rollback');
      } finally {
        client.release();
      }
    });

    it('makes audit_log and inventory_movements append-only in practice', async () => {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(`select set_config('app.current_org_id', $1, true)`, [ORG]);

        // No UPDATE/DELETE policy under FORCE RLS means these match zero rows rather
        // than erroring — the trail cannot be edited or erased, not even by the app.
        const updated = await client.query(`update audit_log set action = 'tampered'`);
        expect(updated.rowCount).toBe(0);

        const deleted = await client.query('delete from inventory_movements');
        expect(deleted.rowCount).toBe(0);

        await client.query('rollback');
      } finally {
        client.release();
      }
    });
  },
);
