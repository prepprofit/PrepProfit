import {
  Document,
  Page,
  View,
  Text,
  Image,
  StyleSheet,
  renderToBuffer,
} from '@react-pdf/renderer';
import type { RecipeCardDocumentData, RecipeCardDocumentLabels } from './types';
import { formatMoney, safeText } from './format';

/**
 * Recipe card / cost sheet PDF (Sprint 3.5B), built with `@react-pdf/renderer`
 * (Node runtime only — imported solely by the recipe-card PDF route). Consumes the
 * shared `RecipeCardDocumentData` view-model and pre-resolved labels, so it never
 * touches the DB or the i18n runtime. Brand accent matches the app/invoice doc.
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
  muted: { color: MUTED },
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
  th: { fontSize: 8, fontFamily: 'Helvetica-Bold', color: MUTED, textTransform: 'uppercase' },
  cName: { flex: 4, paddingRight: 6 },
  cNum: { flex: 1.6, textAlign: 'right' },
  cMoney: { flex: 1.8, textAlign: 'right' },
  totals: { marginTop: 16, marginLeft: 'auto', width: 240 },
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
  marginLine: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingTop: 6,
    marginTop: 6,
  },
  accentText: { fontFamily: 'Helvetica-Bold', color: ACCENT },
  notes: { marginTop: 24, color: MUTED, fontSize: 9 },
});

function RecipeCardDocument({
  data,
  labels,
}: {
  data: RecipeCardDocumentData;
  labels: RecipeCardDocumentLabels;
}) {
  const { seller, currency } = data;
  const money = (cents: number) => formatMoney(cents, currency);
  const unit = (d: RecipeCardDocumentData['lines'][number]['dimension']) =>
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

        {/* Ingredient lines */}
        <View style={styles.table}>
          <View style={styles.tHead}>
            <Text style={[styles.th, styles.cName]}>{labels.ingredient}</Text>
            <Text style={[styles.th, styles.cNum]}>{labels.quantity}</Text>
            <Text style={[styles.th, styles.cMoney]}>{labels.cost}</Text>
          </View>
          {data.lines.map((line, i) => (
            <View style={styles.tRow} key={i} wrap={false}>
              <Text style={styles.cName}>{safeText(line.name)}</Text>
              <Text style={styles.cNum}>
                {line.quantity} {unit(line.dimension)}
              </Text>
              <Text style={styles.cMoney}>{money(line.costCents)}</Text>
            </View>
          ))}
        </View>

        {/* Cost breakdown + margin */}
        <View style={styles.totals}>
          <View style={styles.totalLine}>
            <Text>{labels.ingredientCost}</Text>
            <Text>{money(data.ingredientCostCents)}</Text>
          </View>
          <View style={styles.totalLine}>
            <Text>{labels.labor}</Text>
            <Text>{money(data.laborCostCents)}</Text>
          </View>
          <View style={styles.totalLine}>
            <Text>{labels.energy}</Text>
            <Text>{money(data.energyCostCents)}</Text>
          </View>
          <View style={styles.totalLine}>
            <Text>{labels.packaging}</Text>
            <Text>{money(data.packagingCostCents)}</Text>
          </View>
          <View style={styles.grandLine}>
            <Text style={styles.grandText}>{labels.totalCost}</Text>
            <Text style={styles.grandText}>{money(data.totalCostCents)}</Text>
          </View>
          <View style={styles.totalLine}>
            <Text>{labels.costPerPortion}</Text>
            <Text>{money(data.costPerPortionCents)}</Text>
          </View>
          {data.sellingPriceCents != null && (
            <View style={styles.totalLine}>
              <Text>{labels.sellingPrice}</Text>
              <Text>{money(data.sellingPriceCents)}</Text>
            </View>
          )}
          {data.marginPercent != null && (
            <View style={styles.marginLine}>
              <Text style={styles.accentText}>{labels.margin}</Text>
              <Text style={styles.accentText}>{data.marginPercent}%</Text>
            </View>
          )}
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

/** Render the recipe card to PDF bytes. Node runtime only. */
export function renderRecipeCardPdf(
  data: RecipeCardDocumentData,
  labels: RecipeCardDocumentLabels,
): Promise<Buffer> {
  return renderToBuffer(<RecipeCardDocument data={data} labels={labels} />);
}
