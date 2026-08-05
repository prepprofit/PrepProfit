import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RUNTIME_DB_ROLE,
  checkRuntimeRoleIsolation,
  describeBypassingRole,
  reportRuntimeRoleIsolation,
} from './runtime-role';

/**
 * The boot-time guard is the only thing standing between us and a silent RLS
 * regression (docs/rls-regression-guard-plan.md §A), so what matters here is not just
 * that it detects the bad case but that it is genuinely FAIL-OPEN: a probe that throws
 * must never propagate, or the guard becomes the outage it was meant to prevent.
 */
describe('checkRuntimeRoleIsolation', () => {
  it('reports the expected state when the role obeys RLS', async () => {
    const status = await checkRuntimeRoleIsolation(async () => ({
      role: RUNTIME_DB_ROLE,
      bypasses: false,
    }));

    expect(status).toEqual({ kind: 'isolated', role: RUNTIME_DB_ROLE });
  });

  it('raises the alarm when the connected role has BYPASSRLS', async () => {
    const status = await checkRuntimeRoleIsolation(async () => ({
      role: 'neondb_owner',
      bypasses: true,
    }));

    expect(status).toEqual({ kind: 'bypassing', role: 'neondb_owner' });
  });

  it('is unknown — not an alarm — when the probe throws', async () => {
    const status = await checkRuntimeRoleIsolation(async () => {
      throw new Error('connection terminated');
    });

    expect(status.kind).toBe('unknown');
    expect(status).toMatchObject({ reason: 'connection terminated' });
  });

  it('is unknown when the probe returns no row', async () => {
    const status = await checkRuntimeRoleIsolation(async () => null);
    expect(status.kind).toBe('unknown');
  });
});

describe('reportRuntimeRoleIsolation', () => {
  afterEach(() => vi.restoreAllMocks());

  it('logs an error naming the role and the fix when RLS is bypassed', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const status = await reportRuntimeRoleIsolation(async () => ({
      role: 'neondb_owner',
      bypasses: true,
    }));

    expect(status.kind).toBe('bypassing');
    expect(error).toHaveBeenCalledTimes(1);
    const logged = String(error.mock.calls[0]?.[0]);
    expect(logged).toContain('runtimeRoleBypassesRls');
    expect(logged).toContain('neondb_owner');
    expect(logged).toContain(RUNTIME_DB_ROLE);
  });

  it('stays quiet when the role is correct', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await reportRuntimeRoleIsolation(async () => ({
      role: RUNTIME_DB_ROLE,
      bypasses: false,
    }));

    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns without throwing when the probe fails — the boot must survive', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      reportRuntimeRoleIsolation(async () => {
        throw new Error('ECONNREFUSED');
      }),
    ).resolves.toMatchObject({ kind: 'unknown' });

    // A failure to observe is a warning, never the security alarm.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });
});

describe('describeBypassingRole', () => {
  it('names the offending role, the consequence and the remedy', () => {
    const text = describeBypassingRole('neondb_owner');

    expect(text).toContain('neondb_owner');
    expect(text).toContain('BYPASSRLS');
    expect(text).toContain('DATABASE_URL');
    expect(text).toContain(RUNTIME_DB_ROLE);
  });
});
