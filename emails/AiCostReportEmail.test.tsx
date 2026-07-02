import { describe, expect, it } from 'vitest';
import { renderEmail } from '@/lib/email/render';
import { AiCostReportEmail } from './AiCostReportEmail';

/**
 * The operator AI-spend digest (React Email migration). Org names are user data, so
 * a hostile name must be escaped; the report must render its labels/figures and a
 * text fallback, and never build raw HTML.
 */
describe('AiCostReportEmail', () => {
  const hostile = '<script>alert(1)</script> & Sons';

  function render() {
    return renderEmail(
      <AiCostReportEmail
        brandName="PrepProfit"
        footerLines={['Footer']}
        preview="AI spend report"
        heading="AI extraction spend"
        periodLabel="Last 7 days"
        totals={[
          { label: 'Estimated spend', value: '$1.23', emphasize: true },
          { label: 'Extractions', value: '42' },
        ]}
        byOrgTitle="By organization"
        orgHeader={{ name: 'Organization', count: 'Extractions', spend: 'Estimated spend' }}
        orgRows={[{ name: hostile, count: '5', spend: '$0.10' }]}
        emptyText="No extractions in this period."
        notes={['Model: gemini-2.5-flash']}
      />,
    );
  }

  it('renders labels and figures with a text fallback', async () => {
    const { html, text } = await render();
    expect(html).toContain('AI extraction spend');
    expect(html).toContain('$1.23');
    expect(html).toContain('By organization');
    // The plaintext converter upper-cases the H1 heading, so assert on stable
    // body content instead.
    expect(text).toContain('By organization');
    expect(text).toContain('$1.23');
  });

  it('escapes a hostile org name (no raw markup)', async () => {
    const { html } = await render();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp; Sons');
  });
});
