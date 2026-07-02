import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The Resend-backed sender (React Email migration slice). Proves the optional
 * `text` part is forwarded to the SDK only when present, that HTML-only sends omit
 * it, and that a provider `error` is translated into a thrown, key-free error. The
 * Resend SDK is mocked — no network.
 */
const sendMock = vi.fn();

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: sendMock };
    constructor(_apiKey: string) {}
  },
}));

vi.mock('@/lib/env', () => ({
  emailEnv: () => ({ apiKey: 're_test', from: 'PrepProfit <info@example.com>' }),
}));

import { getEmailSender } from './resend';

afterEach(() => {
  sendMock.mockReset();
});

describe('getEmailSender.send', () => {
  it('forwards the text part when present', async () => {
    sendMock.mockResolvedValue({ data: { id: 'msg_1' }, error: null });
    const res = await getEmailSender().send({
      to: 'chef@example.com',
      subject: 'Hi',
      html: '<p>Hi</p>',
      text: 'Hi',
      attachments: [],
    });
    expect(res).toEqual({ id: 'msg_1' });
    const payload = sendMock.mock.calls[0]![0] as { text?: string };
    expect(payload.text).toBe('Hi');
  });

  it('omits the text field entirely for an HTML-only send', async () => {
    sendMock.mockResolvedValue({ data: { id: 'msg_2' }, error: null });
    await getEmailSender().send({
      to: 'chef@example.com',
      subject: 'Hi',
      html: '<p>Hi</p>',
      attachments: [],
    });
    const payload = sendMock.mock.calls[0]![0] as Record<string, unknown>;
    expect('text' in payload).toBe(false);
  });

  it('throws a key-free error when the provider returns an error', async () => {
    sendMock.mockResolvedValue({ data: null, error: { message: 'boom' } });
    await expect(
      getEmailSender().send({
        to: 'chef@example.com',
        subject: 'Hi',
        html: '<p>Hi</p>',
        attachments: [],
      }),
    ).rejects.toThrow(/boom/);
  });
});
