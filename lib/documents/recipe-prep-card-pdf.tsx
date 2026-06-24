import {
  Document,
  Page,
  View,
  Text,
  Image,
  StyleSheet,
  renderToBuffer,
} from '@react-pdf/renderer';
import type { RecipePrepCardData, RecipePrepCardLabels } from './types';
import { safeText } from './format';

/**
 * Operational prep-card PDF (Recipe scaling MVP), built with `@react-pdf/renderer`
 * (Node runtime only). Consumes the money-free `RecipePrepCardData` view-model and
 * pre-resolved labels — there is NO cost column, NO totals block, NO price/margin
 * anywhere, so the document is safe for both kitchen and managers.
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
  recipeName: { fontSize: 13, fontFamily: 'Helvetica-Bold', color: INK },
  yieldLine: { color: MUTED, marginTop: 2 },
  scaleLine: { color: ACCENT, fontFamily: 'Helvetica-Bold', marginTop: 2 },
  table: { marginTop: 8 },
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
  th: {
    fontSize: 8,
    fontFamily: 'Helvetica-Bold',
    color: MUTED,
    textTransform: 'uppercase',
  },
  cName: { flex: 4, paddingRight: 6 },
  cNum: { flex: 2, textAlign: 'right' },
  notes: { marginTop: 24, color: MUTED, fontSize: 9 },
});

function RecipePrepCardDocument({
  data,
  labels,
}: {
  data: RecipePrepCardData;
  labels: RecipePrepCardLabels;
}) {
  const { seller } = data;
  const unit = (d: RecipePrepCardData['lines'][number]['dimension']) =>
    labels.units[d];

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
            <Text style={styles.recipeName}>{safeText(data.recipeName)}</Text>
            <Text style={styles.yieldLine}>
              {labels.yield}: {data.yieldPortions} {labels.portions} ·{' '}
              {labels.usableYield} {data.yieldPercentage}%
            </Text>
            {data.scale && (
              <Text style={styles.scaleLine}>
                {labels.scaledTo({
                  portions: String(data.scale.scaledPortions),
                  factor: String(data.scale.factor),
                })}
              </Text>
            )}
          </View>
        </View>

        {/* Ingredient lines — quantities only, no cost column */}
        <View style={styles.table}>
          <View style={styles.tHead}>
            <Text style={[styles.th, styles.cName]}>{labels.ingredient}</Text>
            <Text style={[styles.th, styles.cNum]}>{labels.quantity}</Text>
          </View>
          {data.lines.map((line, i) => (
            <View style={styles.tRow} key={i} wrap={false}>
              <Text style={styles.cName}>{safeText(line.name)}</Text>
              <Text style={styles.cNum}>
                {line.quantity} {unit(line.dimension)}
              </Text>
            </View>
          ))}
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

/** Render the operational prep card to PDF bytes. Node runtime only. */
export function renderRecipePrepCardPdf(
  data: RecipePrepCardData,
  labels: RecipePrepCardLabels,
): Promise<Buffer> {
  return renderToBuffer(<RecipePrepCardDocument data={data} labels={labels} />);
}
