import { GUEST_STATUS_SECTION_HEIGHT_MAX, connectHost, type SessionSnapshot } from '@openchamber/sdk';
import { applyHostReady, mountPopoverAnchor } from '@openchamber/sdk/ui';

import { h, icon } from '../shared/dom.ts';
import { createFeed, service } from '../shared/feed.ts';
import {
  EMPTY_MARKS,
  applyMarks,
  countViews,
  groupTodos,
  mixedPriorities,
  needsYou,
  sessionState,
  planVisible,
  quietNotice,
  readMarks,
  todosForSession,
  type FoldChoice,
  type GroupPlan,
  type Marks,
  type Todo,
  type TodoView,
} from '../shared/model.ts';
import { countLabel, noticeLine, progressBar, todoRow } from '../shared/rows.ts';
import { applySettings, foldsKey, marksKey, readFolds, type Folds } from '../shared/settings.ts';
import { TIP_FONT_PX, TIP_LABELS, readTip, tipData, tipSize } from '../shared/tip.ts';

// The Work Status section: one look at the session on screen. It stays small;
// anything that would make it taller or busier belongs in the panel.

const MAX_FRAME_PX = GUEST_STATUS_SECTION_HEIGHT_MAX;
const MARKS_EVERY_MS = 3000;
const ACTIVE_SHOWN = 3;

const host = connectHost();
const root = document.querySelector<HTMLElement>('#root');
if (!root) throw new Error('Missing root');

let isTip = false;
let tips = false;
let drawn = '';
let marks: Marks = EMPTY_MARKS;
let folds: Folds = {};
let lastSession: string | null = null;
let attention: ReturnType<typeof quietNotice> = null;
// Opening a list past its budget lasts until the session changes.
const showAll = { next: false, done: false };
const unclamped = new Set<string>();
const anchors: ReturnType<typeof mountPopoverAnchor>[] = [];
const FOLDS_KEY = foldsKey('section');

const measureLines = (() => {
  const context = document.createElement('canvas').getContext('2d');
  return (text: string): number[] => {
    const lines = text.split('\n');
    if (!context) return lines.map((line) => line.length * TIP_FONT_PX * 0.55);
    context.font = `${TIP_FONT_PX}px ${getComputedStyle(document.body).fontFamily}`;
    return lines.map((line) => context.measureText(line).width);
  };
})();

const feed = createFeed(host, (reason) => {
  if (reason === 'session') {
    const id = feed.session?.id ?? null;
    if (id !== lastSession) {
      lastSession = id;
      showAll.next = false;
      showAll.done = false;
      unclamped.clear();
      attention = null;
    }
    void refreshMarks();
  }
  if (reason === 'settings') {
    applySettings(feed.settings, 'section');
    void refreshMarks();
  }
  draw(reason !== 'view');
});

const refreshMarks = async (): Promise<void> => {
  const id = feed.session?.id;
  if (!id) return;
  try {
    const [rawMarks, rawFolds] = await Promise.all([
      feed.settings.ticking ? host.storage.get(marksKey(id)) : Promise.resolve(null),
      host.storage.get(FOLDS_KEY),
    ]);
    if (feed.session?.id !== id) return;
    marks = readMarks(rawMarks);
    folds = readFolds(rawFolds);
    draw();
  } catch { /* keep what we have */ }
};

const saveFold = (key: string, open: boolean): void => {
  folds = { ...folds, [key]: open };
  void host.storage.set(FOLDS_KEY, folds).catch(() => undefined);
  draw(true);
};

const row = (view: TodoView, oneLine: boolean, mark: boolean): HTMLElement => {
  const full = unclamped.has(view.key);
  const node = todoRow(view, {
    oneLine: oneLine && !full,
    twoLines: !oneLine && !full,
    tags: feed.settings.sectionTags ? 'show' : 'hide',
    markPriority: mark,
  });
  node.addEventListener('click', () => {
    if (full) unclamped.delete(view.key);
    else unclamped.add(view.key);
    draw(true);
  });
  if (!tips) {
    node.title = view.content;
    return node;
  }
  const data = tipData(view.content, view.status);
  anchors.push(mountPopoverAnchor(node, { host, side: 'left', ...tipSize(measureLines(data.text)), getData: () => data }));
  return node;
};

const header = (parent: DocumentFragment, views: TodoView[]): void => {
  const counts = countViews(views);
  const who = [feed.session?.title, feed.session?.agent].filter(Boolean).join(' · ');
  const name = h('span', { class: 'who trunc', title: who }, feed.settings.sectionWho ? who : '');
  parent.append(h('div', { class: 'sec-top' }, name, countLabel(counts)), progressBar(counts));
  if (attention) parent.append(noticeLine(attention, Date.now()));
};

const footer = (views: TodoView[], counts: ReturnType<typeof countViews>): HTMLElement => {
  const open = folds.done === true;
  const parts = [counts.done > 0 ? `${counts.done} done` : '', counts.mine > 0 ? `${counts.mine} by you` : ''].filter(Boolean).join(' · ');
  return h('button', {
    type: 'button',
    class: 'foot',
    'aria-expanded': String(open),
    title: `${open ? 'Fold' : 'Show'} finished items`,
    onClick: () => saveFold('done', !open),
  }, counts.done > 0 ? h('span', { class: 'car' }, icon('caret')) : icon('check'), h('span', { class: 'grow' }, parts));
};

// The default: what needs you, what is happening, what is next.
const drawGlance = (parent: DocumentFragment, views: TodoView[]): void => {
  const groups = groupTodos(views);
  const counts = countViews(views);
  const mark = feed.settings.priority && mixedPriorities(views);
  header(parent, views);
  const activeLimit = showAll.next ? groups.active.length : ACTIVE_SHOWN;
  // One item in progress gets two lines. Several share the space.
  for (const view of groups.active.slice(0, activeLimit)) parent.append(row(view, groups.active.length > 1, mark));
  if (groups.active.length > activeLimit) {
    parent.append(h('button', {
      type: 'button', class: 'more',
      onClick: () => { showAll.next = true; draw(true); },
    }, `${groups.active.length - activeLimit} more in progress`));
  }
  const limit = showAll.next ? groups.pending.length : Math.max(1, feed.settings.sectionRows - Math.max(0, Math.min(groups.active.length, ACTIVE_SHOWN) - 1));
  for (const view of groups.pending.slice(0, limit)) parent.append(row(view, true, mark));
  if (groups.pending.length > limit) {
    parent.append(h('button', {
      type: 'button', class: 'more',
      onClick: () => { showAll.next = true; draw(true); },
    }, `${groups.pending.length - limit} more`));
  }
  if (counts.done + counts.mine > 0) parent.append(footer(views, counts));
  if (folds.done === true) {
    for (const view of [...groups.completed, ...groups.cancelled]) parent.append(row(view, true, false));
  }
};

// The older layout: headed groups that fold.
const drawGroups = (parent: DocumentFragment, views: TodoView[]): void => {
  const groups = groupTodos(views);
  const mark = feed.settings.priority && mixedPriorities(views);
  const choice: FoldChoice = {
    pending: folds.pending ?? null,
    pendingAll: showAll.next,
    completed: folds.completed ?? null,
    completedAll: showAll.done,
    cancelled: folds.cancelled ?? null,
    cancelledAll: showAll.done,
  };
  const plan = planVisible(groups, choice);
  header(parent, views);
  if (plan.active.length > 0) {
    parent.append(h('div', { class: 'ghead g-active' }, h('span', { class: 'car' }), 'In progress', h('span', { class: 'n' }, String(plan.active.length))));
    const shownActive = showAll.next ? plan.active : plan.active.slice(0, ACTIVE_SHOWN);
    for (const view of shownActive) parent.append(row(view, false, mark));
    if (plan.active.length > shownActive.length) {
      parent.append(h('button', {
        type: 'button', class: 'more',
        onClick: () => { showAll.next = true; draw(true); },
      }, `${plan.active.length - shownActive.length} more in progress`));
    }
  }
  const fold = (key: 'pending' | 'completed' | 'cancelled', label: string, cls: string, total: number, part: GroupPlan<TodoView>): void => {
    if (total === 0) return;
    parent.append(h('button', {
      type: 'button', class: `ghead ${cls}`, 'aria-expanded': String(part.open),
      onClick: () => saveFold(key, !part.open),
    }, h('span', { class: 'car' }, icon('caret')), label, h('span', { class: 'n' }, String(total))));
    if (!part.open) return;
    for (const view of part.shown) parent.append(row(view, true, key === 'pending' && mark));
    if (part.hidden > 0) {
      parent.append(h('button', {
        type: 'button', class: 'more',
        onClick: () => {
          if (key === 'pending') showAll.next = true;
          else showAll.done = true;
          if (choice[key] === null) saveFold(key, true);
          else draw(true);
        },
      }, `${part.hidden} more`));
    }
  };
  fold('pending', 'Next', 'g-next', groups.pending.length, plan.pending);
  fold('completed', 'Done', 'g-done', groups.completed.length, plan.completed);
  fold('cancelled', 'Cancelled', '', groups.cancelled.length, plan.cancelled);
};

const draw = (force = false): void => {
  if (isTip) return;
  const view = feed.view;
  const signature = JSON.stringify([view, feed.session, feed.settings, marks, folds, attention, showAll, [...unclamped], tips]);
  if (!force && signature === drawn) return;
  drawn = signature;
  for (const anchor of anchors.splice(0)) anchor.dispose();
  const next = document.createDocumentFragment();
  if (view.kind === 'no-session') next.append(h('p', { class: 'empty' }, 'Open a session to see its todo list.'));
  else if (view.kind === 'problem') next.append(h('p', { class: 'empty problem' }, view.message));
  else if (view.kind === 'list') {
    if (view.todos.length === 0) {
      next.append(h('p', { class: 'empty', title: 'It appears here as soon as this session\'s agent writes one.' }, 'No todo list in this session.'));
    } else {
      const views = applyMarks(view.todos, marks, feed.settings.ticking);
      if (feed.settings.badge) void host.setBadge(views.filter((item) => !item.mine && (item.status === 'pending' || item.status === 'in_progress')).length || null).catch(() => undefined);
      if (feed.settings.sectionLayout === 'groups') drawGroups(next, views);
      else drawGlance(next, views);
    }
  }
  const box = h('div', { class: 'sec' });
  box.append(next);
  root.replaceChildren(box);
};

// ----- Attention, from the host's session state -----

const refreshAttention = async (): Promise<void> => {
  const id = feed.session?.id;
  if (!id || !workspaceProject) return;
  try {
    const snapshot = await host.listSessions(workspaceProject);
    const record = snapshot.sessions.find((session) => session.id === id);
    if (feed.session?.id !== id) return;
    const lists: Todo[] = feed.view.kind === 'list' ? feed.view.todos : [];
    const counts = countViews(applyMarks(lists, marks, feed.settings.ticking));
    const fromService = record ? null : sessionState((await service(host, '/v1/session', { sessionId: id, directory: feed.directory }).catch(() => null))?.session);
    if (feed.session?.id !== id) return;
    const known = record ?? fromService;
    attention = known ? quietNotice({ activity: known.activity, updatedAt: known.updatedAt, open: counts.open, active: counts.active, thresholdMin: feed.settings.quietMinutes, now: Date.now() }) : null;
    if (record && feed.settings.notify && needsYou(record.activity)) void tell(record.id, record.title, record.updatedAt);
    draw();
  } catch { /* no sessions grant, or not loaded yet */ }
};

const tell = async (id: string, title: string, updatedAt: number): Promise<void> => {
  const answer = await service(host, '/v1/claim', { key: `${id}:${updatedAt}` }).catch(() => null);
  if (answer?.first === true) void host.toast({ kind: 'info', message: `${title} needs you` }).catch(() => undefined);
};

let workspaceProject: string | null = null;
const findProject = async (): Promise<void> => {
  const directory = feed.directory;
  try {
    const snapshot = await host.listProjects();
    const norm = (value: string): string => value.replace(/\\/g, '/').toLowerCase();
    workspaceProject = snapshot.projects.find((project) => directory && norm(directory).startsWith(norm(project.directory)))?.id ?? snapshot.projects[0]?.id ?? null;
  } catch {
    workspaceProject = null;
  }
};

// ----- Height, tip, start -----

let reportedHeight = -1;
const heightWatch = new ResizeObserver(() => {
  const height = Math.min(MAX_FRAME_PX, Math.ceil(root.getBoundingClientRect().height));
  if (height === reportedHeight) return;
  reportedHeight = height;
  void host.setHeight(height).catch(() => undefined);
});

window.addEventListener('resize', () => draw(true));

const drawTip = (data: unknown): void => {
  const tip = readTip(data);
  root.className = 'tip';
  root.replaceChildren(...(tip ? [h('div', { class: 'tip-label' }, TIP_LABELS[tip.status]), h('div', { class: 'tip-text' }, tip.text)] : []));
};

// Layout preview without OpenChamber (scripts/preview.mjs).
type Preview = { session: SessionSnapshot; todos: unknown };
const preview = (window as unknown as { sessionTodosPreview?: Preview }).sessionTodosPreview;

if (preview) {
  const todos = todosForSession({ [preview.session.id]: preview.todos }, preview.session.id);
  Object.defineProperty(feed, 'view', { value: { kind: 'list', todos, source: 'preview', at: 0 } });
  Object.defineProperty(feed, 'session', { value: preview.session });
  applySettings(feed.settings, 'section');
  draw(true);
  heightWatch.observe(root);
} else {
  let started = false;
  host.onReady((context) => {
    applyHostReady(context, document.documentElement);
    if (context.surface === 'popover') {
      isTip = true;
      drawTip(context.popover?.data);
      heightWatch.observe(root);
      return;
    }
    const popovers = context.features?.popovers === true;
    if (popovers !== tips) {
      tips = popovers;
      if (started) draw(true);
    }
    if (started) return;
    started = true;
    applySettings(feed.settings, 'section');
    heightWatch.observe(root);
    feed.start();
    window.setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      void refreshMarks();
      void (workspaceProject ? refreshAttention() : findProject().then(refreshAttention));
    }, MARKS_EVERY_MS);
  });
}
