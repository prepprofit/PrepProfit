import { describe, expect, it } from 'vitest';
import { taskListProgress } from '@/lib/calculations/tasks';

describe('taskListProgress', () => {
  it('an empty list is 0/0 and NOT allDone', () => {
    expect(taskListProgress([])).toEqual({ done: 0, total: 0, allDone: false });
  });

  it('all-open', () => {
    expect(
      taskListProgress([{ status: 'open' }, { status: 'open' }]),
    ).toEqual({ done: 0, total: 2, allDone: false });
  });

  it('all-done is allDone', () => {
    expect(
      taskListProgress([{ status: 'done' }, { status: 'done' }]),
    ).toEqual({ done: 2, total: 2, allDone: true });
  });

  it('mixed', () => {
    expect(
      taskListProgress([
        { status: 'done' },
        { status: 'open' },
        { status: 'done' },
      ]),
    ).toEqual({ done: 2, total: 3, allDone: false });
  });
});
