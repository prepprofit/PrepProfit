import { Text } from '@react-email/components';
import { BaseEmail } from './_components/BaseEmail';
import { paragraphStyle } from './_components/theme';

/**
 * Billing lifecycle email (subscribed / upgraded / downgraded). Money-free and
 * PII-free by design: the sender passes the already-translated plan sentence and
 * an optional billing CTA. This template only lays out heading + body + CTA.
 */
export type SubscriptionEmailProps = {
  brandName: string;
  footerLines: string[];
  preview: string;
  heading: string;
  body: string;
  cta?: { href: string; label: string };
};

export function SubscriptionEmail({
  brandName,
  footerLines,
  preview,
  heading,
  body,
  cta,
}: SubscriptionEmailProps) {
  return (
    <BaseEmail
      brandName={brandName}
      footerLines={footerLines}
      preview={preview}
      heading={heading}
      cta={cta}
    >
      <Text style={paragraphStyle}>{body}</Text>
    </BaseEmail>
  );
}
