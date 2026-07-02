import type { CSSProperties } from 'react';

/**
 * Email design tokens (React Email migration). A small, email-specific design
 * system — NOT the app's Tailwind config. Every template styles through these
 * inline-style objects so the rendered HTML carries only inlined styles, which is
 * the most robust thing across mail clients (Outlook, Gmail, Apple Mail). We
 * deliberately avoid the `<Tailwind>` runtime and complex selectors the React
 * Email docs warn about; the "Barebone" visual language (quiet boxed layout,
 * clear header, simple cards/tables, restrained footer) is expressed here,
 * rethemed to PrepProfit's accent (the app's orange `accent-700`).
 */

export const palette = {
  /** Page background behind the boxed container. */
  background: '#f8fafc',
  /** Card / container surface. */
  surface: '#ffffff',
  /** Hairline borders and table rules. */
  border: '#e2e8f0',
  /** Primary body text. */
  text: '#0f172a',
  /** Secondary / supporting text. */
  muted: '#64748b',
  /** Faintest supporting text (footer, fine print). */
  faint: '#94a3b8',
  /** Brand accent (app `--color-accent-700`) — headers, CTAs, links. */
  accent: '#c2410c',
  /** Text on an accent-filled surface. */
  accentForeground: '#ffffff',
  /** A soft accent tint for subtle highlights. */
  accentSoft: '#fff7ed',
  /** Positive tone (good trend). */
  positive: '#047857',
  /** Negative / warning tone (bad trend, partial-data note). */
  negative: '#b91c1c',
  /** Amber note tone (confidence / caveats). */
  note: '#b45309',
} as const;

export const fontFamily =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/** Outer page background — the `<Body>` style. */
export const bodyStyle: CSSProperties = {
  backgroundColor: palette.background,
  margin: 0,
  padding: '24px 0',
  fontFamily,
  color: palette.text,
};

/** The boxed container that holds the whole message. */
export const containerStyle: CSSProperties = {
  backgroundColor: palette.surface,
  maxWidth: '560px',
  margin: '0 auto',
  borderRadius: '8px',
  border: `1px solid ${palette.border}`,
  overflow: 'hidden',
};

export const headerStyle: CSSProperties = {
  padding: '20px 32px',
  borderBottom: `1px solid ${palette.border}`,
};

export const brandTextStyle: CSSProperties = {
  margin: 0,
  fontSize: '18px',
  fontWeight: 700,
  color: palette.accent,
  letterSpacing: '-0.01em',
};

export const contentStyle: CSSProperties = {
  padding: '28px 32px',
};

export const headingStyle: CSSProperties = {
  margin: '0 0 12px',
  fontSize: '20px',
  fontWeight: 600,
  color: palette.text,
};

export const paragraphStyle: CSSProperties = {
  margin: '0 0 16px',
  fontSize: '15px',
  lineHeight: '24px',
  color: palette.text,
};

export const mutedParagraphStyle: CSSProperties = {
  ...paragraphStyle,
  color: palette.muted,
};

export const footerStyle: CSSProperties = {
  padding: '20px 32px',
  borderTop: `1px solid ${palette.border}`,
};

export const footerTextStyle: CSSProperties = {
  margin: '0 0 4px',
  fontSize: '12px',
  lineHeight: '18px',
  color: palette.faint,
};
