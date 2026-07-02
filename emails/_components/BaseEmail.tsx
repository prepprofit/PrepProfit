import type { ReactNode } from 'react';
import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Img,
  Preview,
  Section,
  Text,
} from '@react-email/components';
import { CtaButton } from './CtaButton';
import { Footer } from './Footer';
import {
  bodyStyle,
  brandTextStyle,
  containerStyle,
  contentStyle,
  headerStyle,
  headingStyle,
  palette,
} from './theme';

/**
 * The shared shell for every PrepProfit email (React Email migration). Owns the
 * document scaffold (`<Html>`/`<Head>`/`<Body>`), the boxed container, the header,
 * an optional CTA, and the restrained footer — the "Barebone" house style.
 *
 * Contract for templates (CLAUDE.md i18n rule): all recipient-facing copy is passed
 * in ALREADY translated. This component never calls next-intl. Every string is
 * rendered as a React child/prop, so values are escaped — there is no
 * `dangerouslySetInnerHTML` anywhere in `emails/`.
 *
 * `brandName` is the product name shown in the header. `logoUrl` is an OPTIONAL
 * absolute image URL; when absent the header is logo-less text (the URL helper
 * yields none in dev/misconfig, so rendering never depends on it). `cta` is
 * rendered only when a valid absolute URL was resolved by the caller.
 */
export type BaseEmailProps = {
  /** Inbox preview snippet (already translated). */
  preview: string;
  /** Product/brand name in the header. */
  brandName: string;
  /** Optional absolute https logo URL; omitted → text-only header. */
  logoUrl?: string;
  /** Optional H1 heading above the body. */
  heading?: string;
  /** Optional accent CTA; both fields required to render it. */
  cta?: { href: string; label: string };
  /** Footer lines (already translated). */
  footerLines: string[];
  children: ReactNode;
};

export function BaseEmail({
  preview,
  brandName,
  logoUrl,
  heading,
  cta,
  footerLines,
  children,
}: BaseEmailProps) {
  return (
    <Html lang="en">
      <Head />
      <Preview>{preview}</Preview>
      <Body style={bodyStyle}>
        <Container style={containerStyle}>
          <Section style={headerStyle}>
            {logoUrl ? (
              <Img
                src={logoUrl}
                alt={brandName}
                height={28}
                style={{ display: 'block' }}
              />
            ) : (
              <Text style={brandTextStyle}>{brandName}</Text>
            )}
          </Section>

          <Section style={contentStyle}>
            {heading ? <Heading style={headingStyle}>{heading}</Heading> : null}
            {children}
            {cta ? <CtaButton href={cta.href} label={cta.label} /> : null}
          </Section>

          <Footer lines={footerLines} />
        </Container>
      </Body>
    </Html>
  );
}

/** Re-export the palette so templates can tint text without re-importing theme. */
export { palette };
