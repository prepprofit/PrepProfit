import {
  Document,
  Page,
  View,
  Text,
  Image,
  StyleSheet,
  renderToBuffer,
} from '@react-pdf/renderer';
import type { AllergenMatrixData, AllergenMatrixLabels } from './types';
import { safeText } from './format';

/**
 * Kitchen allergen matrix PDF (Sprint 9), built with `@react-pdf/renderer` (Node
 * runtime only). OPERATIONAL and money-free — it consumes only `AllergenMatrixData`
 * (recipe names + presence cells), so it can never print a cost. Landscape so the
 * allergen columns fit. Every surface carries the non-legal disclaimer and uses
 * "no allergens recorded" (never "allergen-free").
 */

const ACCENT = '#c2410c';
const INK = '#1f2937';
const MUTED = '#6b7280';
const BORDER = '#e5e7eb';
const CONTAINS = '#b91c1c';

const styles = StyleSheet.create({
  page: {
    paddingVertical: 36,
    paddingHorizontal: 40,
    fontSize: 9,
    color: INK,
    fontFamily: 'Helvetica',
    lineHeight: 1.3,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 16,
  },
  sellerBlock: { flexDirection: 'column', maxWidth: 320 },
  logo: { width: 110, maxHeight: 44, marginBottom: 6, objectFit: 'contain' },
  sellerName: { fontSize: 12, fontFamily: 'Helvetica-Bold', color: INK },
  docMeta: { flexDirection: 'column', alignItems: 'flex-end' },
  docTitle: {
    fontSize: 18,
    fontFamily: 'Helvetica-Bold',
    color: ACCENT,
    letterSpacing: 1,
    marginBottom: 4,
  },
  generatedOn: { fontSize: 9, color: MUTED },
  disclaimer: {
    fontSize: 8,
    color: MUTED,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: BORDER,
    borderRadius: 4,
    padding: 6,
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
    alignItems: 'center',
  },
  th: {
    fontSize: 7,
    fontFamily: 'Helvetica-Bold',
    color: MUTED,
    textTransform: 'uppercase',
  },
  cRecipe: { flex: 3, paddingRight: 6 },
  cAllergen: { flex: 1, textAlign: 'center' },
  recipeName: { fontSize: 9, fontFamily: 'Helvetica-Bold' },
  unreviewedNote: { fontSize: 7, color: MUTED },
  markContains: { fontSize: 9, fontFamily: 'Helvetica-Bold', color: CONTAINS, textAlign: 'center' },
  markMay: { fontSize: 8, color: MUTED, textAlign: 'center' },
  empty: { color: MUTED, fontSize: 10, paddingVertical: 8 },
});

function AllergenMatrixBody({
  data,
  labels,
}: {
  data: AllergenMatrixData;
  labels: AllergenMatrixLabels;
}) {
  const { seller } = data;
  const hasAllergens = data.allergens.length > 0;

  return (
    <Document>
      <Page size="A4" orientation="landscape" style={styles.page}>
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
            <Text style={styles.generatedOn}>
              {labels.generatedOn}: {data.generatedOn}
            </Text>
          </View>
        </View>

        <Text style={styles.disclaimer}>{labels.disclaimer}</Text>

        {data.rows.length === 0 || !hasAllergens ? (
          <Text style={styles.empty}>{labels.noAllergensRecorded}</Text>
        ) : (
          <View>
            <View style={styles.tHead}>
              <Text style={[styles.th, styles.cRecipe]}>{labels.recipe}</Text>
              {data.allergens.map((slug) => (
                <Text style={[styles.th, styles.cAllergen]} key={slug}>
                  {labels.allergenLabels[slug]}
                </Text>
              ))}
            </View>
            {data.rows.map((row, i) => (
              <View style={styles.tRow} key={i} wrap={false}>
                <View style={styles.cRecipe}>
                  <Text style={styles.recipeName}>{safeText(row.recipeName)}</Text>
                  {row.hasUnreviewedIngredient && (
                    <Text style={styles.unreviewedNote}>{labels.unreviewed}</Text>
                  )}
                </View>
                {data.allergens.map((slug) => {
                  const presence = row.cells[slug];
                  if (presence === 'contains') {
                    return (
                      <Text style={[styles.cAllergen, styles.markContains]} key={slug}>
                        {labels.presence.contains}
                      </Text>
                    );
                  }
                  if (presence === 'may_contain') {
                    return (
                      <Text style={[styles.cAllergen, styles.markMay]} key={slug}>
                        {labels.presence.may_contain}
                      </Text>
                    );
                  }
                  return <Text style={styles.cAllergen} key={slug} />;
                })}
              </View>
            ))}
          </View>
        )}
      </Page>
    </Document>
  );
}

/** Render the allergen matrix to PDF bytes. Node runtime only. */
export function renderAllergenMatrixPdf(
  data: AllergenMatrixData,
  labels: AllergenMatrixLabels,
): Promise<Buffer> {
  return renderToBuffer(<AllergenMatrixBody data={data} labels={labels} />);
}
