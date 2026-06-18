import type { PayrollDocumentData, PayrollDocumentLabels } from './types';
import {
  type Cell,
  type Sheet,
  emptyCell,
  headerCell,
  moneyCell,
  numberCell,
  renderXlsx,
  textCell,
} from './xlsx';

/**
 * Payroll Excel export (Sprint 3.5B). `buildPayrollSheetRows` is pure (testable for
 * exact cells + formula-injection neutralization); `renderPayrollXlsx` is the thin
 * Node renderer. One row per employee + a totals row. Hours are written as a real
 * Number (worked minutes / 60) and pay as a money Number so Excel can sum/sort them;
 * employee names (the only free text) are formula-injection-neutralized.
 */
const HOURS_FORMAT = '0.00';

export function buildPayrollSheetRows(
  data: PayrollDocumentData,
  labels: PayrollDocumentLabels,
): Cell[][] {
  const rows: Cell[][] = [];

  rows.push([headerCell(labels.title)]);
  rows.push([textCell(labels.period), textCell(data.periodLabel)]);
  rows.push([emptyCell]);

  rows.push([
    headerCell(labels.employee),
    headerCell(labels.shifts),
    headerCell(labels.hours),
    headerCell(labels.pay),
  ]);

  for (const r of data.rows) {
    rows.push([
      textCell(r.name),
      numberCell(r.shiftCount),
      numberCell(r.workedMinutes / 60, HOURS_FORMAT),
      moneyCell(r.payDueCents),
    ]);
  }

  rows.push([
    headerCell(labels.total),
    numberCell(data.totalShiftCount),
    numberCell(data.totalWorkedMinutes / 60, HOURS_FORMAT),
    moneyCell(data.totalPayCents),
  ]);

  return rows;
}

export function renderPayrollXlsx(
  data: PayrollDocumentData,
  labels: PayrollDocumentLabels,
): Promise<Buffer> {
  const sheet: Sheet = {
    name: labels.title,
    rows: buildPayrollSheetRows(data, labels),
    columns: [{ width: 30 }, { width: 12 }, { width: 12 }, { width: 16 }],
  };
  return renderXlsx([sheet]);
}
