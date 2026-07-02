import { Section, Text } from '@react-email/components';
import { footerStyle, footerTextStyle } from './theme';

/**
 * Restrained email footer. Copy is passed in already-translated (templates never
 * call next-intl); `lines` are rendered as plain text nodes, so any interpolated
 * value is React-escaped. No tracking pixels, no marketing imagery.
 */
export function Footer({ lines }: { lines: string[] }) {
  return (
    <Section style={footerStyle}>
      {lines.map((line, i) => (
        <Text key={i} style={footerTextStyle}>
          {line}
        </Text>
      ))}
    </Section>
  );
}
