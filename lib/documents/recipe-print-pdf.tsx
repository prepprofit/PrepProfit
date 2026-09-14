import { Document, Page, View, Text, Image, StyleSheet, renderToBuffer } from '@react-pdf/renderer';
import type { RecipeDocument } from '@/lib/recipes/recipe-document';
import { safeText } from './format';

/**
 * Print-ready recipe (list "Print" action): ONE recipe — name, what it makes, the
 * ingredient quantities in the saved order, and the preparation method. No
 * navigation, buttons, prices or costs; deliberately no allergen or nutrition block,
 * so it never reads as an approved label. Node runtime only.
 */

export type RecipePrintLabels = {
  makes: string;
  finishedWeight: string;
  yield: string;
  ingredients: string;
  amount: string;
  subRecipe: string;
  method: string;
  noMethod: string;
  footer: string;
};

const INK = '#1f2937';
const MUTED = '#6b7280';
const BORDER = '#e5e7eb';
const ACCENT = '#2c7466';

const styles = StyleSheet.create({
  page: { paddingTop: 44, paddingBottom: 56, paddingHorizontal: 48, fontSize: 11, color: INK, fontFamily: 'Helvetica', lineHeight: 1.45 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 18 },
  seller: { fontSize: 9, color: MUTED },
  logo: { width: 100, maxHeight: 40, objectFit: 'contain' },
  name: { fontSize: 22, fontFamily: 'Helvetica-Bold', color: INK, marginBottom: 4 },
  output: { fontSize: 10, color: MUTED, marginBottom: 20 },
  h2: { fontSize: 12, fontFamily: 'Helvetica-Bold', color: ACCENT, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6, marginTop: 6 },
  row: { flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: BORDER, paddingVertical: 5 },
  cName: { flex: 4, paddingRight: 8 },
  cAmount: { flex: 1.4, textAlign: 'right', fontFamily: 'Helvetica-Bold' },
  sub: { color: MUTED, fontSize: 9 },
  sectionTitle: { fontSize: 11, fontFamily: 'Helvetica-Bold', marginTop: 10, marginBottom: 4 },
  step: { flexDirection: 'row', marginBottom: 7 },
  stepNo: { width: 22, fontFamily: 'Helvetica-Bold', color: ACCENT },
  stepText: { flex: 1 },
  empty: { color: MUTED },
  footer: { position: 'absolute', bottom: 24, left: 48, right: 48, fontSize: 8, color: MUTED, flexDirection: 'row', justifyContent: 'space-between' },
});

function formatAmount(n: number): string {
  return String(Math.round(n * 100) / 100);
}

function RecipePrintDocument({
  doc,
  labels,
  seller,
}: {
  doc: RecipeDocument;
  labels: RecipePrintLabels;
  seller: { name: string; logoUrl: string | null };
}) {
  const outputParts = [
    doc.output.yieldQuantity != null && doc.output.yieldUnit
      ? `${labels.makes} ${formatAmount(doc.output.yieldQuantity)} ${doc.output.yieldUnit}`
      : null,
    doc.output.finishedWeightGrams != null
      ? `${labels.finishedWeight} ${formatAmount(doc.output.finishedWeightGrams)} g`
      : null,
    doc.output.yieldPercentage !== 100 ? `${labels.yield} ${doc.output.yieldPercentage}%` : null,
  ].filter((p): p is string => p !== null);

  return (
    <Document title={doc.name}>
      <Page size="A4" style={styles.page}>
        <View style={styles.header} fixed>
          <Text style={styles.seller}>{safeText(seller.name)}</Text>
          {/* eslint-disable-next-line jsx-a11y/alt-text */}
          {seller.logoUrl && <Image style={styles.logo} src={seller.logoUrl} />}
        </View>

        <Text style={styles.name}>{safeText(doc.name)}</Text>
        {outputParts.length > 0 && <Text style={styles.output}>{outputParts.join('  ·  ')}</Text>}

        <Text style={styles.h2}>{labels.ingredients}</Text>
        <View>
          {doc.lines.map((line) => (
            <View key={line.key} style={styles.row} wrap={false}>
              <Text style={styles.cName}>
                {safeText(line.name)}
                {line.isSubRecipe ? <Text style={styles.sub}>{`  ${labels.subRecipe}`}</Text> : null}
              </Text>
              <Text style={styles.cAmount}>
                {formatAmount(line.amount)} {line.unit}
              </Text>
            </View>
          ))}
        </View>

        <Text style={[styles.h2, { marginTop: 18 }]}>{labels.method}</Text>
        {doc.method.length === 0 ? (
          <Text style={styles.empty}>{labels.noMethod}</Text>
        ) : (
          doc.method.map((section, si) => (
            <View key={si}>
              {section.title ? (
                <Text style={styles.sectionTitle} minPresenceAhead={40}>
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
          ))
        )}

        <View style={styles.footer} fixed>
          <Text>{labels.footer}</Text>
          <Text render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}

export function renderRecipePrintPdf(
  doc: RecipeDocument,
  labels: RecipePrintLabels,
  seller: { name: string; logoUrl: string | null },
): Promise<Buffer> {
  return renderToBuffer(<RecipePrintDocument doc={doc} labels={labels} seller={seller} />);
}
