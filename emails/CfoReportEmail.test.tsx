import { describe, expect, it } from 'vitest';
import { renderEmail } from '@/lib/email/render';
import { CfoReportEmail } from './CfoReportEmail';

/**
 * The weekly CFO digest template (React Email migration). Section item labels can be
 * recipe/ingredient names (user data), so a hostile name must be escaped; the
 * template renders its summary, sections, confidence notes and optional CTA with a
 * text fallback, and never builds raw HTML.
 */
describe('CfoReportEmail', () => {
  const hostile = '<script>alert(1)</script> & Sons';

  function render(withCta: boolean) {
    return renderEmail(
      <CfoReportEmail
        brandName="PrepProfit"
        footerLines={['Footer']}
        preview="Weekly CFO report"
        heading="Weekly CFO report"
        periodLabel="22 Jun to 28 Jun"
        summary={[
          { label: 'Revenue', value: '€1,234 (+5.2%)', emphasize: true },
          { label: 'Food cost', value: '31.2% (+1.1 pts)' },
        ]}
        sections={[
          { title: 'Items to reprice', items: [{ left: hostile, right: '40% margin' }] },
        ]}
        confidenceTitle="What limits this report"
        confidenceNotes={['Some sold items are not priced.']}
        cta={withCta ? { href: 'https://app.example.com/reports/cfo?weekTo=2026-06-28', label: 'Open the full report' } : undefined}
      />,
    );
  }

  it('renders summary, section and confidence with a text fallback', async () => {
    const { html, text } = await render(false);
    expect(html).toContain('€1,234 (+5.2%)');
    expect(html).toContain('Items to reprice');
    expect(html).toContain('Some sold items are not priced.');
    expect(text).toContain('€1,234 (+5.2%)');
  });

  it('escapes a hostile item name and omits the CTA when none is given', async () => {
    const { html } = await render(false);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp; Sons');
    expect(html).not.toContain('/reports/cfo');
  });

  it('renders the CTA link when an absolute URL is provided', async () => {
    const { html } = await render(true);
    expect(html).toContain('https://app.example.com/reports/cfo?weekTo=2026-06-28');
    expect(html).toContain('Open the full report');
  });
});
