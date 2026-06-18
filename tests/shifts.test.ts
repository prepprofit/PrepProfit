import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import type { TenantDb } from '@/lib/db/tenant';
import { createEmployee } from '@/lib/data/employees';
import { closeShift, createShift, getShiftById } from '@/lib/data/shifts';

const ORG = 'org_shifts';

let client: PGlite;
let db: TenantDb;
let employeeId: string;

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  db = test.db as unknown as TenantDb;
  const emp = await createEmployee(db, ORG, {
    name: 'Cook',
    email: null,
    hourlyRateCents: 1500,
  });
  employeeId = emp.id;
});

afterAll(async () => {
  await client.close();
});

describe('closeShift — only closes OPEN shifts', () => {
  it('stamps the end of an open shift', async () => {
    const shift = await createShift(db, ORG, {
      employeeId,
      startedAtMs: Date.UTC(2026, 5, 15, 9),
      endedAtMs: null,
      breakMinutes: 0,
      note: null,
    });

    const end = Date.UTC(2026, 5, 15, 17);
    const closed = await closeShift(db, ORG, shift.id, end);
    expect(closed).not.toBeNull();
    expect(closed?.endedAt?.getTime()).toBe(end);
  });

  it('refuses to re-close an already-closed shift (end time is immutable)', async () => {
    const original = Date.UTC(2026, 5, 16, 17);
    const shift = await createShift(db, ORG, {
      employeeId,
      startedAtMs: Date.UTC(2026, 5, 16, 9),
      endedAtMs: original,
      breakMinutes: 0,
      note: null,
    });

    const tamper = Date.UTC(2026, 5, 16, 23);
    const result = await closeShift(db, ORG, shift.id, tamper);
    expect(result).toBeNull();

    // The original end time is untouched by the rejected re-close.
    const fresh = await getShiftById(db, ORG, shift.id);
    expect(fresh?.endedAt?.getTime()).toBe(original);
  });
});
