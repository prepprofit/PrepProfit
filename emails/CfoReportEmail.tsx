import { Text } from '@react-email/components';
import { BaseEmail } from './_components/BaseEmail';
import { Card } from './_components/Card';
import { KeyValueTable, type KeyValueRow } from './_components/KeyValueTable';
import { mutedParagraphStyle, palette } from './_components/theme';

/**
 * Weekly CFO report digest (React Email migration). Deterministic financial digest
 * delivered by the outbox worker — revenue and food-cost headline figures, then the
 * biggest margin leaks, reprice candidates, supplier price changes and low stock,
 * and finally the confidence notes. Every label and figure is passed
 * ALREADY-formatted by the worker (money via formatMoney, trends pre-signed); this
 * template only lays them out and never runs any trend/AI math. No
 * `dangerouslySetInnerHTML`; every value is an escaped text node.
 */
export type CfoEmailSection = {
  title: string;
  /** Each item is a pre-formatted left label and an optional right value. */
  items: { left: string; right?: string }[];
};

export type CfoReportEmailProps = {
  brandName: string;
  footerLines: string[];
  preview: string;
  heading: string;
  periodLabel: string;
  /** Revenue + food-cost headline rows (pre-formatted). */
  summary: KeyValueRow[];
  /** Non-empty detail sections (leaks / reprice / supplier changes / low stock). */
  sections: CfoEmailSection[];
  confidenceTitle: string;
  confidenceNotes: string[];
  cta?: { href: string; label: string };
};

function SectionRows({ items }: { items: CfoEmailSection['items'] }) {
  return (
    <>
      {items.map((item, i) => (
        <table
          key={i}
          width="100%"
          cellPadding={0}
          cellSpacing={0}
          role="presentation"
          style={{ borderTop: i === 0 ? undefined : `1px solid ${palette.border}` }}
        >
          <tbody>
            <tr>
              <td style={{ padding: '7px 0', fontSize: '14px', color: palette.text }}>
                {item.left}
              </td>
              {item.right ? (
                <td
                  style={{
                    padding: '7px 0',
                    fontSize: '14px',
                    color: palette.muted,
                    textAlign: 'right',
                    whiteSpace: 'nowrap',
                    paddingLeft: '12px',
                  }}
                >
                  {item.right}
                </td>
              ) : null}
            </tr>
          </tbody>
        </table>
      ))}
    </>
  );
}

export function CfoReportEmail({
  brandName,
  footerLines,
  preview,
  heading,
  periodLabel,
  summary,
  sections,
  confidenceTitle,
  confidenceNotes,
  cta,
}: CfoReportEmailProps) {
  return (
    <BaseEmail
      brandName={brandName}
      footerLines={footerLines}
      preview={preview}
      heading={heading}
      cta={cta}
    >
      <Text style={mutedParagraphStyle}>{periodLabel}</Text>

      <KeyValueTable rows={summary} />

      <div style={{ height: '8px' }} />

      {sections.map((section, i) => (
        <Card key={i} title={section.title}>
          <SectionRows items={section.items} />
        </Card>
      ))}

      {confidenceNotes.length > 0 ? (
        <Card title={confidenceTitle}>
          {confidenceNotes.map((note, i) => (
            <Text
              key={i}
              style={{ margin: '0 0 6px', fontSize: '13px', color: palette.muted }}
            >
              <span style={{ color: palette.note }}>•</span> {note}
            </Text>
          ))}
        </Card>
      ) : null}
    </BaseEmail>
  );
}
