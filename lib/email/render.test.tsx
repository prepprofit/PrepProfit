import { describe, expect, it } from 'vitest';
import { Text } from '@react-email/components';
import { renderEmail } from './render';
import { BaseEmail } from '@/emails/_components/BaseEmail';

/**
 * The render seam (React Email migration). Proves `renderEmail` returns both an
 * HTML and a plain-text body from the same element, that untrusted strings passed
 * as children/props are escaped (React's own escaping — no
 * `dangerouslySetInnerHTML` anywhere), and that the text fallback carries the copy.
 */
describe('renderEmail', () => {
  const hostile = '<script>alert(1)</script> & Sons';

  async function renderSample() {
    return renderEmail(
      <BaseEmail
        preview="Preview line"
        brandName="PrepProfit"
        heading={`Hello ${hostile}`}
        footerLines={['Footer line']}
      >
        <Text>Body for {hostile}</Text>
      </BaseEmail>,
    );
  }

  it('returns HTML and a plain-text alternative', async () => {
    const { html, text } = await renderSample();
    expect(html).toContain('<html');
    expect(html).toContain('Preview line');
    // The plain-text body is not HTML and still carries the copy.
    expect(text).not.toContain('<html');
    expect(text).toContain('Hello');
    expect(text).toContain('Body for');
  });

  it('escapes hostile text in the HTML body (no raw markup)', async () => {
    const { html } = await renderSample();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    // The ampersand is entity-encoded, never emitted raw next to the tag.
    expect(html).toContain('&amp; Sons');
  });

  it('renders a text-only header when no logoUrl is given', async () => {
    const { html } = await renderSample();
    expect(html).toContain('PrepProfit');
    expect(html).not.toContain('<img');
  });
});
