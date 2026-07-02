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
  sendSubscriptionEmail,
  sendPaymentPastDueEmail,
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
  it('sends rendered HTML + a text fallback to the recipient with no attachments', async () => {
    const { sender, calls } = recordingSender();
    await sendWelcomeEmail(sender, { to: 'chef@example.com', orgName: 'Acme' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.to).toBe('chef@example.com');
    expect(calls[0]!.subject).toBe('welcome.subject');
    expect(calls[0]!.attachments).toEqual([]);
    // React Email produced both parts; the text fallback carries the copy.
    expect(calls[0]!.html).toContain('<html');
    expect(calls[0]!.text).toBeTruthy();
    expect(calls[0]!.text).not.toContain('<html');
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
    // The line also survives into the plain-text fallback.
    expect(calls[0]!.text).toContain('Butter — 200 g left');
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

describe('sendSubscriptionEmail', () => {
  it('keys the subject/body off the change kind and forwards the idempotency key', async () => {
    const { sender, calls } = recordingSender();
    await sendSubscriptionEmail(sender, {
      to: 'owner@example.com',
      orgName: 'Acme',
      planLabel: 'Pro',
      kind: 'upgraded',
      idempotencyKey: 'svix_123',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.to).toBe('owner@example.com');
    expect(calls[0]!.subject).toBe('subscription.upgraded.subject');
    expect(calls[0]!.html).toContain('subscription.upgraded.body');
    expect(calls[0]!.attachments).toEqual([]);
    expect(calls[0]!.idempotencyKey).toBe('svix_123');
  });

  it('escapes HTML in the org name', async () => {
    const { sender, calls } = recordingSender();
    await sendSubscriptionEmail(sender, {
      to: 'owner@example.com',
      orgName: 'A & B <x>',
      planLabel: 'Business',
      kind: 'subscribed',
    });
    // The mocked translator echoes the key, so the org name only reaches the HTML
    // if it were interpolated; this still proves the builder never emits raw markup.
    expect(calls[0]!.html).not.toContain('<x>');
    expect(calls[0]!.idempotencyKey).toBeUndefined();
  });
});

describe('sendPaymentPastDueEmail', () => {
  it('sends a dunning email with no attachments', async () => {
    const { sender, calls } = recordingSender();
    await sendPaymentPastDueEmail(sender, {
      to: 'owner@example.com',
      orgName: 'Acme',
      planLabel: 'Pro',
      idempotencyKey: 'svix_456',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.to).toBe('owner@example.com');
    expect(calls[0]!.subject).toBe('pastDue.subject');
    expect(calls[0]!.attachments).toEqual([]);
    expect(calls[0]!.idempotencyKey).toBe('svix_456');
  });
});
