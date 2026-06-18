import {
  Document,
  Page,
  View,
  Text,
  Image,
  StyleSheet,
  renderToBuffer,
} from '@react-pdf/renderer';
import type { PayrollDocumentData, PayrollDocumentLabels } from './types';
import { formatMoney, safeText } from './format';
import { formatHours } from './payroll-data';

/**
 * Payroll period-summary PDF (Sprint 3.5B), built with `@react-pdf/renderer` (Node
 * runtime only). Consumes the shared `PayrollDocumentData` view-model and
 * pre-resolved labels. One row per employee + a totals row.
 */

const ACCENT = '#c2410c';
const INK = '#1f2937';
const MUTED = '#6b7280';
const BORDER = '#e5e7eb';

const styles = StyleSheet.create({
  page: {
    paddingVertical: 40,
    paddingHorizontal: 44,
    fontSize: 10,
    color: INK,
    fontFamily: 'Helvetica',
    lineHeight: 1.4,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 24,
  },
  sellerBlock: { flexDirection: 'column', maxWidth: 300 },
  logo: { width: 120, maxHeight: 48, marginBottom: 8, objectFit: 'contain' },
  sellerName: { fontSize: 13, fontFamily: 'Helvetica-Bold', color: INK },
  docMeta: { flexDirection: 'column', alignItems: 'flex-end' },
  docTitle: {
    fontSize: 20,
    fontFamily: 'Helvetica-Bold',
    color: ACCENT,
    letterSpacing: 1,
    marginBottom: 4,
  },
  period: { fontSize: 11, fontFamily: 'Helvetica-Bold', color: INK },
  tHead: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: INK,
    paddingBottom: 5,
    marginTop: 8,
  },
  tRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: BORDER,
    paddingVertical: 6,
  },
  totalRow: {
    flexDirection: 'row',
    paddingTop: 8,
    marginTop: 2,
    borderTopWidth: 1,
    borderTopColor: INK,
  },
  th: { fontSize: 8, fontFamily: 'Helvetica-Bold', color: MUTED, textTransform: 'uppercase' },
  cName: { flex: 4, paddingRight: 6 },
  cNum: { flex: 1.6, textAlign: 'right' },
  cMoney: { flex: 2, textAlign: 'right' },
  bold: { fontFamily: 'Helvetica-Bold', color: INK },
  empty: { color: MUTED, fontSize: 9, paddingVertical: 8 },
});

function PayrollDocumentBody({
  data,
  labels,
}: {
  data: PayrollDocumentData;
  labels: PayrollDocumentLabels;
}) {
  const { seller, currency } = data;
  const money = (cents: number) => formatMoney(cents, currency);

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.headerRow}>
          <View style={styles.sellerBlock}>
            {/* eslint-disable-next-line jsx-a11y/alt-text */}
            {seller.logoUrl && <Image style={styles.logo} src={seller.logoUrl} />}
            {seller.name !== '' && (
              <Text style={styles.sellerName}>{safeText(seller.name)}</Text>
            )}
          </View>
          <View style={styles.docMeta}>
            <Text style={styles.docTitle}>{labels.title}</Text>
            <Text style={styles.period}>{data.periodLabel}</Text>
          </View>
        </View>

        <View style={styles.tHead}>
          <Text style={[styles.th, styles.cName]}>{labels.employee}</Text>
          <Text style={[styles.th, styles.cNum]}>{labels.shifts}</Text>
          <Text style={[styles.th, styles.cNum]}>{labels.hours}</Text>
          <Text style={[styles.th, styles.cMoney]}>{labels.pay}</Text>
        </View>

        {data.rows.length === 0 ? (
          <Text style={styles.empty}>{labels.empty}</Text>
        ) : (
          <>
            {data.rows.map((r, i) => (
              <View style={styles.tRow} key={i} wrap={false}>
                <Text style={styles.cName}>{safeText(r.name)}</Text>
                <Text style={styles.cNum}>{r.shiftCount}</Text>
                <Text style={styles.cNum}>{formatHours(r.workedMinutes)}</Text>
                <Text style={styles.cMoney}>{money(r.payDueCents)}</Text>
              </View>
            ))}
            <View style={styles.totalRow}>
              <Text style={[styles.cName, styles.bold]}>{labels.total}</Text>
              <Text style={[styles.cNum, styles.bold]}>{data.totalShiftCount}</Text>
              <Text style={[styles.cNum, styles.bold]}>
                {formatHours(data.totalWorkedMinutes)}
              </Text>
              <Text style={[styles.cMoney, styles.bold]}>
                {money(data.totalPayCents)}
              </Text>
            </View>
          </>
        )}
      </Page>
    </Document>
  );
}

/** Render the payroll summary to PDF bytes. Node runtime only. */
export function renderPayrollPdf(
  data: PayrollDocumentData,
  labels: PayrollDocumentLabels,
): Promise<Buffer> {
  return renderToBuffer(<PayrollDocumentBody data={data} labels={labels} />);
}
