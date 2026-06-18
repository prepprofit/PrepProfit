import {
  Document,
  Page,
  View,
  Text,
  Image,
  StyleSheet,
  renderToBuffer,
} from '@react-pdf/renderer';
import type { PlDocumentData, PlDocumentLabels } from './types';
import { formatMoney, safeText } from './format';

/**
 * Profit & Loss PDF (Sprint 3.5B), built with `@react-pdf/renderer` (Node runtime
 * only). Consumes the shared `PlDocumentData` view-model and pre-resolved labels.
 * Income is shown positive; expenses with a leading minus; a loss renders in red —
 * matching the app's money-colour rule.
 */

const ACCENT = '#c2410c';
const INK = '#1f2937';
const MUTED = '#6b7280';
const BORDER = '#e5e7eb';
const LOSS = '#b91c1c';

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
  summaryRow: { flexDirection: 'row', gap: 12, marginBottom: 20 },
  summaryCard: {
    flex: 1,
    borderWidth: 1,
    borderColor: BORDER,
    borderRadius: 4,
    padding: 10,
  },
  summaryLabel: {
    fontSize: 8,
    fontFamily: 'Helvetica-Bold',
    color: MUTED,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 4,
  },
  summaryValue: { fontSize: 14, fontFamily: 'Helvetica-Bold', color: INK },
  loss: { color: LOSS },
  section: { marginBottom: 16 },
  sectionTitle: {
    fontSize: 11,
    fontFamily: 'Helvetica-Bold',
    color: INK,
    marginBottom: 6,
  },
  tHead: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: INK,
    paddingBottom: 4,
  },
  tRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: BORDER,
    paddingVertical: 4,
  },
  th: { fontSize: 8, fontFamily: 'Helvetica-Bold', color: MUTED, textTransform: 'uppercase' },
  cName: { flex: 4, paddingRight: 6 },
  cMoney: { flex: 2, textAlign: 'right' },
  empty: { color: MUTED, fontSize: 9, paddingVertical: 4 },
});

function PlDocumentBody({
  data,
  labels,
}: {
  data: PlDocumentData;
  labels: PlDocumentLabels;
}) {
  const { seller, currency } = data;
  const money = (cents: number) => formatMoney(cents, currency);
  const profitIsLoss = data.profitCents < 0;

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

        {/* Summary */}
        <View style={styles.summaryRow}>
          <View style={styles.summaryCard}>
            <Text style={styles.summaryLabel}>{labels.income}</Text>
            <Text style={styles.summaryValue}>{money(data.incomeCents)}</Text>
          </View>
          <View style={styles.summaryCard}>
            <Text style={styles.summaryLabel}>{labels.expenses}</Text>
            <Text style={styles.summaryValue}>{money(data.expenseCents)}</Text>
          </View>
          <View style={styles.summaryCard}>
            <Text style={styles.summaryLabel}>{labels.profit}</Text>
            <Text
              style={profitIsLoss ? [styles.summaryValue, styles.loss] : styles.summaryValue}
            >
              {money(data.profitCents)}
            </Text>
          </View>
        </View>

        {/* By category */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{labels.byCategory}</Text>
          <View style={styles.tHead}>
            <Text style={[styles.th, styles.cName]}>{labels.category}</Text>
            <Text style={[styles.th, styles.cMoney]}>{labels.amount}</Text>
          </View>
          {data.byCategory.length === 0 ? (
            <Text style={styles.empty}>{labels.empty}</Text>
          ) : (
            data.byCategory.map((c, i) => (
              <View style={styles.tRow} key={i} wrap={false}>
                <Text style={styles.cName}>{safeText(c.name)}</Text>
                <Text style={styles.cMoney}>{money(c.totalCents)}</Text>
              </View>
            ))
          )}
        </View>

        {/* Top products */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{labels.topProducts}</Text>
          <View style={styles.tHead}>
            <Text style={[styles.th, styles.cName]}>{labels.product}</Text>
            <Text style={[styles.th, styles.cMoney]}>{labels.amount}</Text>
          </View>
          {data.topProducts.length === 0 ? (
            <Text style={styles.empty}>{labels.empty}</Text>
          ) : (
            data.topProducts.map((p, i) => (
              <View style={styles.tRow} key={i} wrap={false}>
                <Text style={styles.cName}>{safeText(p.name)}</Text>
                <Text style={styles.cMoney}>{money(p.totalCents)}</Text>
              </View>
            ))
          )}
        </View>

        {/* Monthly breakdown (year view only) */}
        {data.monthly && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>{labels.monthly}</Text>
            <View style={styles.tHead}>
              <Text style={[styles.th, styles.cName]}>{labels.month}</Text>
              <Text style={[styles.th, styles.cMoney]}>{labels.income}</Text>
              <Text style={[styles.th, styles.cMoney]}>{labels.expenses}</Text>
              <Text style={[styles.th, styles.cMoney]}>{labels.profit}</Text>
            </View>
            {data.monthly.map((m, i) => (
              <View style={styles.tRow} key={i} wrap={false}>
                <Text style={styles.cName}>{m.label}</Text>
                <Text style={styles.cMoney}>{money(m.incomeCents)}</Text>
                <Text style={styles.cMoney}>{money(m.expenseCents)}</Text>
                <Text
                  style={m.profitCents < 0 ? [styles.cMoney, styles.loss] : styles.cMoney}
                >
                  {money(m.profitCents)}
                </Text>
              </View>
            ))}
          </View>
        )}
      </Page>
    </Document>
  );
}

/** Render the P&L to PDF bytes. Node runtime only. */
export function renderPlPdf(
  data: PlDocumentData,
  labels: PlDocumentLabels,
): Promise<Buffer> {
  return renderToBuffer(<PlDocumentBody data={data} labels={labels} />);
}
