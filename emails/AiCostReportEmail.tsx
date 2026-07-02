import { Column, Hr, Row, Section, Text } from '@react-email/components';
import { BaseEmail } from './_components/BaseEmail';
import { KeyValueTable, type KeyValueRow } from './_components/KeyValueTable';
import { mutedParagraphStyle, palette } from './_components/theme';

/**
 * Operator AI-spend digest (weekly cron). Not customer-facing — sent to a single
 * operator address. Carries only aggregate counts/tokens/cost and org NAMES (org
 * names are user data, so they are rendered as escaped text nodes; nothing here
 * builds HTML). All copy and formatted figures are passed already-prepared by the
 * cron route.
 */
export type AiCostOrgRow = { name: string; count: string; spend: string };

export type AiCostReportEmailProps = {
  brandName: string;
  footerLines: string[];
  preview: string;
  heading: string;
  periodLabel: string;
  /** Pre-formatted totals (spend, extractions, avg, tokens). */
  totals: KeyValueRow[];
  byOrgTitle: string;
  orgHeader: AiCostOrgRow;
  orgRows: AiCostOrgRow[];
  emptyText: string;
  /** Fine-print notes (model, estimate caveat). */
  notes: string[];
};

function OrgRow({ row, header }: { row: AiCostOrgRow; header?: boolean }) {
  const color = header ? palette.muted : palette.text;
  const weight = header ? 500 : 400;
  return (
    <Row style={{ borderTop: `1px solid ${palette.border}` }}>
      <Column style={{ padding: '7px 0' }}>
        <Text style={{ margin: 0, fontSize: '13px', color, fontWeight: weight }}>
          {row.name}
        </Text>
      </Column>
      <Column style={{ padding: '7px 0', textAlign: 'right', width: '22%' }}>
        <Text style={{ margin: 0, fontSize: '13px', color, fontWeight: weight }}>
          {row.count}
        </Text>
      </Column>
      <Column style={{ padding: '7px 0', textAlign: 'right', width: '30%' }}>
        <Text style={{ margin: 0, fontSize: '13px', color, fontWeight: weight }}>
          {row.spend}
        </Text>
      </Column>
    </Row>
  );
}

export function AiCostReportEmail({
  brandName,
  footerLines,
  preview,
  heading,
  periodLabel,
  totals,
  byOrgTitle,
  orgHeader,
  orgRows,
  emptyText,
  notes,
}: AiCostReportEmailProps) {
  return (
    <BaseEmail
      brandName={brandName}
      footerLines={footerLines}
      preview={preview}
      heading={heading}
    >
      <Text style={mutedParagraphStyle}>{periodLabel}</Text>

      <KeyValueTable rows={totals} />

      <Text
        style={{
          margin: '20px 0 4px',
          fontSize: '13px',
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          color: palette.muted,
        }}
      >
        {byOrgTitle}
      </Text>
      <Section>
        <Row>
          <Column style={{ padding: '7px 0' }}>
            <Text style={{ margin: 0, fontSize: '12px', color: palette.faint }}>
              {orgHeader.name}
            </Text>
          </Column>
          <Column style={{ padding: '7px 0', textAlign: 'right', width: '22%' }}>
            <Text style={{ margin: 0, fontSize: '12px', color: palette.faint }}>
              {orgHeader.count}
            </Text>
          </Column>
          <Column style={{ padding: '7px 0', textAlign: 'right', width: '30%' }}>
            <Text style={{ margin: 0, fontSize: '12px', color: palette.faint }}>
              {orgHeader.spend}
            </Text>
          </Column>
        </Row>
        {orgRows.length === 0 ? (
          <Row style={{ borderTop: `1px solid ${palette.border}` }}>
            <Column style={{ padding: '7px 0' }}>
              <Text style={{ margin: 0, fontSize: '13px', color: palette.muted }}>
                {emptyText}
              </Text>
            </Column>
          </Row>
        ) : (
          orgRows.map((row, i) => <OrgRow key={i} row={row} />)
        )}
      </Section>

      <Hr style={{ borderColor: palette.border, margin: '20px 0 12px' }} />
      {notes.map((note, i) => (
        <Text
          key={i}
          style={{ margin: '0 0 4px', fontSize: '12px', color: palette.faint }}
        >
          {note}
        </Text>
      ))}
    </BaseEmail>
  );
}
