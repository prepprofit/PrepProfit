import type { ReactNode } from 'react';
import { Section, Text } from '@react-email/components';
import { palette } from './theme';

/**
 * A simple boxed sub-section used inside the message body — a titled panel with a
 * hairline border. Robust across mail clients (a bordered `<table>`/`<div>` region,
 * no complex selectors). The optional `title` is passed already-translated.
 */
export function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <Section
      style={{
        border: `1px solid ${palette.border}`,
        borderRadius: '6px',
        padding: '16px',
        marginBottom: '16px',
      }}
    >
      {title ? (
        <Text
          style={{
            margin: '0 0 10px',
            fontSize: '13px',
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            color: palette.muted,
          }}
        >
          {title}
        </Text>
      ) : null}
      {children}
    </Section>
  );
}
