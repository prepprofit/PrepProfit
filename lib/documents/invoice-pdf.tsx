import {
  Document,
  Page,
  View,
  Text,
  Image,
  StyleSheet,
  renderToBuffer,
} from '@react-pdf/renderer';
import type { InvoiceDocumentData, InvoiceDocumentLabels } from './types';
import { formatMoney, formatDocDate, safeText } from './format';

/**
 * Invoice PDF (Sprint 3.5A) built with `@react-pdf/renderer` (Node runtime only —
 * this module is imported solely by the PDF route handler). Consumes the shared
 * `InvoiceDocumentData` view-model and pre-resolved labels, so it never touches
 * the DB or the i18n runtime. Brand accent matches the app (orange).
 */

const ACCENT = '#c2410c'; // orange-700, the app CTA accent
const INK = '#1f2937'; // neutral-800
const MUTED = '#6b7280'; // neutral-500
const BORDER = '#e5e7eb'; // neutral-200

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
    marginBottom: 28,
  },
  sellerBlock: { flexDirection: 'column', maxWidth: 300 },
  logo: { width: 120, maxHeight: 48, marginBottom: 8, objectFit: 'contain' },
  sellerName: { fontSize: 15, fontFamily: 'Helvetica-Bold', color: INK },
  muted: { color: MUTED },
  docMeta: { flexDirection: 'column', alignItems: 'flex-end' },
  docTitle: {
    fontSize: 22,
    fontFamily: 'Helvetica-Bold',
    color: ACCENT,
    letterSpacing: 1,
    marginBottom: 4,
  },
  docNumber: { fontSize: 11, fontFamily: 'Helvetica-Bold', color: INK },
  statusPill: {
    marginTop: 6,
    paddingVertical: 2,
    paddingHorizontal: 8,
    borderRadius: 3,
    fontSize: 9,
    fontFamily: 'Helvetica-Bold',
    color: ACCENT,
    borderWidth: 1,
    borderColor: ACCENT,
    textTransform: 'uppercase',
  },
  partiesRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 24 },
  partyBlock: { flexDirection: 'column', maxWidth: 250 },
  label: {
    fontSize: 8,
    fontFamily: 'Helvetica-Bold',
    color: MUTED,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 3,
  },
  datesBlock: { flexDirection: 'column', alignItems: 'flex-end' },
  dateLine: { flexDirection: 'row', gap: 6 },
  table: { marginTop: 4 },
  tHead: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: INK,
    paddingBottom: 5,
  },
  tRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: BORDER,
    paddingVertical: 6,
  },
  th: { fontSize: 8, fontFamily: 'Helvetica-Bold', color: MUTED, textTransform: 'uppercase' },
  cDesc: { flex: 4, paddingRight: 6 },
  cNum: { flex: 1.4, textAlign: 'right' },
  cMoney: { flex: 1.8, textAlign: 'right' },
  totals: { marginTop: 16, marginLeft: 'auto', width: 220 },
  totalLine: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 2,
    color: MUTED,
  },
  grandLine: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingTop: 6,
    marginTop: 4,
    borderTopWidth: 1,
    borderTopColor: INK,
  },
  grandText: { fontSize: 12, fontFamily: 'Helvetica-Bold', color: INK },
  notes: { marginTop: 24, color: MUTED, fontSize: 9 },
  watermark: {
    position: 'absolute',
    top: 320,
    left: 90,
    fontSize: 90,
    fontFamily: 'Helvetica-Bold',
    color: '#f3f4f6',
    transform: 'rotate(-24deg)',
    textTransform: 'uppercase',
  },
});

function InvoiceDocument({
  data,
  labels,
}: {
  data: InvoiceDocumentData;
  labels: InvoiceDocumentLabels;
}) {
  const { seller, customer, currency } = data;
  const money = (cents: number) => formatMoney(cents, currency);
  const showWatermark = data.status === 'void' || data.status === 'draft';

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        {showWatermark && (
          <Text style={styles.watermark} fixed>
            {labels.status[data.status]}
          </Text>
        )}

        {/* Header: seller (From) + document meta */}
        <View style={styles.headerRow}>
          <View style={styles.sellerBlock}>
            {/* react-pdf's <Image> is not an HTML img and has no alt prop. */}
            {/* eslint-disable-next-line jsx-a11y/alt-text */}
            {seller.logoUrl && <Image style={styles.logo} src={seller.logoUrl} />}
            <Text style={styles.sellerName}>{safeText(seller.name)}</Text>
            {seller.address && <Text style={styles.muted}>{seller.address}</Text>}
            {seller.taxId && (
              <Text style={styles.muted}>
                {labels.taxId}: {seller.taxId}
              </Text>
            )}
            {seller.email && <Text style={styles.muted}>{seller.email}</Text>}
          </View>
          <View style={styles.docMeta}>
            <Text style={styles.docTitle}>{labels.title}</Text>
            {data.number && (
              <Text style={styles.docNumber}>
                {labels.invoiceNo} {data.number}
              </Text>
            )}
            <Text style={styles.statusPill}>{labels.status[data.status]}</Text>
          </View>
        </View>

        {/* Parties + dates */}
        <View style={styles.partiesRow}>
          <View style={styles.partyBlock}>
            <Text style={styles.label}>{labels.billTo}</Text>
            <Text style={{ fontFamily: 'Helvetica-Bold' }}>
              {safeText(customer.name)}
            </Text>
            {customer.taxId && (
              <Text style={styles.muted}>
                {labels.taxId}: {customer.taxId}
              </Text>
            )}
            {customer.address && <Text style={styles.muted}>{customer.address}</Text>}
            {customer.email && <Text style={styles.muted}>{customer.email}</Text>}
          </View>
          <View style={styles.datesBlock}>
            {data.issueDate && (
              <View style={styles.dateLine}>
                <Text style={styles.muted}>{labels.issued}:</Text>
                <Text>{formatDocDate(data.issueDate)}</Text>
              </View>
            )}
            {data.dueDate && (
              <View style={styles.dateLine}>
                <Text style={styles.muted}>{labels.due}:</Text>
                <Text>{formatDocDate(data.dueDate)}</Text>
              </View>
            )}
          </View>
        </View>

        {/* Line items */}
        <View style={styles.table}>
          <View style={styles.tHead}>
            <Text style={[styles.th, styles.cDesc]}>{labels.description}</Text>
            <Text style={[styles.th, styles.cNum]}>{labels.quantity}</Text>
            <Text style={[styles.th, styles.cMoney]}>{labels.unitPrice}</Text>
            <Text style={[styles.th, styles.cNum]}>{labels.taxRate}</Text>
            <Text style={[styles.th, styles.cMoney]}>{labels.lineTotal}</Text>
          </View>
          {data.lines.map((line, i) => (
            <View style={styles.tRow} key={i} wrap={false}>
              <Text style={styles.cDesc}>{safeText(line.description)}</Text>
              <Text style={styles.cNum}>{line.quantity}</Text>
              <Text style={styles.cMoney}>{money(line.unitPriceCents)}</Text>
              <Text style={styles.cNum}>{line.taxRatePercent}%</Text>
              <Text style={styles.cMoney}>{money(line.grossCents)}</Text>
            </View>
          ))}
        </View>

        {/* Totals */}
        <View style={styles.totals}>
          <View style={styles.totalLine}>
            <Text>{labels.subtotal}</Text>
            <Text>{money(data.subtotalCents)}</Text>
          </View>
          <View style={styles.totalLine}>
            <Text>{labels.tax}</Text>
            <Text>{money(data.taxCents)}</Text>
          </View>
          <View style={styles.grandLine}>
            <Text style={styles.grandText}>{labels.total}</Text>
            <Text style={styles.grandText}>{money(data.totalCents)}</Text>
          </View>
        </View>

        {data.notes && (
          <Text style={styles.notes}>
            {labels.notes}: {data.notes}
          </Text>
        )}
      </Page>
    </Document>
  );
}

/** Render the invoice to PDF bytes. Node runtime only. */
export function renderInvoicePdf(
  data: InvoiceDocumentData,
  labels: InvoiceDocumentLabels,
): Promise<Buffer> {
  return renderToBuffer(<InvoiceDocument data={data} labels={labels} />);
}
