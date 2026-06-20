import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit test for the observability seam (Sprint 5a). Proves the error contract is
 * unchanged AND that Sentry forwarding is wired and FAIL-OPEN: `logError` still
 * mints an `eventId` and writes one structured `console.error`, it forwards to
 * Sentry tagged with the same id (org id as extra, never PII), and if
 * `captureException` throws it is swallowed so the id is still returned. The
 * provider is fully mocked — nothing is ever sent.
 */

const h = vi.hoisted(() => ({
  captureException: vi.fn(),
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => h.captureException(...args),
}));

import { logError, unexpected } from './observability';

describe('logError', () => {
  beforeEach(() => {
    h.captureException.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns an eventId and logs one structured console.error line', () => {
    const eventId = logError({ action: 'createFolderAction', orgId: 'org_1' }, new Error('boom'));

    expect(eventId).toBeTruthy();
    expect(console.error).toHaveBeenCalledTimes(1);
    const payload = JSON.parse((console.error as ReturnType<typeof vi.fn>).mock.calls[0]![0]);
    expect(payload).toMatchObject({
      level: 'error',
      eventId,
      action: 'createFolderAction',
      orgId: 'org_1',
      message: 'boom',
    });
  });

  it('forwards to Sentry tagged with the same eventId/action, org id as extra', () => {
    const err = new Error('kaboom');
    const eventId = logError({ action: 'someAction', orgId: 'org_42' }, err);

    expect(h.captureException).toHaveBeenCalledTimes(1);
    const [forwarded, options] = h.captureException.mock.calls[0]!;
    expect(forwarded).toBe(err);
    expect(options).toEqual({
      tags: { action: 'someAction', eventId },
      extra: { orgId: 'org_42' },
    });
  });

  it('is fail-open: a throwing captureException never escalates the error', () => {
    h.captureException.mockImplementation(() => {
      throw new Error('sentry down');
    });

    let eventId: string | undefined;
    expect(() => {
      eventId = logError({ action: 'someAction' }, new Error('original'));
    }).not.toThrow();
    expect(eventId).toBeTruthy();
  });
});

describe('unexpected', () => {
  beforeEach(() => {
    h.captureException.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs + forwards and returns a generic UNEXPECTED ActionResult', () => {
    const result = unexpected('payAction', new Error('nope'), 'org_7');

    expect(result).toEqual({ ok: false, code: 'UNEXPECTED' });
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(h.captureException).toHaveBeenCalledTimes(1);
  });
});
