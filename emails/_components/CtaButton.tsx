import { Button, Section } from '@react-email/components';
import { palette, fontFamily } from './theme';

/**
 * Accent-filled call-to-action button. Rendered ONLY when the caller has a valid
 * absolute URL (the templates omit it when `APP_URL` is unset — see the email URL
 * helper), so `href` is never a client-supplied or relative value. Label is
 * already-translated.
 */
export function CtaButton({ href, label }: { href: string; label: string }) {
  return (
    <Section style={{ margin: '4px 0 20px' }}>
      <Button
        href={href}
        style={{
          backgroundColor: palette.accent,
          color: palette.accentForeground,
          fontFamily,
          fontSize: '14px',
          fontWeight: 600,
          textDecoration: 'none',
          padding: '11px 20px',
          borderRadius: '6px',
          display: 'inline-block',
        }}
      >
        {label}
      </Button>
    </Section>
  );
}
