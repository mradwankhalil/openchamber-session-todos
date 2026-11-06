import { describe, expect, test } from 'bun:test';

import {
  appendRevision,
  repairRevisions,
  applyMarks,
  buildTree,
  countViews,
  descendants,
  droppedItems,
  filterViews,
  pruneTree,
  subagentSections,
  subagentsFor,
  findRefs,
  itemHistory,
  itemKey,
  liveFamilies,
  looseSession,
  mixedPriorities,
  parseTodosFile,
  pathProjectId,
  projectForFolder,
  pruneMarks,
  quietNotice,
  resolveDepth,
  sessionState,
  editsFile,
  planSessionId,
  readBacklog,
  planSteps,
  readPlan,
  readsOwnFile,
  splitTag,
  toMarkdown,
  todosForSession,
  EMPTY_MARKS,
  type Revision,
  type Todo,
} from '../shared/model.ts';

const t = (content: string, status: Todo['status'] = 'pending', priority?: string): Todo => ({ content, status, ...(priority ? { priority } : {}) });

describe('todosForSession', () => {
  test('keeps priority and id when the agent sent them', () => {
    const todos = todosForSession({ a: [{ content: 'x', status: 'pending', priority: 'high', id: '7' }] }, 'a');
    expect(todos).toEqual([{ content: 'x', status: 'pending', priority: 'high', id: '7' }]);
  });

  test('a half-written file reads as null, so the caller keeps what it shows', () => {
    expect(parseTodosFile('{"a":[{"content":"x"')).toBeNull();
  });
});

describe('splitTag', () => {
  test('splits an agent prefix from the title', () => {
    expect(splitTag('NEXT-COORD | Confirm the pin')).toEqual({ tag: 'NEXT-COORD', title: 'Confirm the pin' });
    expect(splitTag('GUARD_1: run tests')).toEqual({ tag: 'GUARD_1', title: 'run tests' });
  });

  test('leaves ordinary text alone', () => {
    expect(splitTag('Fix: the login page')).toEqual({ tag: null, title: 'Fix: the login page' });
    expect(splitTag('Update README')).toEqual({ tag: null, title: 'Update README' });
    expect(splitTag('A | b')).toEqual({ tag: null, title: 'A | b' });
  });
});

describe('findRefs', () => {
  test('finds session ids, once each', () => {
    expect(findRefs('see ses_e70abc and ses_e70abc, ses_123456')).toEqual(['ses_e70abc', 'ses_123456']);
    expect(findRefs('no session here')).toEqual([]);
  });
});

describe('mixedPriorities', () => {
  test('is false when every item has the same priority', () => {
    expect(mixedPriorities([t('a', 'pending', 'high'), t('b', 'pending', 'high')])).toBe(false);
    expect(mixedPriorities([t('a'), t('b')])).toBe(false);
  });
  test('is true when priorities differ', () => {
    expect(mixedPriorities([t('a', 'pending', 'high'), t('b', 'pending', 'low')])).toBe(true);
    expect(mixedPriorities([t('a', 'pending', 'high'), t('b')])).toBe(true);
  });
});

describe('marks', () => {
  const list = [t('open one'), t('working', 'in_progress'), t('finished', 'completed')];
  const marks = { ticks: { [itemKey('open one')]: 1, [itemKey('working')]: 2, [itemKey('finished')]: 3, [itemKey('gone')]: 4 }, notes: { [itemKey('open one')]: 'n', [itemKey('gone')]: 'old' } };

  test('an open item you ticked is yours, not the agent\'s', () => {
    const views = applyMarks(list, marks, true);
    expect(views[0]?.mine).toBe(true);
    expect(views[0]?.status).toBe('pending');
    expect(views[0]?.note).toBe('n');
    expect(views[2]?.mine).toBe(false);
  });

  test('switched off means no marks anywhere, and nothing is deleted', () => {
    const views = applyMarks(list, marks, false);
    expect(views.every((view) => !view.mine)).toBe(true);
    expect(views[0]?.note).toBe('');
    expect(Object.keys(marks.ticks)).toHaveLength(4);
  });

  test('counts never claim the agent finished what you ticked', () => {
    expect(countViews(applyMarks(list, marks, true))).toEqual({ total: 3, done: 1, cancelled: 0, mine: 2, active: 0, open: 0 });
    expect(countViews(applyMarks(list, EMPTY_MARKS, true))).toEqual({ total: 3, done: 1, cancelled: 0, mine: 0, active: 1, open: 1 });
  });

  test('a cancelled item counts as finished and is also counted apart, for the bar', () => {
    const dropped = list.map((item) => ({ ...item, status: 'cancelled' as const }));
    expect(countViews(applyMarks(dropped, EMPTY_MARKS, true))).toEqual({ total: 3, done: 3, cancelled: 3, mine: 0, active: 0, open: 0 });
  });

  test('a tick clears when the agent finished the item or dropped it', () => {
    const next = pruneMarks(marks, list);
    expect(Object.keys(next.ticks).sort()).toEqual([itemKey('open one'), itemKey('working')].sort());
    expect(next.notes[itemKey('gone')]).toBeUndefined();
  });

  test('an empty read never prunes, so a settle-window miss cannot delete ticks', () => {
    expect(pruneMarks(marks, [])).toBe(marks);
  });
});

describe('filterViews', () => {
  const views = applyMarks([t('alpha'), t('beta', 'completed'), t('gamma')], { ticks: { [itemKey('gamma')]: 1 }, notes: {} }, true);
  test('open excludes what you ticked; done includes it', () => {
    expect(filterViews(views, 'open', '').map((v) => v.content)).toEqual(['alpha']);
    expect(filterViews(views, 'done', '').map((v) => v.content)).toEqual(['beta', 'gamma']);
    expect(filterViews(views, 'all', '')).toHaveLength(3);
  });
  test('text matches case-insensitively', () => {
    expect(filterViews(views, 'all', 'BET').map((v) => v.content)).toEqual(['beta']);
  });
});

describe('toMarkdown', () => {
  test('renders marks and groups, and labels each list', () => {
    const views = applyMarks([t('a', 'in_progress'), t('b'), t('c', 'completed'), t('d', 'cancelled')], { ticks: { [itemKey('b')]: 1 }, notes: {} }, true);
    const text = toMarkdown('My session', views, [{ title: 'Child', todos: applyMarks([t('e')], EMPTY_MARKS, true) }]);
    expect(text).toContain('## My session (3/4)');
    expect(text).toContain('- [ ] a *(in progress)*');
    expect(text).toContain('- [x] b *(done by you)*');
    expect(text).toContain('- [x] c');
    expect(text).toContain('- [ ] ~~d~~ *(cancelled)*');
    expect(text).toContain('### Child (0/1)');
  });
});

describe('revisions', () => {
  const at = (minutes: number): number => minutes * 60_000;
  const build = (): Revision[] => {
    let revs: Revision[] = [];
    revs = appendRevision(revs, [t('a'), t('b')], at(0), 'omo');
    revs = appendRevision(revs, [t('a', 'in_progress'), t('b')], at(10), 'omo');
    revs = appendRevision(revs, [t('a', 'completed')], at(25), 'omo');
    return revs;
  };

  test('only a real change adds a revision', () => {
    const revs = build();
    expect(appendRevision(revs, [t('a', 'completed')], at(30), 'omo')).toBe(revs);
    expect(revs).toHaveLength(3);
  });

  test('a new list is kept whatever its time: a revert, a clock change, a shared file time', () => {
    const revs = build();
    expect(appendRevision(revs, [t('a'), t('b')], at(5), 'OpenCode session')).toHaveLength(4);
    expect(appendRevision(revs, [t('c')], at(-1), 'omo')).toHaveLength(4);
  });

  test('a stored history loses older copies its source flagged, and the repeats they split', () => {
    const good = build();
    const [first, second, third] = good;
    if (!first || !second || !third) throw new Error('build gives three');
    const stored = [first, second, { ...first, source: 'OpenCode session, an older version' }, { ...second, at: at(12) }, third];
    expect(repairRevisions(stored)).toEqual(good);
    expect(repairRevisions(good)).toBe(good);
  });

  test('repair never drops a list kept nowhere else, nor decides by time', () => {
    const good = build();
    const [first, second, third] = good;
    if (!first || !second || !third) throw new Error('build gives three');
    const oldList = { at: at(-9000), source: 'old list', todos: [t('legacy')] };
    const flaggedOnly = { at: at(1), source: 'database, an older version', todos: [t('seen once')] };
    const future = { ...second, at: at(10 ** 9) };
    const stored = [first, oldList, future, flaggedOnly, third];
    expect(repairRevisions(stored)).toBe(stored);
  });

  test('keeps at most the cap, dropping the oldest', () => {
    let revs: Revision[] = [];
    for (let i = 0; i < 8; i += 1) revs = appendRevision(revs, [t(`item ${i}`)], at(i), 'omo', 5);
    expect(revs).toHaveLength(5);
    expect(revs[0]?.todos[0]?.content).toBe('item 3');
  });

  test('item history measures time in progress', () => {
    const history = itemHistory(build(), 'a');
    expect(history.events.map((event) => event.what)).toEqual(['added', 'started', 'finished']);
    expect(history.inProgressMs).toBe(at(15));
  });

  test('an item still in progress counts up to now', () => {
    const revs = appendRevision(appendRevision([], [t('a')], at(0), 'omo'), [t('a', 'in_progress')], at(5), 'omo');
    expect(itemHistory(revs, 'a', at(9)).inProgressMs).toBe(at(4));
  });

  test('an open item that left the list is dropped; a finished one is not', () => {
    const dropped = droppedItems(build(), [t('a', 'completed')]);
    expect(dropped.map((item) => item.content)).toEqual(['b']);
    expect(dropped[0]?.goneAt).toBe(at(25));
  });

  test('a dropped item that comes back is no longer dropped', () => {
    const revs = appendRevision(build(), [t('a', 'completed'), t('b')], at(30), 'omo');
    expect(droppedItems(revs, [t('a', 'completed'), t('b')])).toEqual([]);
  });
});

describe('sessions outside the project list', () => {
  test('busy after idle is running; otherwise idle', () => {
    expect(sessionState({ time: { busy: 20, idle: 10, updated: 30 } })).toEqual({ activity: 'running', updatedAt: 30 });
    expect(sessionState({ time: { busy: 10, idle: 20, updated: 30 } })).toEqual({ activity: 'idle', updatedAt: 30 });
    expect(sessionState({ time: { busy: 10 } })?.activity).toBe('running');
    expect(sessionState({ time: {} })?.activity).toBe('idle');
    expect(sessionState(null)).toBeNull();
  });
  test('reads a list entry as a record', () => {
    const record = looseSession({ id: 'ses_a', title: 'Chat', parentID: 'ses_p', location: { directory: '/d' }, time: { created: 1, updated: 2, archived: 3 } });
    expect(record).toMatchObject({ id: 'ses_a', title: 'Chat', directory: '/d', parentId: 'ses_p', createdAt: 1, updatedAt: 2, archivedAt: 3, activity: 'idle' });
    expect(looseSession({ id: 'ses_b' })?.title).toBe('ses_b');
    expect(looseSession({ title: 'no id' })).toBeNull();
  });
  test('a folder id matches the form OpenChamber uses', () => {
    expect(pathProjectId('C:\\Users\\x')).toBe('path_QzovVXNlcnMveA');
  });
});

describe('liveFamilies', () => {
  const s = (id: string, updatedAt: number, parentId: string | null = null, archivedAt: number | null = null) => ({ id, updatedAt, parentId, archivedAt });
  const ids = (items: { id: string }[]): string[] => items.map((item) => item.id);
  test('an old parent and old siblings stay with a live child', () => {
    expect(ids(liveFamilies([s('root', 1), s('kid', 100, 'root'), s('old', 2, 'root'), s('deep', 3, 'old'), s('gone', 4)], 50))).toEqual(['root', 'kid', 'old', 'deep']);
  });
  test('archived sessions stay out, and do not bring a family in', () => {
    expect(ids(liveFamilies([s('a', 100, null, 5), s('b', 100, 'a', null), s('c', 100, null, 9)], 50))).toEqual(['b']);
  });
  test('a loop ends', () => {
    expect(ids(liveFamilies([s('p', 100, 'q'), s('q', 100, 'p')], 50))).toEqual(['p', 'q']);
  });
});

describe('projectForFolder', () => {
  const projects = [{ id: 'a', directory: 'C:\\work\\app' }, { id: 'b', directory: 'C:/work/app/inner/' }, { id: 'c', directory: '' }];
  test('the deepest match wins, whatever the slashes or case', () => {
    expect(projectForFolder('c:/work/APP', projects)?.id).toBe('a');
    expect(projectForFolder('C:\\work\\app\\inner\\x', projects)?.id).toBe('b');
  });
  test('a name that only starts the same is not a match', () => {
    expect(projectForFolder('C:/work/app2', projects)).toBeUndefined();
  });
});

describe('subagentsFor', () => {
  const views = (...todos: Todo[]) => applyMarks(todos, { ticks: {}, notes: {} }, false);
  const child = (id: string, depth: number, ...todos: Todo[]) => ({ id, depth, todos: views(...todos) });
  const names = (list: { content: string }[]) => list.map((item) => item.content);
  const mixed = child('mixed', 1, t('finished', 'completed'), t('working', 'in_progress'), t('next'), t('dropped', 'cancelled'));

  test('one subagent of each state shows in Open and in Done, with only its own part', () => {
    const [open] = subagentsFor([mixed], 'open');
    expect(names(open?.shown ?? [])).toEqual(['working', 'next']);
    expect(names(open?.tucked ?? [])).toEqual(['dropped']);
    const [done] = subagentsFor([mixed], 'done');
    expect(names(done?.shown ?? [])).toEqual(['finished']);
    expect(done?.tucked).toEqual([]);
  });
  test('a finished subagent leaves Open and shows in Done', () => {
    const finished = child('finished', 1, t('a', 'completed'));
    expect(subagentsFor([finished], 'open')).toEqual([]);
    expect(subagentsFor([finished], 'done').map((row) => row.id)).toEqual(['finished']);
  });
  test('one with nothing open or finished is in neither, but stays in All', () => {
    const cancelled = child('cancelled', 1, t('a', 'cancelled'));
    expect(subagentsFor([cancelled], 'open')).toEqual([]);
    expect(subagentsFor([cancelled], 'done')).toEqual([]);
    expect(names(subagentsFor([cancelled], 'all')[0]?.shown ?? [])).toEqual(['a']);
  });
  test('a parent with no match stays empty to lead to a child that has one', () => {
    const rows = subagentsFor([child('parent', 1, t('a', 'completed')), child('kid', 2, t('b')), child('other', 1, t('c', 'completed'))], 'open');
    expect(rows.map((row) => [row.id, row.shown.length])).toEqual([['parent', 0], ['kid', 1]]);
  });
});

describe('subagentSections', () => {
  const row = (id: string, depth: number, activity: string, updatedAt: number) => ({ id, depth, activity, updatedAt });
  const ids = (rows: { id: string }[]) => rows.map((item) => item.id);

  test('splits working from idle, the most recent first', () => {
    const { active, idle } = subagentSections([row('old idle', 1, 'idle', 1), row('old run', 1, 'running', 2), row('new idle', 1, 'idle', 3), row('new run', 1, 'running', 4)]);
    expect(ids(active)).toEqual(['new run', 'old run']);
    expect(ids(idle)).toEqual(['new idle', 'old idle']);
  });
  test('retrying and waiting on you count as active; unknown does not', () => {
    const { active, idle } = subagentSections([row('r', 1, 'retrying', 1), row('p', 1, 'waiting-permission', 2), row('q', 1, 'waiting-question', 3), row('u', 1, 'unknown', 4)]);
    expect(ids(active)).toEqual(['q', 'p', 'r']);
    expect(ids(idle)).toEqual(['u']);
  });
  test('a subagent stays under its parent, which takes its state and time', () => {
    const { active, idle } = subagentSections([row('parent', 1, 'idle', 1), row('kid idle', 2, 'idle', 2), row('kid run', 2, 'running', 9), row('other', 1, 'running', 5), row('quiet', 1, 'idle', 3)]);
    expect(ids(active)).toEqual(['parent', 'kid run', 'kid idle', 'other']);
    expect(ids(idle)).toEqual(['quiet']);
  });
});

describe('filterViews and cancelled items', () => {
  const views = applyMarks([t('a'), t('b', 'cancelled'), t('c', 'completed')], { ticks: {}, notes: {} }, false);
  test('cancelled sits with Open, not Done', () => {
    expect(filterViews(views, 'open', '').map((v) => v.content)).toEqual(['a', 'b']);
    expect(filterViews(views, 'done', '').map((v) => v.content)).toEqual(['c']);
  });
});

describe('pruneTree', () => {
  const n = (item: string, ...children: { item: string; children: never[] }[]) => ({ item, children });
  test('drops what fails, but keeps what leads to something kept', () => {
    const tree = [n('keep'), n('drop'), { item: 'lead', children: [n('keep below')] }];
    const kept = pruneTree(tree as never, (item: string) => item.startsWith('keep')) as unknown as { item: string; children: { item: string }[] }[];
    expect(kept.map((node) => node.item)).toEqual(['keep', 'lead']);
    expect(kept[1]?.children.map((node) => node.item)).toEqual(['keep below']);
  });
});

describe('buildTree', () => {
  const s = (id: string, parentId: string | null = null) => ({ id, parentId });
  const shape = (nodes: ReturnType<typeof buildTree<{ id: string; parentId: string | null }>>): unknown[] => nodes.map((node) => [node.item.id, shape(node.children)]);
  const items = [s('root'), s('a', 'root'), s('b', 'root'), s('a1', 'a'), s('a11', 'a1'), s('orphan', 'not here')];
  test('nests under top-level items, keeping the order given', () => {
    expect(shape(buildTree(items, 4))).toEqual([['root', [['a', [['a1', [['a11', []]]]]], ['b', []]]], ['orphan', []]]);
  });
  test('stops at the depth asked for', () => {
    expect(shape(buildTree(items, 1))).toEqual([['root', [['a', []], ['b', []]]], ['orphan', []]]);
    expect(shape(buildTree(items, 0))).toEqual([['root', []], ['orphan', []]]);
  });
  test('its own parent counts as top-level, and a loop ends', () => {
    expect(shape(buildTree([s('x', 'x')], 4))).toEqual([['x', []]]);
    expect(shape(buildTree([s('r'), s('y', 'r'), s('r2', 'y')], 9))).toEqual([['r', [['y', [['r2', []]]]]]]);
    expect(buildTree([s('p', 'q'), s('q', 'p')], 4)).toEqual([]);
  });
});

describe('resolveDepth', () => {
  test('follows the config, within bounds', () => {
    expect(resolveDepth('auto', 2)).toBe(2);
    expect(resolveDepth('auto', 9)).toBe(4);
    expect(resolveDepth('auto', 0)).toBe(1);
    expect(resolveDepth('auto', null)).toBe(1);
  });
  test('the user\'s choice wins, including none', () => {
    expect(resolveDepth(0, 3)).toBe(0);
    expect(resolveDepth(4, 1)).toBe(4);
  });
});

describe('descendants', () => {
  const parents = { a: 'root', b: 'root', a1: 'a', a11: 'a1', a111: 'a11', a1111: 'a111', other: 'elsewhere' };
  test('goes as deep as asked, parents first', () => {
    expect(descendants('root', parents, 1).map((item) => item.id)).toEqual(['a', 'b']);
    expect(descendants('root', parents, 2)).toEqual([{ id: 'a', depth: 1 }, { id: 'a1', depth: 2 }, { id: 'b', depth: 1 }]);
    expect(descendants('root', parents, 4).map((item) => item.id)).toEqual(['a', 'a1', 'a11', 'a111', 'b']);
  });
  test('none means none', () => {
    expect(descendants('root', parents, 0)).toEqual([]);
  });
  test('a loop in the data ends', () => {
    expect(descendants('x', { y: 'x', x: 'y' }, 4)).toEqual([{ id: 'y', depth: 1 }]);
  });
  test('the cap holds on a wide tree', () => {
    const wide = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`c${index}`, 'root']));
    expect(descendants('root', wide, 1, 60)).toHaveLength(60);
  });
  test('ignores entries that are not ids', () => {
    expect(descendants('root', { a: 3, b: 'root' }, 1)).toEqual([{ id: 'b', depth: 1 }]);
  });
});

describe('readBacklog', () => {
  test('reads the store, tolerating field names', () => {
    expect(readBacklog({ version: 2, todos: [{ id: 'a', text: ' buy  milk ', completed: true }, { id: 'b', body: 'two' }] })).toEqual([
      { id: 'a', text: 'buy milk', done: true },
      { id: 'b', text: 'two', done: false },
    ]);
  });
  test('anything else is an empty backlog', () => {
    expect(readBacklog(null)).toEqual([]);
    expect(readBacklog({ todos: 'x' })).toEqual([]);
    expect(readBacklog({ todos: [{ id: 'a' }, 3] })).toEqual([]);
  });
});

describe('the plan a session works on', () => {
  const message = (name: string, input: unknown) => JSON.stringify({ content: [{ type: 'text', text: 'x' }, { type: 'tool', name, state: { input } }] });
  test('a writing tool that names the file edits it; reading it does not', () => {
    expect(editsFile(message('edit', { filePath: 'C:\\p\\docs\\plans\\plan.md' }), 'plan.md')).toBe(true);
    expect(editsFile(message('apply_patch', { patchText: '*** Update File: docs/plans/plan.md' }), 'plan.md')).toBe(true);
    expect(editsFile(message('read', { filePath: 'docs/plans/plan.md' }), 'plan.md')).toBe(false);
    expect(editsFile(message('edit', { filePath: 'docs/plans/plan.md.bak' }), 'plan.md')).toBe(false);
    expect(editsFile(message('edit', { filePath: 'docs/plans/myplan.md' }), 'plan.md')).toBe(false);
    expect(editsFile('not json', 'plan.md')).toBe(false);
  });
  test('the linked session reads from a string or a record', () => {
    expect(planSessionId('ses_a')).toBe('ses_a');
    expect(planSessionId({ id: 'ses_b', title: 'x' })).toBe('ses_b');
    expect(planSessionId({ sessionId: 'ses_c' })).toBe('ses_c');
    expect(planSessionId(null)).toBeNull();
  });
  test('reads the plan and how it was found', () => {
    expect(readPlan({ plan: { id: 'shared:a.md', title: ' Plan A ', progress: { done: 17, total: 77 } }, how: 'edited', at: 5 }))
      .toEqual({ id: 'shared:a.md', title: 'Plan A', done: 17, total: 77, how: 'edited', at: 5, steps: [] });
    expect(readPlan({ plan: { title: 'B' }, how: 'linked' })).toEqual({ id: 'B', title: 'B', done: 0, total: 0, how: 'linked', at: 0, steps: [] });
    expect(readPlan({ plan: null })).toBeNull();
    expect(readPlan({ plan: { title: '  ' } })).toBeNull();
  });
  test('reads a plan\'s steps nested by indent, up to the next section', () => {
    const body = '# Plan\n\nIntro\n\n## Steps\n- [x] Phase 0 Decisions: check only\n  - [x] Step 0.1 Check\n  - [ ] Step 0.2 Record\n    - [X] Detail\n- [ ] Phase 1 Scaffold\n\n## Notes\n- [ ] not a step\n';
    expect(planSteps(body)).toEqual([
      { text: 'Phase 0 Decisions: check only', done: true, steps: [
        { text: 'Step 0.1 Check', done: true, steps: [] },
        { text: 'Step 0.2 Record', done: false, steps: [{ text: 'Detail', done: true, steps: [] }] },
      ] },
      { text: 'Phase 1 Scaffold', done: false, steps: [] },
    ]);
    expect(planSteps('no steps here\n- [ ] x')).toEqual([]);
    expect(readPlan({ plan: { title: 'P' }, steps: [{ text: ' A ', done: true, steps: [{ text: 'B' }, { nope: 1 }] }, 'junk'] })?.steps)
      .toEqual([{ text: 'A', done: true, steps: [{ text: 'B', done: false, steps: [] }] }]);
  });
});

describe('readsOwnFile', () => {
  test('a folder that never switched is unaffected', () => {
    expect(readsOwnFile(500, undefined)).toBe(true);
  });
  test('sessions already there keep their source; new ones do not', () => {
    expect(readsOwnFile(99, 100)).toBe(true);
    expect(readsOwnFile(100, 100)).toBe(false);
    expect(readsOwnFile(101, 100)).toBe(false);
  });
  test('a session of unknown age is left as it was', () => {
    expect(readsOwnFile(null, 100)).toBe(true);
  });
});

describe('quietNotice', () => {
  const now = 100 * 60_000;
  test('a waiting session needs you, whatever else is true', () => {
    expect(quietNotice({ activity: 'waiting-permission', updatedAt: now, open: 0, active: 0, thresholdMin: 10, now })).toEqual({ kind: 'attention', text: 'Waiting on your permission', since: now });
    expect(quietNotice({ activity: 'waiting-question', updatedAt: now, open: 0, active: 0, thresholdMin: 10, now })?.text).toBe('Waiting on your answer');
  });
  test('idle with an item marked in progress says so, with the measurement', () => {
    expect(quietNotice({ activity: 'idle', updatedAt: now - 12 * 60_000, open: 1, active: 1, thresholdMin: 10, now })?.text).toBe('No activity for 12 min, 1 still marked in progress');
  });
  test('stays silent while running, or inside the threshold', () => {
    expect(quietNotice({ activity: 'running', updatedAt: 0, open: 3, active: 1, thresholdMin: 10, now })).toBeNull();
    expect(quietNotice({ activity: 'idle', updatedAt: now - 60_000, open: 3, active: 1, thresholdMin: 10, now })).toBeNull();
    expect(quietNotice({ activity: 'idle', updatedAt: 0, open: 0, active: 0, thresholdMin: 10, now })).toBeNull();
  });
  test('an open list with nothing in progress is reported as open', () => {
    expect(quietNotice({ activity: 'idle', updatedAt: now - 30 * 60_000, open: 2, active: 0, thresholdMin: 10, now })?.text).toBe('No activity for 30 min, 2 still open');
  });
});

describe('version', () => {
  test('the built panel shows the version in package.json', async () => {
    const { version } = JSON.parse(await Bun.file('package.json').text()) as { version: string };
    expect(await Bun.file('panel/main.js').text()).toContain(version);
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
