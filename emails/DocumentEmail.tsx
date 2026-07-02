import { Text } from '@react-email/components';
import { BaseEmail } from './_components/BaseEmail';
import { paragraphStyle } from './_components/theme';

/**
 * Cover note for a manager-sent generated document (invoice / recipe card / P&L).
 * The PDF itself is the payload and is attached by the action — this body is just
 * the accompanying message. All copy is passed already-translated; no CTA (the
 * document is attached, not linked).
 */
export type DocumentEmailProps = {
  brandName: string;
  footerLines: string[];
  preview: string;
  heading: string;
  body: string;
};

export function DocumentEmail({
  brandName,
  footerLines,
  preview,
  heading,
  body,
}: DocumentEmailProps) {
  return (
    <BaseEmail
      brandName={brandName}
      footerLines={footerLines}
      preview={preview}
      heading={heading}
    >
      <Text style={paragraphStyle}>{body}</Text>
    </BaseEmail>
  );
}
