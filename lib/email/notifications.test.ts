import { describe, expect, it, vi } from 'vitest';

/**
 * Lifecycle notification builders (Sprint 5d). The provider is a recording fake —
 * nothing is sent. Proves the low-stock line formatting is correct and PII-free,
 * and that welcome/low-stock send to the right recipient with a non-empty subject.
 * next-intl is mocked to echo keys so assertions don't depend on copy.
 */
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}));

import {
  lowStockSummaryLines,
  sendWelcomeEmail,
  sendLowStockEmail,
  type LowStockLineItem,
} from './notifications';
import type { EmailSender, SendEmailInput } from './resend';

function recordingSender(): { sender: EmailSender; calls: SendEmailInput[] } {
  const calls: SendEmailInput[] = [];
  return {
    calls,
    sender: {
      async send(input) {
        calls.push(input);
        return { id: 'msg_test' };
      },
    },
  };
}

describe('lowStockSummaryLines', () => {
  it('formats one line per item with the dimension unit suffix', () => {
    const items: LowStockLineItem[] = [
      { name: 'Butter', stockCanonical: 200, thresholdCanonical: 500, dimension: 'weight' },
      { name: 'Milk', stockCanonical: 1000, thresholdCanonical: 2000, dimension: 'volume' },
      { name: 'Eggs', stockCanonical: 6, thresholdCanonical: 12, dimension: 'count' },
    ];
    expect(lowStockSummaryLines(items)).toEqual([
      'Butter — 200 g left (threshold 500 g)',
      'Milk — 1000 ml left (threshold 2000 ml)',
      'Eggs — 6 left (threshold 12)',
    ]);
  });
});

describe('sendWelcomeEmail', () => {
  it('sends to the recipient with no attachments', async () => {
    const { sender, calls } = recordingSender();
    await sendWelcomeEmail(sender, { to: 'chef@example.com', orgName: 'Acme' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.to).toBe('chef@example.com');
    expect(calls[0]!.subject).toBe('welcome.subject');
    expect(calls[0]!.attachments).toEqual([]);
  });
});

describe('sendLowStockEmail', () => {
  it('sends a digest listing each low item to the recipient', async () => {
    const { sender, calls } = recordingSender();
    await sendLowStockEmail(sender, {
      to: 'orders@example.com',
      orgName: 'Acme',
      items: [
        { name: 'Butter', stockCanonical: 200, thresholdCanonical: 500, dimension: 'weight' },
      ],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.to).toBe('orders@example.com');
    expect(calls[0]!.html).toContain('Butter — 200 g left');
  });

  it('escapes HTML in ingredient names', async () => {
    const { sender, calls } = recordingSender();
    await sendLowStockEmail(sender, {
      to: 'orders@example.com',
      orgName: 'Acme',
      items: [
        { name: 'A & B <x>', stockCanonical: 1, thresholdCanonical: 2, dimension: 'count' },
      ],
    });
    expect(calls[0]!.html).toContain('A &amp; B &lt;x&gt;');
    expect(calls[0]!.html).not.toContain('<x>');
  });
});
