import {
  Document,
  Page,
  View,
  Text,
  Image,
  StyleSheet,
  renderToBuffer,
} from '@react-pdf/renderer';
import type {
  PurchaseOrderDocumentData,
  PurchaseOrderDocumentLabels,
} from './types';
import { formatMoney, formatDocDate, safeText } from './format';

/**
 * Purchase-order PDF (Sprint 8a) built with `@react-pdf/renderer` (Node runtime
 * only). Consumes the shared `PurchaseOrderDocumentData` view-model + pre-resolved
 * labels, so it never touches the DB or the i18n runtime. A DRAFT renders a
 * watermark; sent/cancelled render the frozen snapshot. Brand accent matches the app.
 */

const ACCENT = '#c2410c'; // orange-700, the app CTA accent
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
  cNum: { flex: 1.6, textAlign: 'right' },
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

/** Canonical-unit suffix for a quantity, e.g. '500 g'. */
function qtyLabel(
  quantity: number,
  dimension: 'weight' | 'volume' | 'count',
  units: PurchaseOrderDocumentLabels['units'],
): string {
  return `${quantity} ${units[dimension]}`.trim();
}

function PurchaseOrderDocument({
  data,
  labels,
}: {
  data: PurchaseOrderDocumentData;
  labels: PurchaseOrderDocumentLabels;
}) {
  const { seller, supplier, currency } = data;
  const money = (cents: number) => formatMoney(cents, currency);

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        {data.isDraft && (
          <Text style={styles.watermark} fixed>
            {labels.status.draft}
          </Text>
        )}

        {/* Header: seller (From) + document meta */}
        <View style={styles.headerRow}>
          <View style={styles.sellerBlock}>
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
            <Text style={styles.docNumber}>
              {labels.poNo} {data.number}
            </Text>
            <Text style={styles.statusPill}>{labels.status[data.status]}</Text>
          </View>
        </View>

        {/* Supplier + dates */}
        <View style={styles.partiesRow}>
          <View style={styles.partyBlock}>
            <Text style={styles.label}>{labels.supplierTo}</Text>
            <Text style={{ fontFamily: 'Helvetica-Bold' }}>
              {safeText(supplier.name)}
            </Text>
            {supplier.taxId && (
              <Text style={styles.muted}>
                {labels.taxId}: {supplier.taxId}
              </Text>
            )}
            {supplier.address && <Text style={styles.muted}>{supplier.address}</Text>}
            {supplier.email && <Text style={styles.muted}>{supplier.email}</Text>}
            {supplier.phone && (
              <Text style={styles.muted}>
                {labels.phone}: {supplier.phone}
              </Text>
            )}
          </View>
          <View style={styles.datesBlock}>
            {data.orderDate && (
              <View style={styles.dateLine}>
                <Text style={styles.muted}>{labels.orderDate}:</Text>
                <Text>{formatDocDate(data.orderDate)}</Text>
              </View>
            )}
            {data.expectedDate && (
              <View style={styles.dateLine}>
                <Text style={styles.muted}>{labels.expectedDate}:</Text>
                <Text>{formatDocDate(data.expectedDate)}</Text>
              </View>
            )}
          </View>
        </View>

        {/* Line items */}
        <View style={styles.table}>
          <View style={styles.tHead}>
            <Text style={[styles.th, styles.cDesc]}>{labels.ingredient}</Text>
            <Text style={[styles.th, styles.cNum]}>{labels.quantity}</Text>
            <Text style={[styles.th, styles.cMoney]}>{labels.unitCost}</Text>
            <Text style={[styles.th, styles.cMoney]}>{labels.lineTotal}</Text>
          </View>
          {data.lines.map((line, i) => (
            <View style={styles.tRow} key={i} wrap={false}>
              <Text style={styles.cDesc}>{safeText(line.name)}</Text>
              <Text style={styles.cNum}>
                {qtyLabel(line.quantity, line.dimension, labels.units)}
              </Text>
              <Text style={styles.cMoney}>{money(line.unitCostCents)}</Text>
              <Text style={styles.cMoney}>{money(line.lineTotalCents)}</Text>
            </View>
          ))}
        </View>

        {/* Totals */}
        <View style={styles.totals}>
          <View style={styles.totalLine}>
            <Text>{labels.subtotal}</Text>
            <Text>{money(data.subtotalCents)}</Text>
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

/** Render the purchase order to PDF bytes. Node runtime only. */
export function renderPurchaseOrderPdf(
  data: PurchaseOrderDocumentData,
  labels: PurchaseOrderDocumentLabels,
): Promise<Buffer> {
  return renderToBuffer(
    <PurchaseOrderDocument data={data} labels={labels} />,
  );
}
