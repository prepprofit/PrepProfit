import { Text } from '@react-email/components';
import { BaseEmail } from './_components/BaseEmail';
import { paragraphStyle } from './_components/theme';

/**
 * Welcome email (org creation). All copy is passed already-translated by the
 * sender (lib/email/notifications.ts); this only lays it out. `cta` is rendered
 * only when the sender resolved an absolute app URL.
 */
export type WelcomeEmailProps = {
  brandName: string;
  footerLines: string[];
  preview: string;
  heading: string;
  body: string;
  cta?: { href: string; label: string };
};

export function WelcomeEmail({
  brandName,
  footerLines,
  preview,
  heading,
  body,
  cta,
}: WelcomeEmailProps) {
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
