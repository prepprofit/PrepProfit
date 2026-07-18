import {
  Document,
  Page,
  View,
  Text,
  StyleSheet,
  renderToBuffer,
} from '@react-pdf/renderer';
import { safeText } from './format';

/**
 * Nutrition label PDF (Recipes 2.0 Fase 6, plan §9.6) — `@react-pdf/renderer`,
 * Node runtime only. MONEY-FREE by construction: the view-model carries only
 * label-rounded nutrient values, allergen names and provenance strings.
 *
 * The label is an ESTIMATE: the disclaimer is always printed, and an
 * incomplete rollup renders a diagonal `ESTIMATED / INCOMPLETE` watermark
 * (master plan §7.4/§19.1 — no compliance claim, ever). All strings arrive
 * pre-translated; unknown values print as "—", never 0.
 */

export type NutritionLabelPdfRow = {
  label: string;
  /** e.g. "12 g", "< 5 mg", or null → "—". */
  valueText: string | null;
  dvText: string | null;
  indent: boolean;
  bold: boolean;
};

export type NutritionLabelPdfData = {
  recipeName: string;
  orgName: string | null;
  title: string;
  servingText: string;
  rows: NutritionLabelPdfRow[];
  containsLabel: string;
  containsText: string | null;
  mayContainLabel: string;
  mayContainText: string | null;
  attribution: string;
  disclaimer: string;
  /** Non-null → draft: printed as the watermark text. */
  watermark: string | null;
};

const INK = '#111111';
const MUTED = '#6b7280';
const BORDER = '#e5e7eb';

const styles = StyleSheet.create({
  page: {
    paddingVertical: 40,
    paddingHorizontal: 44,
    fontSize: 10,
    color: INK,
    fontFamily: 'Helvetica',
    lineHeight: 1.35,
  },
  orgName: { color: MUTED, marginBottom: 2 },
  recipeName: { fontSize: 15, fontFamily: 'Helvetica-Bold', marginBottom: 14 },
  facts: {
    borderWidth: 2,
    borderColor: INK,
    padding: 10,
    width: 280,
  },
  title: { fontSize: 20, fontFamily: 'Helvetica-Bold', lineHeight: 1.1 },
  serving: {
    color: MUTED,
    paddingBottom: 4,
    borderBottomWidth: 6,
    borderBottomColor: INK,
    marginBottom: 4,
  },
  row: {
    flexDirection: 'row',
    borderBottomWidth: 0.5,
    borderBottomColor: BORDER,
    paddingVertical: 2,
  },
  label: { flexGrow: 1 },
  bold: { fontFamily: 'Helvetica-Bold' },
  indent: { paddingLeft: 12 },
  value: { width: 70, textAlign: 'right' },
  dv: { width: 40, textAlign: 'right', color: MUTED },
  allergens: { marginTop: 14, width: 280 },
  allergenLabel: { fontFamily: 'Helvetica-Bold' },
  footer: { marginTop: 14, width: 280, color: MUTED, fontSize: 8 },
  watermark: {
    position: 'absolute',
    top: 320,
    left: 60,
    transform: 'rotate(-30deg)',
    fontSize: 34,
    fontFamily: 'Helvetica-Bold',
    color: '#dc2626',
    opacity: 0.25,
  },
});

export function NutritionLabelPdf({ data }: { data: NutritionLabelPdfData }) {
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        {data.watermark ? (
          <Text style={styles.watermark} fixed>
            {safeText(data.watermark)}
          </Text>
        ) : null}
        {data.orgName ? (
          <Text style={styles.orgName}>{safeText(data.orgName)}</Text>
        ) : null}
        <Text style={styles.recipeName}>{safeText(data.recipeName)}</Text>

        <View style={styles.facts}>
          <Text style={styles.title}>{safeText(data.title)}</Text>
          <Text style={styles.serving}>{safeText(data.servingText)}</Text>
          {data.rows.map((row, i) => (
            <View key={i} style={styles.row}>
              <Text
                style={[
                  styles.label,
                  ...(row.bold ? [styles.bold] : []),
                  ...(row.indent ? [styles.indent] : []),
                ]}
              >
                {safeText(row.label)}
              </Text>
              <Text style={styles.value}>{safeText(row.valueText ?? '—')}</Text>
              <Text style={styles.dv}>{safeText(row.dvText ?? '')}</Text>
            </View>
          ))}
        </View>

        <View style={styles.allergens}>
          <Text>
            <Text style={styles.allergenLabel}>{safeText(data.containsLabel)}: </Text>
            {safeText(data.containsText ?? '—')}
          </Text>
          <Text>
            <Text style={styles.allergenLabel}>{safeText(data.mayContainLabel)}: </Text>
            {safeText(data.mayContainText ?? '—')}
          </Text>
        </View>

        <View style={styles.footer}>
          <Text>{safeText(data.attribution)}</Text>
          <Text>{safeText(data.disclaimer)}</Text>
        </View>
      </Page>
    </Document>
  );
}

export function renderNutritionLabelPdf(
  data: NutritionLabelPdfData,
): Promise<Buffer> {
  return renderToBuffer(<NutritionLabelPdf data={data} />);
}
