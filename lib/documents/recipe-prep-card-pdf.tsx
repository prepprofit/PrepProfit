import {
  Document,
  Page,
  View,
  Text,
  StyleSheet,
  renderToBuffer,
} from '@react-pdf/renderer';
import type { RecipePrepCardData, RecipePrepCardLabels } from './types';
import { basisCaption } from './recipe-prep-card-data';
import { formatDocumentQuantity, safeText } from './format';

/**
 * Kitchen Scale prep-card PDF (Kitchen Scale redesign §5), built with
 * `@react-pdf/renderer` (Node runtime only). Consumes the money-free
 * `RecipePrepCardData` view-model and pre-resolved labels — there is NO cost
 * column, NO totals in money, NO price/margin anywhere. Mirrors the approved
 * sample layout: a small business-id line, a large left-aligned recipe name, a
 * calculation-basis caption, a wide ingredient table with large right-aligned
 * quantities, a clearly-labelled weigh-in total, and the saved preparation
 * method — nothing else (no navigation, no "PREP CARD" banner, no big
 * logo block, no "Yield: N portions" filler).
 */

const INK = '#1f2937';
const MUTED = '#6b7280';
const BORDER = '#e5e7eb';
const ACCENT = '#096567';

/** ~15mm margins in PDF points (1mm ≈ 2.83465pt). */
const MARGIN_H = 42;
const MARGIN_TOP = 40;

const styles = StyleSheet.create({
  page: {
    paddingTop: MARGIN_TOP,
    paddingBottom: 54,
    paddingHorizontal: MARGIN_H,
    fontSize: 11,
    color: INK,
    fontFamily: 'Helvetica',
    lineHeight: 1.35,
  },
  brand: { fontSize: 8.5, color: MUTED, marginBottom: 10 },
  recipeName: { fontSize: 27, fontFamily: 'Helvetica-Bold', color: INK, lineHeight: 1.15 },
  basisLine: { fontSize: 10, color: ACCENT, fontFamily: 'Helvetica-Bold', marginTop: 5, marginBottom: 18 },

  tHead: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: INK,
    paddingBottom: 6,
  },
  th: { fontSize: 8.5, fontFamily: 'Helvetica-Bold', color: MUTED, textTransform: 'uppercase', letterSpacing: 0.4 },
  thName: { flex: 5, paddingRight: 8 },
  thQty: { flex: 2, textAlign: 'right' },

  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    borderBottomWidth: 0.5,
    borderBottomColor: BORDER,
    paddingVertical: 8,
  },
  cName: { flex: 5, paddingRight: 8, fontSize: 18, color: INK },
  cSub: { fontSize: 10, color: MUTED },
  cQty: { flex: 2, flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'baseline' },
  cQtyValue: { fontSize: 23, fontFamily: 'Helvetica-Bold', color: INK },
  cQtyUnit: { fontSize: 11, color: MUTED, marginLeft: 3 },

  totals: { marginTop: 4, borderTopWidth: 1, borderTopColor: INK, paddingTop: 8 },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  totalLabel: { fontSize: 12, fontFamily: 'Helvetica-Bold', color: INK },
  totalValue: { fontSize: 16, fontFamily: 'Helvetica-Bold', color: INK },
  expectedRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 },
  expectedLabel: { fontSize: 9.5, color: MUTED },
  expectedValue: { fontSize: 9.5, color: MUTED },

  methodHeading: {
    fontSize: 12,
    fontFamily: 'Helvetica-Bold',
    color: ACCENT,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginTop: 26,
    marginBottom: 8,
  },
  sectionTitle: { fontSize: 11, fontFamily: 'Helvetica-Bold', color: INK, marginTop: 10, marginBottom: 4 },
  step: { flexDirection: 'row', marginBottom: 6 },
  stepNo: { width: 20, fontFamily: 'Helvetica-Bold', color: ACCENT, fontSize: 10 },
  stepText: { flex: 1, fontSize: 10.5 },
  notesText: { fontSize: 10.5, whiteSpace: 'pre-wrap' },

  footer: {
    position: 'absolute',
    bottom: 22,
    left: MARGIN_H,
    right: MARGIN_H,
    flexDirection: 'row',
    justifyContent: 'space-between',
    fontSize: 8,
    color: MUTED,
  },
});

function qty(value: number, unit: string): { value: string; unit: string } {
  return { value: formatDocumentQuantity(value), unit };
}

function RecipePrepCardDocument({
  data,
  labels,
  paper,
}: {
  data: RecipePrepCardData;
  labels: RecipePrepCardLabels;
  paper: 'A4' | 'LETTER';
}) {
  const unit = (d: RecipePrepCardData['lines'][number]['dimension']) => labels.units[d];
  const caption = basisCaption(data.basis, labels);

  return (
    <Document>
      <Page size={paper} style={styles.page}>
        <Text style={styles.brand}>{safeText(labels.brand(data.seller.name || null))}</Text>
        <Text style={styles.recipeName}>{safeText(data.recipeName)}</Text>
        <Text style={styles.basisLine}>{safeText(caption)}</Text>

        <View style={styles.tHead}>
          <Text style={[styles.th, styles.thName]}>{labels.ingredient}</Text>
          <Text style={[styles.th, styles.thQty]}>{labels.quantity}</Text>
        </View>
        {data.lines.map((line, i) => {
          const q = qty(line.quantity, unit(line.dimension));
          return (
            <View style={styles.row} key={i} wrap={false}>
              <Text style={styles.cName}>
                {safeText(line.name)}
                {line.isSubRecipe ? <Text style={styles.cSub}>{`  ${labels.subRecipe}`}</Text> : null}
              </Text>
              <View style={styles.cQty}>
                <Text style={styles.cQtyValue}>{q.value}</Text>
                <Text style={styles.cQtyUnit}>{q.unit}</Text>
              </View>
            </View>
          );
        })}

        {data.totalWeightGrams !== null && (
          <View style={styles.totals} wrap={false}>
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>{labels.totalToWeigh}</Text>
              <Text style={styles.totalValue}>
                {formatDocumentQuantity(data.totalWeightGrams)} {labels.units.weight}
              </Text>
            </View>
            {data.expectedFinishedWeightGrams !== null && (
              <View style={styles.expectedRow}>
                <Text style={styles.expectedLabel}>{labels.expectedFinishedWeight}</Text>
                <Text style={styles.expectedValue}>
                  {formatDocumentQuantity(data.expectedFinishedWeightGrams)} {labels.units.weight}
                </Text>
              </View>
            )}
          </View>
        )}

        {data.method.length > 0 ? (
          <View>
            <Text style={styles.methodHeading} minPresenceAhead={40}>
              {labels.method}
            </Text>
            {data.method.map((section, si) => (
              <View key={si}>
                {section.title ? (
                  <Text style={styles.sectionTitle} minPresenceAhead={30}>
                    {safeText(section.title)}
                  </Text>
                ) : null}
                {section.steps.map((step, i) => (
                  <View key={i} style={styles.step} wrap={false}>
                    <Text style={styles.stepNo}>{i + 1}.</Text>
                    <Text style={styles.stepText}>{safeText(step)}</Text>
                  </View>
                ))}
              </View>
            ))}
          </View>
        ) : data.legacyNotes ? (
          <View>
            <Text style={styles.methodHeading} minPresenceAhead={40}>
              {labels.method}
            </Text>
            <Text style={styles.notesText}>{safeText(data.legacyNotes)}</Text>
          </View>
        ) : null}

        <View style={styles.footer} fixed>
          <Text>{safeText(labels.footer(data.recipeName))}</Text>
          <Text render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}

/** Render the Kitchen Scale prep card to PDF bytes. Node runtime only. */
export function renderRecipePrepCardPdf(
  data: RecipePrepCardData,
  labels: RecipePrepCardLabels,
  paper: 'A4' | 'LETTER' = 'A4',
): Promise<Buffer> {
  return renderToBuffer(<RecipePrepCardDocument data={data} labels={labels} paper={paper} />);
}
