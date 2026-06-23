'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  ArrowLeft,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import type { OrgMember } from '@/lib/auth';
import type { TaskListDetail as TaskListDetailData, TaskView } from '@/lib/data/tasks';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  addTaskAction,
  assignTaskAction,
  deleteTaskAction,
  deleteTaskListAction,
  duplicateTaskListAction,
  reorderTasksAction,
  resetTaskListAction,
  toggleTaskAction,
  updateTaskAction,
  updateTaskListAction,
} from '@/app/(app)/tasks/actions';
import { useActionError } from '@/lib/i18n/use-action-error';
import type { ActionErrorCode, ActionResult } from '@/lib/action-result';

/** A single task list with its tasks (Sprint 6). Money-free; RBAC-asymmetric. */
export function TaskListDetail({
  detail,
  canManage,
  members,
}: {
  detail: TaskListDetailData;
  canManage: boolean;
  members: OrgMember[];
}) {
  const t = useTranslations('tasks');
  const tCommon = useTranslations('common');
  const actionError = useActionError();
  const router = useRouter();

  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();
  const [editingHeader, setEditingHeader] = React.useState(false);
  const [editingTaskId, setEditingTaskId] = React.useState<string | null>(null);
  const [resetOpen, setResetOpen] = React.useState(false);
  const [deleteListOpen, setDeleteListOpen] = React.useState(false);
  const [deleteTaskTarget, setDeleteTaskTarget] = React.useState<TaskView | null>(null);

  const memberName = (id: string) =>
    members.find((m) => m.userId === id)?.name ?? id;

  const run = (fn: () => Promise<ActionResult<unknown>>, after?: () => void) => {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (result.ok) {
        after?.();
        router.refresh();
      } else {
        setError(actionError(result.code as ActionErrorCode));
      }
    });
  };

  const orderedIds = detail.tasks.map((task) => task.id);

  const move = (taskId: string, dir: -1 | 1) => {
    const idx = orderedIds.indexOf(taskId);
    const next = idx + dir;
    if (idx < 0 || next < 0 || next >= orderedIds.length) return;
    const reordered = [...orderedIds];
    const a = reordered[idx];
    const b = reordered[next];
    if (a === undefined || b === undefined) return;
    reordered[idx] = b;
    reordered[next] = a;
    run(() =>
      reorderTasksAction(detail.id, {
        expectedUpdatedAt: detail.updatedAt,
        orderedTaskIds: reordered,
      }),
    );
  };

  return (
    <div className="flex flex-col gap-5">
      <Link
        href="/tasks"
        className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        {t('back')}
      </Link>

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
        >
          {error}
        </div>
      )}

      {/* Header ------------------------------------------------------------ */}
      {editingHeader && canManage ? (
        <HeaderForm
          detail={detail}
          pending={pending}
          onCancel={() => setEditingHeader(false)}
          onSave={(fields) =>
            run(
              () =>
                updateTaskListAction(detail.id, {
                  expectedUpdatedAt: detail.updatedAt,
                  ...fields,
                }),
              () => setEditingHeader(false),
            )
          }
        />
      ) : (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h1 className="font-display text-2xl font-semibold text-foreground">
              {detail.name}
            </h1>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              {detail.scheduledFor && (
                <span className="inline-flex items-center gap-1">
                  <CalendarDays className="size-3.5" />
                  {detail.scheduledFor}
                </span>
              )}
              <span className="tabular-nums">
                {t('progress', {
                  done: detail.progress.done,
                  total: detail.progress.total,
                })}
              </span>
              {detail.notes && <span className="truncate">{detail.notes}</span>}
            </div>
          </div>

          {canManage && (
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() => setEditingHeader(true)}
              >
                <Pencil className="size-4" />
                {t('rename')}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() => setResetOpen(true)}
              >
                <RotateCcw className="size-4" />
                {t('reset')}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() =>
                  run(
                    () =>
                      duplicateTaskListAction(
                        detail.id,
                        `${detail.name} ${t('duplicateSuffix')}`,
                      ),
                    () => undefined,
                  )
                }
              >
                <Copy className="size-4" />
                {t('duplicate')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={t('deleteList')}
                disabled={pending}
                onClick={() => setDeleteListOpen(true)}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Task rows --------------------------------------------------------- */}
      <ul className="flex flex-col gap-2">
        {detail.tasks.map((task, index) => (
          <li key={task.id}>
            {editingTaskId === task.id ? (
              <TaskForm
                task={task}
                pending={pending}
                onCancel={() => setEditingTaskId(null)}
                onSave={(fields) =>
                  run(
                    () =>
                      updateTaskAction(task.id, {
                        expectedUpdatedAt: task.updatedAt,
                        ...fields,
                      }),
                    () => setEditingTaskId(null),
                  )
                }
              />
            ) : (
              <TaskRow
                task={task}
                index={index}
                total={detail.tasks.length}
                canManage={canManage}
                pending={pending}
                memberName={memberName}
                members={members}
                labels={{
                  markDone: t('markDone'),
                  markOpen: t('markOpen'),
                  moveUp: t('moveUp'),
                  moveDown: t('moveDown'),
                  edit: t('edit'),
                  deleteTask: t('deleteTask'),
                  unassigned: t('unassigned'),
                  assignee: t('assignee'),
                  prep: t('source.prep'),
                  reorder: t('source.reorder'),
                  dueOn: t('dueOn'),
                }}
                onToggle={() =>
                  run(() =>
                    toggleTaskAction(task.id, {
                      expectedUpdatedAt: task.updatedAt,
                      done: task.status !== 'done',
                    }),
                  )
                }
                onMove={(dir) => move(task.id, dir)}
                onEdit={() => setEditingTaskId(task.id)}
                onDelete={() => setDeleteTaskTarget(task)}
                onAssign={(value) =>
                  run(() =>
                    assignTaskAction(task.id, {
                      expectedUpdatedAt: task.updatedAt,
                      assigneeUserId: value === '' ? null : value,
                    }),
                  )
                }
              />
            )}
          </li>
        ))}
      </ul>

      {/* Inline add (both roles) ------------------------------------------ */}
      <AddTaskForm
        pending={pending}
        onAdd={(fields, reset) => run(() => addTaskAction(detail.id, fields), reset)}
      />

      {/* Dialogs ---------------------------------------------------------- */}
      <ConfirmDialog
        open={resetOpen}
        title={t('resetConfirm.title')}
        description={t('resetConfirm.body', { name: detail.name })}
        confirmLabel={t('reset')}
        cancelLabel={tCommon('cancel')}
        pending={pending}
        onConfirm={() => {
          setResetOpen(false);
          run(() =>
            resetTaskListAction(detail.id, { expectedUpdatedAt: detail.updatedAt }),
          );
        }}
        onCancel={() => setResetOpen(false)}
      />
      <ConfirmDialog
        open={deleteListOpen}
        title={t('deleteListConfirm.title')}
        description={t('deleteListConfirm.body', { name: detail.name })}
        confirmLabel={t('deleteList')}
        cancelLabel={tCommon('cancel')}
        destructive
        pending={pending}
        onConfirm={() => {
          setDeleteListOpen(false);
          run(
            () =>
              deleteTaskListAction(detail.id, {
                expectedUpdatedAt: detail.updatedAt,
              }),
            () => router.push('/tasks'),
          );
        }}
        onCancel={() => setDeleteListOpen(false)}
      />
      <ConfirmDialog
        open={deleteTaskTarget !== null}
        title={t('deleteTaskConfirm.title')}
        description={t('deleteTaskConfirm.body', {
          name: deleteTaskTarget?.title ?? '',
        })}
        confirmLabel={t('deleteTask')}
        cancelLabel={tCommon('cancel')}
        destructive
        pending={pending}
        onConfirm={() => {
          const target = deleteTaskTarget;
          if (!target) return;
          setDeleteTaskTarget(null);
          run(() =>
            deleteTaskAction(target.id, { expectedUpdatedAt: target.updatedAt }),
          );
        }}
        onCancel={() => setDeleteTaskTarget(null)}
      />
    </div>
  );
}

type RowLabels = {
  markDone: string;
  markOpen: string;
  moveUp: string;
  moveDown: string;
  edit: string;
  deleteTask: string;
  unassigned: string;
  assignee: string;
  prep: string;
  reorder: string;
  dueOn: string;
};

function TaskRow({
  task,
  index,
  total,
  canManage,
  pending,
  memberName,
  members,
  labels,
  onToggle,
  onMove,
  onEdit,
  onDelete,
  onAssign,
}: {
  task: TaskView;
  index: number;
  total: number;
  canManage: boolean;
  pending: boolean;
  memberName: (id: string) => string;
  members: OrgMember[];
  labels: RowLabels;
  onToggle: () => void;
  onMove: (dir: -1 | 1) => void;
  onEdit: () => void;
  onDelete: () => void;
  onAssign: (value: string) => void;
}) {
  const done = task.status === 'done';
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface p-3">
      <button
        type="button"
        role="checkbox"
        aria-checked={done}
        aria-label={done ? labels.markOpen : labels.markDone}
        disabled={pending}
        onClick={onToggle}
        className={
          done
            ? 'flex size-6 shrink-0 items-center justify-center rounded-md border border-emerald-600 bg-emerald-600 text-white'
            : 'flex size-6 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-transparent hover:border-accent-400'
        }
      >
        <Check className="size-4" />
      </button>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span
          className={
            done
              ? 'truncate text-sm text-muted-foreground line-through'
              : 'truncate text-sm font-medium text-foreground'
          }
        >
          {task.title}
        </span>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          {task.sourceKind === 'prep' && <Badge variant="accent">{labels.prep}</Badge>}
          {task.sourceKind === 'reorder' && (
            <Badge variant="accent">{labels.reorder}</Badge>
          )}
          {task.station && <Badge variant="neutral">{task.station}</Badge>}
          {task.dueOn && (
            <span className="inline-flex items-center gap-1">
              <CalendarDays className="size-3" />
              {task.dueOn}
            </span>
          )}
          {task.assigneeUserId && !canManage && (
            <span>{memberName(task.assigneeUserId)}</span>
          )}
        </div>
      </div>

      {canManage && (
        <label className="sr-only" htmlFor={`assignee-${task.id}`}>
          {labels.assignee}
        </label>
      )}
      {canManage && (
        <Select
          id={`assignee-${task.id}`}
          className="h-8 w-40"
          value={task.assigneeUserId ?? ''}
          disabled={pending}
          onChange={(e) => onAssign(e.target.value)}
        >
          <option value="">{labels.unassigned}</option>
          {members.map((m) => (
            <option key={m.userId} value={m.userId}>
              {m.name}
            </option>
          ))}
        </Select>
      )}

      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={labels.moveUp}
          disabled={pending || index === 0}
          onClick={() => onMove(-1)}
        >
          <ChevronUp className="size-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={labels.moveDown}
          disabled={pending || index === total - 1}
          onClick={() => onMove(1)}
        >
          <ChevronDown className="size-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={labels.edit}
          disabled={pending}
          onClick={onEdit}
        >
          <Pencil className="size-4" />
        </Button>
        {canManage && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={labels.deleteTask}
            disabled={pending}
            onClick={onDelete}
          >
            <Trash2 className="size-4" />
          </Button>
        )}
      </div>
    </div>
  );
}

type TaskFields = {
  title: string;
  notes: string | null;
  station: string | null;
  dueOn: string | null;
};

function TaskForm({
  task,
  pending,
  onCancel,
  onSave,
}: {
  task: TaskView;
  pending: boolean;
  onCancel: () => void;
  onSave: (fields: TaskFields) => void;
}) {
  const t = useTranslations('tasks');
  const tCommon = useTranslations('common');
  const [title, setTitle] = React.useState(task.title);
  const [station, setStation] = React.useState(task.station ?? '');
  const [dueOn, setDueOn] = React.useState(task.dueOn ?? '');
  const [notes, setNotes] = React.useState(task.notes ?? '');

  return (
    <Card>
      <CardContent className="p-4">
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (title.trim() === '') return;
            onSave({
              title,
              station: station.trim() === '' ? null : station,
              dueOn: dueOn === '' ? null : dueOn,
              notes: notes.trim() === '' ? null : notes,
            });
          }}
        >
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            required
            autoFocus
          />
          <div className="flex flex-wrap gap-3">
            <Input
              value={station}
              onChange={(e) => setStation(e.target.value)}
              placeholder={t('stationPlaceholder')}
              maxLength={60}
              className="flex-1"
            />
            <Input
              type="date"
              value={dueOn}
              onChange={(e) => setDueOn(e.target.value)}
            />
          </div>
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={t('notesPlaceholder')}
            maxLength={1000}
            rows={2}
          />
          <div className="flex items-center gap-2">
            <Button type="submit" disabled={pending || title.trim() === ''}>
              {t('save')}
            </Button>
            <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>
              {tCommon('cancel')}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function AddTaskForm({
  pending,
  onAdd,
}: {
  pending: boolean;
  onAdd: (fields: TaskFields, reset: () => void) => void;
}) {
  const t = useTranslations('tasks');
  const [title, setTitle] = React.useState('');
  const [station, setStation] = React.useState('');
  const [dueOn, setDueOn] = React.useState('');

  const reset = () => {
    setTitle('');
    setStation('');
    setDueOn('');
  };

  return (
    <form
      className="flex flex-wrap items-end gap-3 rounded-xl border border-dashed border-border bg-surface p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim() === '') return;
        onAdd(
          {
            title,
            station: station.trim() === '' ? null : station,
            dueOn: dueOn === '' ? null : dueOn,
            notes: null,
          },
          reset,
        );
      }}
    >
      <label className="flex flex-1 flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">
          {t('taskTitle')}
        </span>
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t('taskTitlePlaceholder')}
          maxLength={200}
          required
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">
          {t('station')}
        </span>
        <Input
          value={station}
          onChange={(e) => setStation(e.target.value)}
          placeholder={t('stationPlaceholder')}
          maxLength={60}
          className="w-32"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">{t('dueOn')}</span>
        <Input type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} />
      </label>
      <Button type="submit" disabled={pending || title.trim() === ''}>
        <Plus className="size-4" />
        {t('addTask')}
      </Button>
    </form>
  );
}

function HeaderForm({
  detail,
  pending,
  onCancel,
  onSave,
}: {
  detail: TaskListDetailData;
  pending: boolean;
  onCancel: () => void;
  onSave: (fields: {
    name: string;
    notes: string | null;
    scheduledFor: string | null;
  }) => void;
}) {
  const t = useTranslations('tasks');
  const tCommon = useTranslations('common');
  const [name, setName] = React.useState(detail.name);
  const [scheduledFor, setScheduledFor] = React.useState(detail.scheduledFor ?? '');
  const [notes, setNotes] = React.useState(detail.notes ?? '');

  return (
    <Card>
      <CardContent className="p-4">
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim() === '') return;
            onSave({
              name,
              scheduledFor: scheduledFor === '' ? null : scheduledFor,
              notes: notes.trim() === '' ? null : notes,
            });
          }}
        >
          <div className="flex flex-wrap gap-3">
            <label className="flex flex-1 flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">
                {t('listName')}
              </span>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={200}
                required
                autoFocus
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">
                {t('date')}
              </span>
              <Input
                type="date"
                value={scheduledFor}
                onChange={(e) => setScheduledFor(e.target.value)}
              />
            </label>
          </div>
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={t('notesPlaceholder')}
            maxLength={1000}
            rows={2}
          />
          <div className="flex items-center gap-2">
            <Button type="submit" disabled={pending || name.trim() === ''}>
              {t('save')}
            </Button>
            <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>
              {tCommon('cancel')}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
