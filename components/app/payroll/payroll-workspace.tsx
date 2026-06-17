'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useActionError } from '@/lib/i18n/use-action-error';
import {
  centsToAmountInput,
  formatMoney,
  parseMoneyToCents,
} from '@/lib/format/money';
import type { ActionResult } from '@/lib/action-result';
import {
  closeShiftAction,
  createEmployeeAction,
  createShiftAction,
  deleteEmployeeAction,
  deleteShiftAction,
  setEmployeeActiveAction,
  updateEmployeeAction,
} from '@/app/(app)/payroll/actions';

export type EmployeeRow = {
  id: string;
  name: string;
  email: string | null;
  hourlyRateCents: number;
  active: boolean;
};

export type ShiftRow = {
  id: string;
  employeeId: string;
  employeeName: string;
  startedAtMs: number;
  endedAtMs: number | null;
  breakMinutes: number;
  note: string | null;
  workedMinutes: number;
  payCents: number;
};

export type SummaryRow = {
  employeeId: string;
  name: string;
  shiftCount: number;
  workedMinutes: number;
  payDueCents: number;
};

/** epoch ms → 'YYYY-MM-DDTHH:mm' in local time, for a datetime-local input. */
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

/** Total minutes → 'Xh Ym'. */
function formatMinutes(mins: number): string {
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function formatInstant(ms: number): string {
  return new Date(ms).toLocaleString('en', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function PayrollWorkspace({
  currency,
  employees,
  shifts,
  summaries,
  showArchived,
  toggleArchivedHref,
}: {
  currency: string;
  employees: EmployeeRow[];
  shifts: ShiftRow[];
  summaries: SummaryRow[];
  showArchived: boolean;
  toggleArchivedHref: string;
}) {
  const actionError = useActionError();
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

  const run = React.useCallback(
    (fn: () => Promise<ActionResult<unknown>>, after?: () => void) => {
      setError(null);
      startTransition(async () => {
        const result = await fn();
        if (result.ok) {
          after?.();
          router.refresh();
        } else {
          setError(actionError(result.code));
        }
      });
    },
    [actionError, router],
  );

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
        >
          {error}
        </div>
      )}

      <EmployeeManager
        currency={currency}
        employees={employees}
        showArchived={showArchived}
        toggleArchivedHref={toggleArchivedHref}
        pending={pending}
        run={run}
        setError={setError}
      />

      <ShiftLogger
        currency={currency}
        employees={employees}
        shifts={shifts}
        pending={pending}
        run={run}
        setError={setError}
      />

      <SummaryTable currency={currency} summaries={summaries} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Employees                                                                   */
/* -------------------------------------------------------------------------- */

function EmployeeManager({
  currency,
  employees,
  showArchived,
  toggleArchivedHref,
  pending,
  run,
  setError,
}: {
  currency: string;
  employees: EmployeeRow[];
  showArchived: boolean;
  toggleArchivedHref: string;
  pending: boolean;
  run: (fn: () => Promise<ActionResult<unknown>>, after?: () => void) => void;
  setError: (msg: string | null) => void;
}) {
  const t = useTranslations('payroll.employees');
  const tErr = useTranslations('payroll.errors');
  const tCommon = useTranslations('common');
  const [open, setOpen] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [name, setName] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [rate, setRate] = React.useState('');
  const [deleteTarget, setDeleteTarget] = React.useState<EmployeeRow | null>(null);

  const reset = () => {
    setEditingId(null);
    setName('');
    setEmail('');
    setRate('');
    setOpen(false);
  };

  const startEdit = (e: EmployeeRow) => {
    setEditingId(e.id);
    setName(e.name);
    setEmail(e.email ?? '');
    setRate(centsToAmountInput(e.hourlyRateCents));
    setOpen(true);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim() === '') {
      setError(tErr('nameRequired'));
      return;
    }
    const payload = {
      name,
      email,
      hourlyRateCents: parseMoneyToCents(rate),
    };
    run(
      () =>
        editingId
          ? updateEmployeeAction(editingId, payload)
          : createEmployeeAction(payload),
      reset,
    );
  };

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>{t('title')}</CardTitle>
        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link href={toggleArchivedHref}>
              {showArchived ? tCommon('cancel') : t('showArchived')}
            </Link>
          </Button>
          {!open && (
            <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
              <Plus className="size-4" />
              {t('add')}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {open && (
          <form
            onSubmit={submit}
            className="grid grid-cols-1 items-end gap-3 rounded-lg border border-border bg-surface-2 p-4 sm:grid-cols-[1fr_1fr_8rem_auto]"
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="emp-name">{t('name')}</Label>
              <Input
                id="emp-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="emp-email">{t('email')}</Label>
              <Input
                id="emp-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="emp-rate">{t('rate')}</Label>
              <Input
                id="emp-rate"
                inputMode="decimal"
                placeholder="0.00"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-2">
              <Button type="submit" size="sm" disabled={pending}>
                {editingId ? tCommon('save') : tCommon('add')}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={reset} disabled={pending}>
                {tCommon('cancel')}
              </Button>
            </div>
          </form>
        )}

        {employees.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {employees.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                <div className="flex min-w-0 flex-col">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">
                      {e.name}
                    </span>
                    {!e.active && <Badge variant="neutral">{t('archived')}</Badge>}
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {formatMoney(e.hourlyRateCents, currency)}/h
                    {e.email ? ` · ${e.email}` : ''}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={t('edit')}
                    disabled={pending}
                    onClick={() => startEdit(e)}
                  >
                    <Pencil className="size-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    onClick={() => run(() => setEmployeeActiveAction(e.id, !e.active))}
                  >
                    {e.active ? t('archive') : t('reactivate')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={t('delete')}
                    disabled={pending}
                    onClick={() => setDeleteTarget(e)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <ConfirmDialog
        open={deleteTarget !== null}
        title={t('deleteTitle')}
        description={t('deleteBody')}
        confirmLabel={tCommon('deleteForever')}
        cancelLabel={tCommon('cancel')}
        destructive
        pending={pending}
        onConfirm={() => {
          if (deleteTarget) run(() => deleteEmployeeAction(deleteTarget.id));
          setDeleteTarget(null);
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Shifts                                                                      */
/* -------------------------------------------------------------------------- */

function ShiftLogger({
  currency,
  employees,
  shifts,
  pending,
  run,
  setError,
}: {
  currency: string;
  employees: EmployeeRow[];
  shifts: ShiftRow[];
  pending: boolean;
  run: (fn: () => Promise<ActionResult<unknown>>, after?: () => void) => void;
  setError: (msg: string | null) => void;
}) {
  const t = useTranslations('payroll.shifts');
  const tErr = useTranslations('payroll.errors');
  const tCommon = useTranslations('common');
  const activeEmployees = employees.filter((e) => e.active);

  const [employeeId, setEmployeeId] = React.useState(activeEmployees[0]?.id ?? '');
  const [start, setStart] = React.useState(() => toLocalInput(Date.now()));
  const [end, setEnd] = React.useState('');
  const [breakMin, setBreakMin] = React.useState('0');
  const [note, setNote] = React.useState('');
  const [deleteTarget, setDeleteTarget] = React.useState<ShiftRow | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!employeeId) {
      setError(tErr('nameRequired'));
      return;
    }
    if (start === '') {
      setError(tErr('startRequired'));
      return;
    }
    const startedAtMs = new Date(start).getTime();
    const endedAtMs = end === '' ? null : new Date(end).getTime();
    if (endedAtMs !== null && endedAtMs < startedAtMs) {
      setError(tErr('endBeforeStart'));
      return;
    }
    run(
      () =>
        createShiftAction({
          employeeId,
          startedAtMs,
          endedAtMs,
          breakMinutes: Number(breakMin) || 0,
          note,
        }),
      () => {
        setEnd('');
        setBreakMin('0');
        setNote('');
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form
          onSubmit={submit}
          className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2 lg:grid-cols-3"
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="shift-emp">{t('employee')}</Label>
            <Select
              id="shift-emp"
              value={employeeId}
              onChange={(e) => setEmployeeId(e.target.value)}
            >
              {activeEmployees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="shift-start">{t('start')}</Label>
            <Input
              id="shift-start"
              type="datetime-local"
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="shift-end">{t('end')}</Label>
            <Input
              id="shift-end"
              type="datetime-local"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="shift-break">{t('break')}</Label>
            <Input
              id="shift-break"
              inputMode="numeric"
              value={breakMin}
              onChange={(e) => setBreakMin(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="shift-note">{t('note')}</Label>
            <Input
              id="shift-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <div>
            <Button type="submit" disabled={pending || activeEmployees.length === 0}>
              <Plus className="size-4" />
              {t('add')}
            </Button>
          </div>
        </form>

        {shifts.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {shifts.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-sm font-medium text-foreground">
                    {s.employeeName}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatInstant(s.startedAtMs)}
                    {' – '}
                    {s.endedAtMs === null ? (
                      <Badge variant="warning">{t('open')}</Badge>
                    ) : (
                      formatInstant(s.endedAtMs)
                    )}
                    {s.breakMinutes > 0 ? ` · ${s.breakMinutes}m break` : ''}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm text-muted-foreground">
                    {formatMinutes(s.workedMinutes)}
                  </span>
                  <span className="font-semibold text-foreground">
                    {formatMoney(s.payCents, currency)}
                  </span>
                  {s.endedAtMs === null && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={pending}
                      onClick={() =>
                        run(() => closeShiftAction(s.id, { endedAtMs: Date.now() }))
                      }
                    >
                      {t('close')}
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={t('delete')}
                    disabled={pending}
                    onClick={() => setDeleteTarget(s)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <ConfirmDialog
        open={deleteTarget !== null}
        title={t('deleteTitle')}
        description={t('deleteBody')}
        confirmLabel={tCommon('deleteForever')}
        cancelLabel={tCommon('cancel')}
        destructive
        pending={pending}
        onConfirm={() => {
          if (deleteTarget) run(() => deleteShiftAction(deleteTarget.id));
          setDeleteTarget(null);
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Summary                                                                     */
/* -------------------------------------------------------------------------- */

function SummaryTable({
  currency,
  summaries,
}: {
  currency: string;
  summaries: SummaryRow[];
}) {
  const t = useTranslations('payroll.summary');

  if (summaries.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="py-2 pr-3 font-medium">{t('title')}</th>
                <th className="py-2 px-3 text-right font-medium">{t('shifts')}</th>
                <th className="py-2 px-3 text-right font-medium">{t('hours')}</th>
                <th className="py-2 pl-3 text-right font-medium">{t('payDue')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {summaries.map((s) => (
                <tr key={s.employeeId}>
                  <td className="py-2 pr-3 text-foreground">{s.name}</td>
                  <td className="py-2 px-3 text-right text-muted-foreground">
                    {s.shiftCount}
                  </td>
                  <td className="py-2 px-3 text-right text-muted-foreground">
                    {formatMinutes(s.workedMinutes)}
                  </td>
                  <td className="py-2 pl-3 text-right font-semibold text-foreground">
                    {formatMoney(s.payDueCents, currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
