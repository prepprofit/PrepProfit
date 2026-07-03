import { Section, Text } from '@react-email/components';
import { BaseEmail } from './_components/BaseEmail';
import { mutedParagraphStyle, paragraphStyle, palette } from './_components/theme';

/**
 * Reverse-trial ending reminder (pricing 4-tier plan). Sent once by the daily
 * `trial-reminder` cron when an org's 14-day full-access trial is a few days from
 * expiry and it has NOT subscribed. Unlike the generic billing lifecycle notice,
 * this template leads with the days-left deadline, lists what a paid plan keeps,
 * and reassures that doing nothing is safe (the workspace just drops to Free).
 *
 * All copy is passed in ALREADY translated (CLAUDE.md i18n rule); this component
 * never calls next-intl and renders every string as an escaped React child. No
 * money, no PII — only the org name, the day count, and static benefit lines.
 */
export type TrialEndingEmailProps = {
  brandName: string;
  footerLines: string[];
  preview: string;
  heading: string;
  /** Highlighted "N days of full access left" line (already translated). */
  deadline: string;
  /** Lead paragraph (already translated). */
  body: string;
  /** Heading above the benefits list (already translated). */
  keepTitle: string;
  /** Benefit lines a paid plan keeps (already translated). */
  keepItems: string[];
  /** Reassurance that inaction is safe (already translated). */
  fallback: string;
  cta?: { href: string; label: string };
};

export function TrialEndingEmail({
  brandName,
  footerLines,
  preview,
  heading,
  deadline,
  body,
  keepTitle,
  keepItems,
  fallback,
  cta,
}: TrialEndingEmailProps) {
  return (
    <BaseEmail
      brandName={brandName}
      footerLines={footerLines}
      preview={preview}
      heading={heading}
      cta={cta}
    >
      {/* Accent-tinted deadline banner — the one bit of visual urgency. */}
      <Section
        style={{
          backgroundColor: palette.accentSoft,
          border: `1px solid ${palette.border}`,
          borderRadius: '6px',
          padding: '12px 16px',
          marginBottom: '20px',
        }}
      >
        <Text
          style={{
            margin: 0,
            fontSize: '15px',
            fontWeight: 600,
            color: palette.accent,
          }}
        >
          {deadline}
        </Text>
      </Section>

      <Text style={paragraphStyle}>{body}</Text>

      <Text
        style={{
          margin: '0 0 8px',
          fontSize: '14px',
          fontWeight: 600,
          color: palette.text,
        }}
      >
        {keepTitle}
      </Text>
      <Section style={{ marginBottom: '20px' }}>
        {keepItems.map((line, i) => (
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

      <Text style={mutedParagraphStyle}>{fallback}</Text>
    </BaseEmail>
  );
}
