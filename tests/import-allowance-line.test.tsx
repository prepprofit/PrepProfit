import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/lib/i18n/messages/en.json';
import { ImportAllowanceLine } from '@/components/app/import/import-allowance-line';
import type { ImportAllowance } from '@/lib/data/ai-usage';

/**
 * The import allowance line states real used/limit/reset data, and keeps unknown,
 * in-flight and exhausted apart — an unknown allowance must never read as zero usage or
 * as unlimited.
 */
const base: ImportAllowance = {
  feature: 'photo_recipe_extraction',
  used: 2,
  limit: 500,
  availableNow: 498,
  resetAt: '2026-10-01T00:00:00.000Z',
};

function render(method: 'photo' | 'invoice', allowance: ImportAllowance | null) {
  return renderToStaticMarkup(
    createElement(
      NextIntlClientProvider,
      { locale: 'en', messages },
      createElement(ImportAllowanceLine, { method, allowance }),
    ),
  );
}

describe('ImportAllowanceLine', () => {
  it('shows real usage and the reset date', () => {
    const html = render('photo', base);
    expect(html).toContain('Photo imports: 2 of 500 used this month');
    expect(html).toContain('Resets October 1, 2026');
  });

  it('labels the invoice method separately', () => {
    expect(render('invoice', { ...base, feature: 'supplier_invoice_extraction', used: 7, limit: 40, availableNow: 33 })).toContain(
      'Invoice imports: 7 of 40 used this month',
    );
  });

  it('says clearly when the allowance is exhausted, with the reset date', () => {
    const html = render('photo', { ...base, used: 10, limit: 10, availableNow: 0 });
    expect(html).toContain('all 10 used this month');
    expect(html).toContain('October 1, 2026');
    expect(html).toContain('role="alert"');
  });

  it('distinguishes in-flight slots from a used-up allowance', () => {
    const html = render('photo', { ...base, used: 9, limit: 10, availableNow: 0 });
    expect(html).toContain('9 of 10 used');
    expect(html).toContain('still being processed');
    expect(html).not.toContain('all 10 used');
  });

  it('renders unknown usage as unavailable — never zero, never unlimited', () => {
    const html = render('photo', null);
    expect(html).toContain('usage couldn’t be loaded');
    expect(html).not.toMatch(/0 of|unlimited/i);
  });

  it('handles a plan with no allowance', () => {
    expect(render('photo', { ...base, limit: 0, used: 0, availableNow: 0 })).toContain('aren’t included');
  });
});
