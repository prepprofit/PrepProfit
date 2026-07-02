import { Row, Column, Section, Text } from '@react-email/components';
import { palette } from './theme';

/**
 * A compact label→value table for figures (spend totals, plan facts, weekly
 * numbers). Two columns, hairline row rules. Values are plain strings the caller
 * pre-formats (money, counts) and React escapes; nothing here builds HTML.
 * `emphasizeValue` bumps the right column weight for a headline row.
 */
export type KeyValueRow = {
  label: string;
  value: string;
  emphasize?: boolean;
};

export function KeyValueTable({ rows }: { rows: KeyValueRow[] }) {
  return (
    <Section>
      {rows.map((row, i) => (
        <Row
          key={i}
          style={{
            borderTop: i === 0 ? undefined : `1px solid ${palette.border}`,
          }}
        >
          <Column style={{ padding: '7px 0' }}>
            <Text style={{ margin: 0, fontSize: '14px', color: palette.muted }}>
              {row.label}
            </Text>
          </Column>
          <Column style={{ padding: '7px 0', textAlign: 'right' }}>
            <Text
              style={{
                margin: 0,
                fontSize: '14px',
                fontWeight: row.emphasize ? 700 : 500,
                color: palette.text,
              }}
            >
              {row.value}
            </Text>
          </Column>
        </Row>
      ))}
    </Section>
  );
}
