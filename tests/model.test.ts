// Run: bun test
import { describe, expect, test } from 'bun:test';

import { TODOS_PATH, VISIBLE_ITEMS, groupTodos, parseTodosFile, planVisible, todosForSession, visibleSlice, type FoldChoice, type Todo } from '../shared/model.ts';

const file = {
  ses_lead: [
    { content: 'done thing', status: 'completed', priority: 'high' },
    { content: ' current\n thing ', status: 'in_progress' },
    { content: 'later thing', status: 'pending' },
    { content: 'dropped', status: 'cancelled' },
    { content: 'odd status', status: 'blocked' },
    { content: '   ' },
    { nope: true },
    null,
  ],
  ses_sub: [{ content: 'subagent only', status: 'pending' }],
  ses_wrapped: { todos: [{ content: 'wrapped shape', status: 'pending' }] },
};

describe('the adapter store', () => {
  test('lives where the adapter writes it', () => {
    expect(TODOS_PATH).toBe('.omo/v2-state/todos.json');
  });

  test('a half-written or non-object file reads as "try again", never as empty', () => {
    expect(parseTodosFile('{"ses_lead":[{"content":"a"')).toBeNull();
    expect(parseTodosFile('[]')).toBeNull();
    expect(parseTodosFile('')).toBeNull();
    expect(parseTodosFile('﻿{"a":[]}')).toEqual({ a: [] });
  });
});

describe('one session, one list', () => {
  test('only the asked session comes back, cleaned and in the agent order', () => {
    expect(todosForSession(file, 'ses_lead')).toEqual([
      { content: 'done thing', status: 'completed', priority: 'high' },
      { content: 'current thing', status: 'in_progress' },
      { content: 'later thing', status: 'pending' },
      { content: 'dropped', status: 'cancelled' },
      { content: 'odd status', status: 'pending' },
    ]);
    expect(todosForSession(file, 'ses_sub')).toEqual([{ content: 'subagent only', status: 'pending' }]);
  });

  test('a session with no entry has no list, whatever else the file holds', () => {
    expect(todosForSession(file, 'ses_other')).toEqual([]);
    expect(todosForSession(file, 'constructor')).toEqual([]);
    expect(todosForSession(null, 'ses_lead')).toEqual([]);
  });

  test('both stored shapes are read', () => {
    expect(todosForSession(file, 'ses_wrapped')).toEqual([{ content: 'wrapped shape', status: 'pending' }]);
  });
});

describe('a long list stays readable', () => {
  test('grouped by status with counts', () => {
    const groups = groupTodos(todosForSession(file, 'ses_lead'));
    expect(groups.active.map((todo) => todo.content)).toEqual(['current thing']);
    expect(groups.pending.map((todo) => todo.content)).toEqual(['later thing', 'odd status']);
    expect(groups.completed.length).toBe(1);
    expect(groups.cancelled.length).toBe(1);
    expect([groups.done, groups.total]).toEqual([2, 5]);
  });

  test('hundreds of items render a capped slice until asked for the rest', () => {
    const many = Array.from({ length: 300 }, (_, index) => ({ content: `task ${index}`, status: 'pending' as const }));
    expect(visibleSlice(many, 6, false)).toEqual({ shown: many.slice(0, 6), hidden: 294 });
    expect(visibleSlice(many, 6, true).shown.length).toBe(300);
    expect(visibleSlice(many.slice(0, 6), 6, false).hidden).toBe(0);
  });
});

describe('ten todos show without a click', () => {
  const auto: FoldChoice = { pending: null, pendingAll: false, completed: null, completedAll: false, cancelled: null, cancelledAll: false };
  const make = (count: number, status: Todo['status']): Todo[] => Array.from({ length: count }, (_, index) => ({ content: `${status} ${index}`, status }));
  const plan = (active: number, pending: number, completed: number, cancelled: number, choice = auto) => (
    planVisible(groupTodos([...make(active, 'in_progress'), ...make(pending, 'pending'), ...make(completed, 'completed'), ...make(cancelled, 'cancelled')]), choice)
  );
  const shown = (p: ReturnType<typeof plan>) => p.active.length + p.pending.shown.length + p.completed.shown.length + p.cancelled.shown.length;

  test('the budget is ten', () => {
    expect(VISIBLE_ITEMS).toBe(10);
  });

  test('a list of ten or fewer is shown whole, finished items included', () => {
    const five = plan(0, 0, 5, 0);
    expect([five.completed.shown.length, five.completed.hidden, five.completed.open]).toEqual([5, 0, true]);
    const ten = plan(1, 5, 3, 1);
    expect(shown(ten)).toBe(10);
    expect([ten.pending.hidden, ten.completed.hidden, ten.cancelled.hidden]).toEqual([0, 0, 0]);
  });

  test('a longer list shows ten, most urgent first, and counts the rest', () => {
    const twelve = plan(1, 8, 3, 0);
    expect([twelve.pending.shown.length, twelve.completed.shown.length, twelve.completed.hidden]).toEqual([8, 1, 2]);
    expect(shown(twelve)).toBe(10);
    const huge = plan(2, 120, 170, 8);
    expect([huge.pending.shown.length, huge.pending.hidden]).toEqual([8, 112]);
    expect([huge.completed.shown.length, huge.completed.open, huge.cancelled.open]).toEqual([0, false, false]);
    expect(shown(huge)).toBe(10);
  });

  test('items in progress are never cut, even past ten', () => {
    const busy = plan(12, 4, 0, 0);
    expect([busy.active.length, busy.pending.shown.length, busy.pending.hidden]).toEqual([12, 0, 4]);
  });

  test('a group the user folded or opened keeps that choice', () => {
    expect(plan(0, 0, 5, 0, { ...auto, completed: false }).completed).toEqual({ shown: [], hidden: 5, open: false });
    const opened = plan(2, 120, 170, 8, { ...auto, completed: true });
    expect([opened.completed.shown.length, opened.completed.hidden]).toEqual([30, 140]);
    expect(plan(2, 120, 170, 8, { ...auto, completed: true, completedAll: true }).completed.hidden).toBe(0);
    expect(plan(0, 40, 0, 0, { ...auto, pending: true, pendingAll: true }).pending.shown.length).toBe(40);
  });

  test('Next folds exactly like Completed', () => {
    expect(plan(0, 5, 0, 0, { ...auto, pending: false }).pending).toEqual({ shown: [], hidden: 5, open: false });
    // A folded Next hands its rows to the groups after it.
    const folded = plan(1, 8, 3, 0, { ...auto, pending: false });
    expect([folded.pending.shown.length, folded.completed.shown.length, folded.completed.open]).toEqual([0, 3, true]);
    const opened = plan(0, 40, 0, 0, { ...auto, pending: true });
    expect([opened.pending.shown.length, opened.pending.hidden, opened.pending.open]).toEqual([30, 10, true]);
    // With the budget spent on items in progress, Next starts folded.
    expect(plan(12, 4, 0, 0).pending).toEqual({ shown: [], hidden: 4, open: false });
  });
});
