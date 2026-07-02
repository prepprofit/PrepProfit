import { Section, Text } from '@react-email/components';
import { BaseEmail } from './_components/BaseEmail';
import { paragraphStyle, palette } from './_components/theme';

/**
 * Low-stock digest. The sender passes the translated intro plus the pre-formatted
 * item lines (from the pure `lowStockSummaryLines`) — each line is a plain string
 * rendered as a text node, so ingredient names are React-escaped; nothing here
 * builds HTML. No money, no PII. `cta` is rendered only when the sender resolved
 * an absolute inventory URL.
 */
export type LowStockEmailProps = {
  brandName: string;
  footerLines: string[];
  preview: string;
  heading: string;
  intro: string;
  items: string[];
  cta?: { href: string; label: string };
};

export function LowStockEmail({
  brandName,
  footerLines,
  preview,
  heading,
  intro,
  items,
  cta,
}: LowStockEmailProps) {
  return (
    <BaseEmail
      brandName={brandName}
      footerLines={footerLines}
      preview={preview}
      heading={heading}
      cta={cta}
    >
      <Text style={paragraphStyle}>{intro}</Text>
      <Section style={{ marginBottom: '16px' }}>
        {items.map((line, i) => (
          <Text
            key={i}
            style={{
              margin: '0 0 6px',
              fontSize: '14px',
              lineHeight: '20px',
              color: palette.text,
            }}
          >
            <span style={{ color: palette.accent }}>•</span> {line}
          </Text>
        ))}
      </Section>
    </BaseEmail>
  );
}
