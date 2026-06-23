'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { ArrowLeftRight, Boxes, ClipboardList, Plus, Trash2 } from 'lucide-react';
import type { Dimension } from '@/lib/units';
import type { MeasurementSystem } from '@/lib/units';
import { formatQuantity } from '@/lib/units';
import { formatMoney } from '@/lib/format/money';
import { lineCostCents } from '@/lib/calculations/recipeCost';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { useActionError } from '@/lib/i18n/use-action-error';
import {
  createAreaAction,
  deleteAreaAction,
  renameAreaAction,
} from '@/app/(app)/inventory/area-actions';
import {
  commitStockCountAction,
  createStockCountAction,
  deleteStockCountAction,
  transferStockAction,
  updateStockCountAction,
} from '@/app/(app)/inventory/depth-actions';

type Area = { id: string; name: string; isDefault: boolean; updatedAt: string };
type IngredientLite = { id: string; name: string; dimension: Dimension };
type CountLite = {
  id: string;
  storageAreaId: string | null;
  status: 'draft' | 'committed';
  committedAt: string | null;
  updatedAt: string;
};

type Props = {
  manager: boolean;
  currency: string;
  measurementSystem: MeasurementSystem;
  areas: Area[];
  ingredients: IngredientLite[];
  balancesByArea: Record<string, Record<string, number>>;
  priceByIngredient: Record<string, number> | null;
  counts: CountLite[];
};

const ALL = '__all__';

export function InventoryDepth(props: Props) {
  const t = useTranslations('inventory');
  const [error, setError] = React.useState<string | null>(null);
  const [pane, setPane] = React.useState<'none' | 'transfer' | 'areas' | 'counts'>('none');

  const togglePane = (p: 'transfer' | 'areas' | 'counts') =>
    setPane((cur) => (cur === p ? 'none' : p));

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
        >
          {error}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant={pane === 'transfer' ? 'default' : 'outline'}
          size="sm"
          onClick={() => togglePane('transfer')}
        >
          <ArrowLeftRight className="size-4" />
          {t('transfer.open')}
        </Button>
        <Button
          type="button"
          variant={pane === 'counts' ? 'default' : 'outline'}
          size="sm"
          onClick={() => togglePane('counts')}
        >
          <ClipboardList className="size-4" />
          {t('counts.title')}
        </Button>
        {props.manager && (
          <Button
            type="button"
            variant={pane === 'areas' ? 'default' : 'outline'}
            size="sm"
            onClick={() => togglePane('areas')}
          >
            <Boxes className="size-4" />
            {t('areas.manage')}
          </Button>
        )}
      </div>

      {pane === 'transfer' && (
        <TransferPane {...props} onError={setError} />
      )}
      {pane === 'areas' && props.manager && (
        <AreasPane areas={props.areas} onError={setError} />
      )}
      {pane === 'counts' && <CountsPane {...props} onError={setError} />}

      <BalancesTable {...props} />
    </div>
  );
}

// ── Per-area balances table ─────────────────────────────────────────────────

function BalancesTable(props: Props) {
  const t = useTranslations('inventory');
  const [areaId, setAreaId] = React.useState<string>(ALL);

  const balanceOf = React.useCallback(
    (ingredientId: string): number => {
      if (areaId === ALL) {
        return props.areas.reduce(
          (sum, a) => sum + (props.balancesByArea[a.id]?.[ingredientId] ?? 0),
          0,
        );
      }
      return props.balancesByArea[areaId]?.[ingredientId] ?? 0;
    },
    [areaId, props.areas, props.balancesByArea],
  );

  const valueOf = (ingredient: IngredientLite, balance: number): number | null => {
    if (!props.priceByIngredient) return null;
    const priceCents = props.priceByIngredient[ingredient.id] ?? 0;
    return Math.round(
      lineCostCents({ dimension: ingredient.dimension, priceCents, quantity: balance }),
    );
  };

  if (props.ingredients.length === 0) {
    return (
      <p className="px-1 py-8 text-center text-sm text-muted-foreground">{t('empty')}</p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <label className="flex w-fit items-center gap-2 text-sm">
        <span className="text-muted-foreground">{t('areaFilter.label')}</span>
        <Select
          aria-label={t('areaFilter.label')}
          className="w-44"
          value={areaId}
          onChange={(e) => setAreaId(e.target.value)}
        >
          <option value={ALL}>{t('areaFilter.all')}</option>
          {props.areas.map((a) => (
            <option key={a.id} value={a.id}>
              {a.isDefault ? t('defaultAreaName') : a.name}
            </option>
          ))}
        </Select>
      </label>

      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <th className="px-3 py-2">{t('columns.ingredient')}</th>
              <th className="px-3 py-2">{t('columns.stock')}</th>
              {props.priceByIngredient && (
                <th className="px-3 py-2 text-right">{t('columns2.value')}</th>
              )}
            </tr>
          </thead>
          <tbody>
            {props.ingredients.map((ingredient) => {
              const balance = balanceOf(ingredient.id);
              const value = valueOf(ingredient, balance);
              return (
                <tr key={ingredient.id} className="border-b border-border last:border-0">
                  <td className="px-3 py-2 font-medium text-foreground">{ingredient.name}</td>
                  <td className="px-3 py-2 tabular-nums">
                    {formatQuantity(balance, ingredient.dimension, props.measurementSystem)}
                  </td>
                  {props.priceByIngredient && (
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                      {value === null ? '—' : formatMoney(value, props.currency)}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

// ── Transfer ────────────────────────────────────────────────────────────────

function TransferPane(
  props: Props & { onError: (m: string | null) => void },
) {
  const t = useTranslations('inventory');
  const actionError = useActionError();
  const [ingredientId, setIngredientId] = React.useState('');
  const [fromId, setFromId] = React.useState(props.areas[0]?.id ?? '');
  const [toId, setToId] = React.useState(props.areas[1]?.id ?? props.areas[0]?.id ?? '');
  const [qty, setQty] = React.useState('');
  const [pending, startTransition] = React.useTransition();
  const transferIdRef = React.useRef(crypto.randomUUID());

  const submit = () => {
    const quantity = Number(qty);
    if (!ingredientId || !(quantity > 0)) {
      props.onError(t('errors.quantity'));
      return;
    }
    if (fromId === toId) {
      props.onError(t('transfer.sameArea'));
      return;
    }
    props.onError(null);
    startTransition(async () => {
      const result = await transferStockAction({
        ingredientId,
        areaFromId: fromId,
        areaToId: toId,
        qty: quantity,
        clientTransferId: transferIdRef.current,
      });
      if (result.ok) {
        transferIdRef.current = crypto.randomUUID();
        setQty('');
        // Reflect the new split without a full reload.
        window.location.reload();
      } else {
        props.onError(actionError(result.code));
      }
    });
  };

  return (
    <Card className="flex flex-col gap-3 p-4">
      <h3 className="text-sm font-semibold text-foreground">{t('transfer.title')}</h3>
      <div className="flex flex-wrap items-end gap-2">
        <Field label={t('transfer.ingredient')}>
          <Select
            className="w-48"
            value={ingredientId}
            disabled={pending}
            onChange={(e) => setIngredientId(e.target.value)}
          >
            <option value="">{t('transfer.selectIngredient')}</option>
            {props.ingredients.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('transfer.from')}>
          <AreaSelect areas={props.areas} value={fromId} onChange={setFromId} disabled={pending} />
        </Field>
        <Field label={t('transfer.to')}>
          <AreaSelect areas={props.areas} value={toId} onChange={setToId} disabled={pending} />
        </Field>
        <Field label={t('transfer.quantity')}>
          <Input
            inputMode="decimal"
            className="w-24"
            placeholder="0"
            value={qty}
            disabled={pending}
            onChange={(e) => setQty(e.target.value)}
          />
        </Field>
        <Button type="button" size="sm" disabled={pending} onClick={submit}>
          {t('transfer.submit')}
        </Button>
      </div>
    </Card>
  );
}

// ── Areas management (manager) ───────────────────────────────────────────────

function AreasPane({
  areas,
  onError,
}: {
  areas: Area[];
  onError: (m: string | null) => void;
}) {
  const t = useTranslations('inventory');
  const actionError = useActionError();
  const [newName, setNewName] = React.useState('');
  const [pending, startTransition] = React.useTransition();

  const refresh = () => window.location.reload();

  const add = () => {
    if (newName.trim() === '') return;
    onError(null);
    startTransition(async () => {
      const result = await createAreaAction({ name: newName });
      if (result.ok) {
        setNewName('');
        refresh();
      } else onError(actionError(result.code));
    });
  };

  return (
    <Card className="flex flex-col gap-3 p-4">
      <h3 className="text-sm font-semibold text-foreground">{t('areas.title')}</h3>
      <p className="text-xs text-muted-foreground">{t('areas.subtitle')}</p>
      <ul className="flex flex-col gap-2">
        {areas.map((area) => (
          <AreaRow key={area.id} area={area} onError={onError} onChanged={refresh} />
        ))}
      </ul>
      <div className="flex items-center gap-2">
        <Input
          className="w-48"
          placeholder={t('areas.namePlaceholder')}
          value={newName}
          disabled={pending}
          onChange={(e) => setNewName(e.target.value)}
        />
        <Button type="button" size="sm" variant="outline" disabled={pending} onClick={add}>
          <Plus className="size-4" />
          {t('areas.add')}
        </Button>
      </div>
    </Card>
  );
}

function AreaRow({
  area,
  onError,
  onChanged,
}: {
  area: Area;
  onError: (m: string | null) => void;
  onChanged: () => void;
}) {
  const t = useTranslations('inventory');
  const actionError = useActionError();
  const [editing, setEditing] = React.useState(false);
  const [name, setName] = React.useState(area.name);
  const [pending, startTransition] = React.useTransition();

  const save = () => {
    onError(null);
    startTransition(async () => {
      const result = await renameAreaAction(area.id, {
        expectedUpdatedAt: area.updatedAt,
        name,
      });
      if (result.ok) {
        setEditing(false);
        onChanged();
      } else onError(actionError(result.code));
    });
  };

  const remove = () => {
    onError(null);
    startTransition(async () => {
      const result = await deleteAreaAction(area.id, { expectedUpdatedAt: area.updatedAt });
      if (result.ok) onChanged();
      else onError(actionError(result.code));
    });
  };

  return (
    <li className="flex items-center gap-2">
      {editing ? (
        <>
          <Input
            className="w-48"
            value={name}
            disabled={pending}
            onChange={(e) => setName(e.target.value)}
          />
          <Button type="button" size="sm" disabled={pending} onClick={save}>
            {t('areas.save')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => {
              setEditing(false);
              setName(area.name);
            }}
          >
            {t('areas.cancel')}
          </Button>
        </>
      ) : (
        <>
          <span className="min-w-40 font-medium text-foreground">
            {area.isDefault ? t('defaultAreaName') : area.name}
          </span>
          {area.isDefault && <Badge variant="neutral">{t('areas.defaultBadge')}</Badge>}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => setEditing(true)}
          >
            {t('areas.rename')}
          </Button>
          {!area.isDefault && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={remove}
            >
              <Trash2 className="size-4" />
            </Button>
          )}
        </>
      )}
    </li>
  );
}

// ── Counts ───────────────────────────────────────────────────────────────────

function CountsPane(props: Props & { onError: (m: string | null) => void }) {
  const t = useTranslations('inventory');
  const actionError = useActionError();
  const [areaId, setAreaId] = React.useState(props.areas[0]?.id ?? '');
  const [editing, setEditing] = React.useState<CountLite | null>(null);
  const [pending, startTransition] = React.useTransition();

  const areaName = (id: string | null) => {
    const a = props.areas.find((x) => x.id === id);
    if (!a) return '—';
    return a.isDefault ? t('defaultAreaName') : a.name;
  };

  const start = () => {
    props.onError(null);
    startTransition(async () => {
      const result = await createStockCountAction({ storageAreaId: areaId, note: null });
      if (result.ok) {
        setEditing({
          id: result.data.id,
          storageAreaId: result.data.storageAreaId,
          status: 'draft',
          committedAt: null,
          updatedAt: result.data.updatedAt as unknown as string,
        });
      } else props.onError(actionError(result.code));
    });
  };

  if (editing) {
    return (
      <CountEditor
        count={editing}
        ingredients={props.ingredients}
        measurementSystem={props.measurementSystem}
        systemBalances={props.balancesByArea[editing.storageAreaId ?? ''] ?? {}}
        onError={props.onError}
        onDone={() => window.location.reload()}
        onCancel={() => setEditing(null)}
      />
    );
  }

  return (
    <Card className="flex flex-col gap-3 p-4">
      <h3 className="text-sm font-semibold text-foreground">{t('counts.title')}</h3>
      <p className="text-xs text-muted-foreground">{t('counts.subtitle')}</p>
      <div className="flex items-end gap-2">
        <Field label={t('counts.area')}>
          <AreaSelect areas={props.areas} value={areaId} onChange={setAreaId} disabled={pending} />
        </Field>
        <Button type="button" size="sm" disabled={pending} onClick={start}>
          <Plus className="size-4" />
          {t('counts.start')}
        </Button>
      </div>

      {props.counts.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('counts.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-1 text-sm">
          {props.counts.map((c) => (
            <li key={c.id} className="flex items-center gap-2 border-b border-border py-1 last:border-0">
              <span className="min-w-32 font-medium text-foreground">{areaName(c.storageAreaId)}</span>
              <Badge variant={c.status === 'committed' ? 'positive' : 'neutral'}>
                {c.status === 'committed' ? t('counts.committed') : t('counts.draft')}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function CountEditor({
  count,
  ingredients,
  measurementSystem,
  systemBalances,
  onError,
  onDone,
  onCancel,
}: {
  count: CountLite;
  ingredients: IngredientLite[];
  measurementSystem: MeasurementSystem;
  systemBalances: Record<string, number>;
  onError: (m: string | null) => void;
  onDone: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations('inventory');
  const actionError = useActionError();
  // Pre-fill each line with the current system balance as an editable hint.
  const [counted, setCounted] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(
      ingredients.map((i) => [i.id, String(systemBalances[i.id] ?? 0)]),
    ),
  );
  const [updatedAt, setUpdatedAt] = React.useState(count.updatedAt);
  const [pending, startTransition] = React.useTransition();

  const buildItems = () =>
    ingredients
      .map((i) => ({ ingredientId: i.id, countedCanonical: Number(counted[i.id]) }))
      .filter((it) => Number.isFinite(it.countedCanonical) && it.countedCanonical >= 0);

  const save = (then?: () => void) => {
    onError(null);
    startTransition(async () => {
      const result = await updateStockCountAction(count.id, {
        expectedUpdatedAt: updatedAt,
        note: null,
        items: buildItems(),
      });
      if (result.ok) {
        setUpdatedAt(result.data.updatedAt as unknown as string);
        then?.();
      } else onError(actionError(result.code));
    });
  };

  const commit = () => {
    // Save the latest entries first, then commit using the fresh token.
    onError(null);
    startTransition(async () => {
      const saved = await updateStockCountAction(count.id, {
        expectedUpdatedAt: updatedAt,
        note: null,
        items: buildItems(),
      });
      if (!saved.ok) {
        onError(actionError(saved.code));
        return;
      }
      const token = saved.data.updatedAt as unknown as string;
      const committed = await commitStockCountAction(count.id, { expectedUpdatedAt: token });
      if (committed.ok) onDone();
      else {
        setUpdatedAt(token);
        onError(actionError(committed.code));
      }
    });
  };

  const discard = () => {
    onError(null);
    startTransition(async () => {
      const result = await deleteStockCountAction(count.id, { expectedUpdatedAt: updatedAt });
      if (result.ok) onCancel();
      else onError(actionError(result.code));
    });
  };

  return (
    <Card className="flex flex-col gap-3 p-4">
      <h3 className="text-sm font-semibold text-foreground">{t('counts.title')}</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <th className="px-2 py-1.5">{t('columns.ingredient')}</th>
              <th className="px-2 py-1.5">{t('counts.system')}</th>
              <th className="px-2 py-1.5">{t('counts.counted')}</th>
            </tr>
          </thead>
          <tbody>
            {ingredients.map((i) => (
              <tr key={i.id} className="border-b border-border last:border-0">
                <td className="px-2 py-1.5 font-medium text-foreground">{i.name}</td>
                <td className="px-2 py-1.5 tabular-nums text-muted-foreground">
                  {formatQuantity(systemBalances[i.id] ?? 0, i.dimension, measurementSystem)}
                </td>
                <td className="px-2 py-1.5">
                  <Input
                    inputMode="decimal"
                    className="w-24"
                    value={counted[i.id] ?? ''}
                    disabled={pending}
                    onChange={(e) =>
                      setCounted((c) => ({ ...c, [i.id]: e.target.value }))
                    }
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => save()}>
          {t('counts.save')}
        </Button>
        <Button type="button" size="sm" disabled={pending} onClick={commit}>
          {t('counts.commit')}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={discard}>
          {t('counts.discard')}
        </Button>
      </div>
    </Card>
  );
}

// ── Small shared bits ────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      <span>{label}</span>
      {children}
    </label>
  );
}

function AreaSelect({
  areas,
  value,
  onChange,
  disabled,
}: {
  areas: Area[];
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('inventory');
  return (
    <Select
      className="w-40"
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      {areas.map((a) => (
        <option key={a.id} value={a.id}>
          {a.isDefault ? t('defaultAreaName') : a.name}
        </option>
      ))}
    </Select>
  );
}
