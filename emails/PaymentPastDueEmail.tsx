import { Text } from '@react-email/components';
import { BaseEmail } from './_components/BaseEmail';
import { paragraphStyle } from './_components/theme';

/**
 * Dunning email (subscription past due). No card data, no amounts — just an
 * actionable nudge to update the payment method. The sender passes the translated
 * body and an optional billing CTA; this template lays it out.
 */
export type PaymentPastDueEmailProps = {
  brandName: string;
  footerLines: string[];
  preview: string;
  heading: string;
  body: string;
  cta?: { href: string; label: string };
};

export function PaymentPastDueEmail({
  brandName,
  footerLines,
  preview,
  heading,
  body,
  cta,
}: PaymentPastDueEmailProps) {
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
