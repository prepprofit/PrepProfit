import { Text } from '@react-email/components';
import { BaseEmail } from './_components/BaseEmail';
import { paragraphStyle } from './_components/theme';

/**
 * Purchase-order email body (send or cancel notice), delivered by the outbox
 * worker. The order PDF (send only) is attached by the worker; this is the cover
 * note. All copy is passed already-translated; no CTA.
 */
export type PurchaseOrderEmailProps = {
  brandName: string;
  footerLines: string[];
  preview: string;
  heading: string;
  body: string;
};

export function PurchaseOrderEmail({
  brandName,
  footerLines,
  preview,
  heading,
  body,
}: PurchaseOrderEmailProps) {
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
