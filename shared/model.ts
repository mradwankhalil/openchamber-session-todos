// Pure logic shared by the section, the panel and the service. No host, no DOM.

// The todo store written by the oh-my-openagent v2 adapter's `todowrite`:
// one JSON object per session directory, session id -> todo list.
export const TODOS_PATH = '.omo/v2-state/todos.json';
// Same folder: child session id -> parent session id.
export const PARENTS_PATH = '.omo/v2-state/parents.json';

export type TodoStatus = 'in_progress' | 'pending' | 'completed' | 'cancelled';

export type Todo = { content: string; status: TodoStatus; priority?: string; id?: string };

export type TodoGroups = {
  active: Todo[];
  pending: Todo[];
  completed: Todo[];
  cancelled: Todo[];
  total: number;
  done: number;
};

const STATUSES: ReadonlySet<string> = new Set(['in_progress', 'pending', 'completed', 'cancelled']);

export const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

/**
 * `null` when the text is not one complete JSON object. The adapter rewrites
 * the file in place, so a read can land in the middle of a write; the caller
 * keeps what it has and reads again.
 */
export const parseTodosFile = (raw: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(raw.replace(/^﻿/, ''));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

/** Any stored shape of a list, normalised. Unknown statuses read as pending. */
export const readTodos = (source: unknown): Todo[] => {
  const list: unknown[] = Array.isArray(source)
    ? source
    : isRecord(source) && Array.isArray(source.todos) ? source.todos : [];
  const todos: Todo[] = [];
  for (const entry of list) {
    if (!isRecord(entry) || typeof entry.content !== 'string') continue;
    const content = entry.content.replace(/\s+/g, ' ').trim();
    if (!content) continue;
    const status = typeof entry.status === 'string' && STATUSES.has(entry.status) ? entry.status as TodoStatus : 'pending';
    const todo: Todo = { content, status };
    if (typeof entry.priority === 'string' && entry.priority) todo.priority = entry.priority;
    if (typeof entry.id === 'string' && entry.id) todo.id = entry.id;
    todos.push(todo);
  }
  return todos;
};

/** The list stored for one session, in the agent's order. Other sessions in the file are never returned. */
export const todosForSession = (file: Record<string, unknown> | null, sessionId: string): Todo[] => {
  if (!file || !Object.hasOwn(file, sessionId)) return [];
  return readTodos(file[sessionId]);
};

export const groupTodos = <T extends Todo>(todos: T[]): Omit<TodoGroups, 'active' | 'pending' | 'completed' | 'cancelled'> & { active: T[]; pending: T[]; completed: T[]; cancelled: T[] } => {
  const groups = { active: [] as T[], pending: [] as T[], completed: [] as T[], cancelled: [] as T[], total: todos.length, done: 0 };
  for (const todo of todos) {
    if (todo.status === 'in_progress') groups.active.push(todo);
    else if (todo.status === 'completed') groups.completed.push(todo);
    else if (todo.status === 'cancelled') groups.cancelled.push(todo);
    else groups.pending.push(todo);
  }
  groups.done = groups.completed.length + groups.cancelled.length;
  return groups;
};

/** The first `limit` items, or all of them once the user asked for the rest. */
export const visibleSlice = <T>(items: T[], limit: number, showAll: boolean): { shown: T[]; hidden: number } => (
  showAll || items.length <= limit
    ? { shown: items, hidden: 0 }
    : { shown: items.slice(0, limit), hidden: items.length - limit }
);

/** How many todos are shown without a click. */
export const VISIBLE_ITEMS = 10;

/** For each foldable group: `null` follows the row budget; `true` / `false` is the user's own choice. */
export type FoldChoice = {
  pending: boolean | null;
  pendingAll: boolean;
  completed: boolean | null;
  completedAll: boolean;
  cancelled: boolean | null;
  cancelledAll: boolean;
};

export type GroupPlan<T extends Todo = Todo> = { shown: T[]; hidden: number; open: boolean };

export type VisiblePlan<T extends Todo = Todo> = { active: T[]; pending: GroupPlan<T>; completed: GroupPlan<T>; cancelled: GroupPlan<T> };

/**
 * Which rows to draw. Up to `budget` todos show without a click, handed out in
 * the order in progress, next, completed, cancelled. In-progress items are all
 * shown even past the budget and never fold. Next, Completed and Cancelled fold
 * alike: a group the user opened or folded keeps that choice, and an opened
 * group shows up to `openLimit` rows before "show more".
 */
export const planVisible = <T extends Todo>(groups: { active: T[]; pending: T[]; completed: T[]; cancelled: T[] }, choice: FoldChoice, budget = VISIBLE_ITEMS, openLimit = 30): VisiblePlan<T> => {
  let left = Math.max(0, budget - groups.active.length);
  const spend = (items: T[], count: number, open: boolean): GroupPlan<T> => {
    left = Math.max(0, left - count);
    return { shown: items.slice(0, count), hidden: items.length - count, open };
  };
  const folding = (items: T[], open: boolean | null, all: boolean): GroupPlan<T> => {
    if (open === false) return spend(items, 0, false);
    if (open === true) return spend(items, all ? items.length : Math.min(items.length, openLimit), true);
    const count = Math.min(items.length, left);
    return spend(items, count, count > 0);
  };
  const pending = folding(groups.pending, choice.pending, choice.pendingAll);
  const completed = folding(groups.completed, choice.completed, choice.completedAll);
  const cancelled = folding(groups.cancelled, choice.cancelled, choice.cancelledAll);
  return { active: groups.active, pending, completed, cancelled };
};

/** Sessions already running when a folder switched keep the source they started with. */
export const readsOwnFile = (createdAt: number | null, switchedAt: number | undefined): boolean => (
  switchedAt === undefined || createdAt === null || createdAt < switchedAt
);

// ----- OpenChamber's project backlog: a different list, shown under its own label -----

export type BacklogItem = { id: string; text: string; done: boolean };

export const readBacklog = (raw: unknown): BacklogItem[] => {
  if (!isRecord(raw) || !Array.isArray(raw.todos)) return [];
  return raw.todos.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const text = [entry.text, entry.body, entry.content].find((value): value is string => typeof value === 'string' && value.trim() !== '');
    if (!text) return [];
    return [{ id: String(entry.id ?? text), text: text.replace(/\s+/g, ' ').trim(), done: entry.completed === true || entry.done === true }];
  });
};

// ----- Subagents, at any depth -----

export const MAX_SUBAGENT_DEPTH = 4;

export type DepthSetting = 'auto' | 0 | 1 | 2 | 3 | 4;

/** How deep to show. `auto` follows the config, or one level when the config says nothing. */
export const resolveDepth = (setting: DepthSetting, configured: number | null): number => (
  setting === 'auto' ? Math.min(MAX_SUBAGENT_DEPTH, Math.max(1, configured ?? 1)) : setting
);

export type Descendant = { id: string; depth: number };

/** Everyone under `root`, parents before their children. A loop in the data can't trap this. */
export const descendants = (root: string, parents: Record<string, unknown>, maxDepth: number, cap = 200): Descendant[] => {
  const children = new Map<string, string[]>();
  for (const [child, parent] of Object.entries(parents)) {
    if (typeof parent !== 'string') continue;
    children.set(parent, [...(children.get(parent) ?? []), child]);
  }
  const seen = new Set([root]);
  const out: Descendant[] = [];
  const walk = (id: string, depth: number): void => {
    if (depth > maxDepth) return;
    for (const child of children.get(id) ?? []) {
      if (seen.has(child) || out.length >= cap) continue;
      seen.add(child);
      out.push({ id: child, depth });
      walk(child, depth + 1);
    }
  };
  walk(root, 1);
  return out;
};

// ----- Sessions the SDK's project list doesn't cover, such as chats -----

export const CHATS_PROJECT = 'session-todos:chats';

export type SessionState = { activity: Activity; updatedAt: number };

/** From a session's times. "Waiting on you" can't be told from these, only running or idle. */
export const sessionState = (raw: unknown): SessionState | null => {
  if (!isRecord(raw) || !isRecord(raw.time)) return null;
  const { busy, idle, updated } = raw.time;
  const running = typeof busy === 'number' && (typeof idle !== 'number' || busy > idle);
  return { activity: running ? 'running' : 'idle', updatedAt: typeof updated === 'number' ? updated : 0 };
};

/** One entry of the session list as the SDK's record, under the Chats group. */
export const looseSession = (raw: unknown) => {
  if (!isRecord(raw) || typeof raw.id !== 'string') return null;
  const time = isRecord(raw.time) ? raw.time : {};
  const location = isRecord(raw.location) ? raw.location : {};
  const state = sessionState(raw);
  return {
    id: raw.id,
    title: typeof raw.title === 'string' && raw.title ? raw.title : raw.id,
    projectId: CHATS_PROJECT,
    directory: typeof location.directory === 'string' ? location.directory : '',
    parentId: typeof raw.parentID === 'string' ? raw.parentID : null,
    createdAt: typeof time.created === 'number' ? time.created : 0,
    updatedAt: state?.updatedAt ?? 0,
    archivedAt: typeof time.archived === 'number' ? time.archived : null,
    worktree: null,
    activity: state?.activity ?? 'unknown',
    outcome: null,
    items: [],
  };
};

/** The id OpenChamber keeps a folder's knowledge under when it isn't a registered project. */
export const pathProjectId = (directory: string): string => {
  const bytes = new TextEncoder().encode(directory.replace(/\\/g, '/'));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `path_${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
};

/** Sessions active since `since`, with the rest of their family: an old parent or child belongs with a live one. */
export const liveFamilies = <T extends { id: string; parentId: string | null; updatedAt: number; archivedAt: number | null }>(items: T[], since: number): T[] => {
  const byId = new Map(items.map((item) => [item.id, item]));
  const under = new Map<string, T[]>();
  for (const item of items) if (item.parentId) under.set(item.parentId, [...(under.get(item.parentId) ?? []), item]);
  const keep = new Set<string>();
  const down = (item: T): void => {
    if (keep.has(item.id)) return;
    keep.add(item.id);
    for (const child of under.get(item.id) ?? []) down(child);
  };
  for (const item of items) {
    if (item.archivedAt !== null || item.updatedAt < since) continue;
    const seen = new Set<string>();
    let top = item;
    while (top.parentId && !seen.has(top.id)) {
      seen.add(top.id);
      const parent = byId.get(top.parentId);
      if (!parent) break;
      top = parent;
    }
    down(top);
  }
  return items.filter((item) => keep.has(item.id) && item.archivedAt === null);
};

/** The project a folder belongs to, by path. */
export const projectForFolder = <P extends { directory: string }>(directory: string, projects: P[]): P | undefined => {
  const norm = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const folder = norm(directory);
  return projects
    .filter((project) => project.directory && (folder === norm(project.directory) || folder.startsWith(`${norm(project.directory)}/`)))
    .sort((left, right) => right.directory.length - left.directory.length)[0];
};

export type TreeNode<T> = { item: T; children: TreeNode<T>[] };

/** Top-level items, each with its children below, to `maxDepth` levels. A parent outside the set makes its child top-level. */
/**
 * Splits subagent rows (parents directly before their children) into Active and Idle, newest
 * first. A subagent stays under its parent, so a parent counts as active and recent if anything
 * below it is. Waiting on you counts as active.
 */
export const subagentSections = <T extends { depth: number; activity: string; updatedAt: number }>(rows: T[]): { active: T[]; idle: T[] } => {
  type Family = { row: T; kids: Family[]; active: boolean; recent: number };
  const top: Family[] = [];
  const path: Family[] = [];
  for (const row of rows) {
    const family: Family = { row, kids: [], active: false, recent: 0 };
    while ((path.at(-1)?.row.depth ?? 0) >= row.depth) path.pop();
    (path.at(-1)?.kids ?? top).push(family);
    path.push(family);
  }
  const settle = (family: Family): void => {
    family.kids.forEach(settle);
    family.kids.sort((left, right) => right.recent - left.recent);
    const { activity, updatedAt } = family.row;
    family.active = activity === 'running' || activity === 'retrying' || needsYou(activity) || family.kids.some((kid) => kid.active);
    family.recent = Math.max(updatedAt, ...family.kids.map((kid) => kid.recent));
  };
  top.forEach(settle);
  top.sort((left, right) => right.recent - left.recent);
  const flat = (family: Family): T[] => [family.row, ...family.kids.flatMap(flat)];
  return { active: top.filter((family) => family.active).flatMap(flat), idle: top.filter((family) => !family.active).flatMap(flat) };
};

/** Drops what `keep` refuses, unless something kept is below it. */
export const pruneTree = <T>(nodes: TreeNode<T>[], keep: (item: T) => boolean): TreeNode<T>[] => nodes.flatMap((node) => {
  const children = pruneTree(node.children, keep);
  return keep(node.item) || children.length > 0 ? [{ item: node.item, children }] : [];
});

export const buildTree = <T extends { id: string; parentId: string | null }>(items: T[], maxDepth: number): TreeNode<T>[] => {
  const ids = new Set(items.map((item) => item.id));
  const under = new Map<string, T[]>();
  for (const item of items) {
    if (item.parentId && ids.has(item.parentId) && item.parentId !== item.id) under.set(item.parentId, [...(under.get(item.parentId) ?? []), item]);
  }
  const seen = new Set<string>();
  const walk = (item: T, depth: number): TreeNode<T> => {
    seen.add(item.id);
    const below = depth >= maxDepth ? [] : (under.get(item.id) ?? []).filter((child) => !seen.has(child.id));
    return { item, children: below.map((child) => walk(child, depth + 1)) };
  };
  return items.filter((item) => !item.parentId || !ids.has(item.parentId) || item.parentId === item.id).map((item) => walk(item, 0));
};

// ----- Reading agent text -----

// Words that read like a sentence opening, not a label the agent chose.
const NOT_TAGS: ReadonlySet<string> = new Set(['FIX', 'TODO', 'NOTE', 'WIP']);

/** `NEXT-COORD | Confirm the pin` -> a tag and a title. A short or lower-case prefix stays text. */
export const splitTag = (content: string): { tag: string | null; title: string } => {
  const match = /^([A-Z][A-Z0-9]*(?:[-_][A-Z0-9]+)*)\s*[|:]\s+(\S.*)$/.exec(content);
  if (!match?.[1] || !match[2] || match[1].length < 3 || match[1].length > 28 || NOT_TAGS.has(match[1])) return { tag: null, title: content };
  return { tag: match[1], title: match[2] };
};

/** Session ids named in a todo's text, once each, in order. */
export const findRefs = (text: string): string[] => [...new Set(text.match(/\bses_[A-Za-z0-9]{6,}\b/g) ?? [])];

/** Where every item shares one priority, a mark says nothing. */
export const mixedPriorities = (todos: Todo[]): boolean => new Set(todos.map((todo) => todo.priority ?? '')).size > 1;

// ----- The user's own marks, kept apart from the agent's list -----

/** Stable key for an item. No agent list carries reliable ids, so the text is the identity. */
export const itemKey = (content: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${(hash >>> 0).toString(36)}-${content.length.toString(36)}`;
};

export type Marks = { ticks: Record<string, number>; notes: Record<string, string> };

export const EMPTY_MARKS: Marks = { ticks: {}, notes: {} };

export const readMarks = (value: unknown): Marks => {
  if (!isRecord(value)) return EMPTY_MARKS;
  const ticks: Record<string, number> = {};
  const notes: Record<string, string> = {};
  if (isRecord(value.ticks)) for (const [key, at] of Object.entries(value.ticks)) if (typeof at === 'number') ticks[key] = at;
  if (isRecord(value.notes)) for (const [key, text] of Object.entries(value.notes)) if (typeof text === 'string') notes[key] = text;
  return { ticks, notes };
};

export type TodoView = Todo & { key: string; mine: boolean; note: string };

const isOpen = (status: TodoStatus): boolean => status === 'pending' || status === 'in_progress';

/** Merge at draw time. With ticking off, no mark shows anywhere, and none is deleted. */
export const applyMarks = (todos: Todo[], marks: Marks, enabled: boolean): TodoView[] => todos.map((todo) => {
  const key = itemKey(todo.content);
  return {
    ...todo,
    key,
    mine: enabled && isOpen(todo.status) && Object.hasOwn(marks.ticks, key),
    note: enabled ? marks.notes[key] ?? '' : '',
  };
});

/**
 * Forget marks the agent has overtaken: it finished the item or dropped it.
 * Only a list that holds items can tell us that. An empty read may just be the
 * host answering for the previous session's folder.
 */
export const pruneMarks = (marks: Marks, todos: Todo[]): Marks => {
  if (todos.length === 0) return marks;
  const open = new Set(todos.filter((todo) => isOpen(todo.status)).map((todo) => itemKey(todo.content)));
  const present = new Set(todos.map((todo) => itemKey(todo.content)));
  const ticks = Object.fromEntries(Object.entries(marks.ticks).filter(([key]) => open.has(key)));
  const notes = Object.fromEntries(Object.entries(marks.notes).filter(([key]) => present.has(key)));
  const same = Object.keys(ticks).length === Object.keys(marks.ticks).length && Object.keys(notes).length === Object.keys(marks.notes).length;
  return same ? marks : { ticks, notes };
};

/** done includes cancelled: both are finished. cancelled is kept apart so the bar can show it. */
export type Counts = { total: number; done: number; cancelled: number; mine: number; active: number; open: number };

/** What the list claims, kept apart from what the user claims. */
export const countViews = (views: TodoView[]): Counts => {
  const counts: Counts = { total: views.length, done: 0, cancelled: 0, mine: 0, active: 0, open: 0 };
  for (const view of views) {
    if (view.mine) counts.mine += 1;
    else if (view.status === 'completed') counts.done += 1;
    else if (view.status === 'cancelled') { counts.done += 1; counts.cancelled += 1; }
    else if (view.status === 'in_progress') counts.active += 1;
    else counts.open += 1;
  }
  return counts;
};

export type Filter = 'all' | 'open' | 'done';

export const isDoneView = (view: TodoView): boolean => view.mine || !isOpen(view.status);

export const filterViews = (views: TodoView[], filter: Filter, query: string): TodoView[] => {
  const needle = query.trim().toLowerCase();
  return views.filter((view) => {
    if (needle && !view.content.toLowerCase().includes(needle)) return false;
    // Cancelled work sits with Open, folded. Done means finished.
    if (filter === 'open') return view.status === 'cancelled' || !isDoneView(view);
    if (filter === 'done') return isDoneView(view) && view.status !== 'cancelled';
    return true;
  });
};

export type SubagentRow<T> = T & { shown: TodoView[]; tucked: TodoView[] };

/**
 * The subagents a filter lists. Open needs work left, Done needs finished work; cancelled
 * items alone match neither. One with no match stays, empty, only to lead to one below it.
 */
export const subagentsFor = <T extends { depth: number; todos: TodoView[] }>(children: T[], filter: Filter): SubagentRow<T>[] => {
  const kept: SubagentRow<T>[] = [];
  // Parents come before children, so from the end.
  for (const child of [...children].reverse()) {
    const matches = filterViews(child.todos, filter, '');
    const tucked = filter === 'open' ? matches.filter((view) => view.status === 'cancelled') : [];
    const shown = filter === 'open' ? matches.filter((view) => view.status !== 'cancelled') : matches;
    const leads = (kept[0]?.depth ?? 0) > child.depth;
    if (shown.length > 0) kept.unshift({ ...child, shown, tucked });
    else if (leads) kept.unshift({ ...child, shown: [], tucked: [] });
  }
  return kept;
};

// ----- Export -----

const markdownLine = (view: TodoView): string => {
  if (view.mine) return `- [x] ${view.content} *(done by you)*`;
  if (view.status === 'completed') return `- [x] ${view.content}`;
  if (view.status === 'cancelled') return `- [ ] ~~${view.content}~~ *(cancelled)*`;
  if (view.status === 'in_progress') return `- [ ] ${view.content} *(in progress)*`;
  return `- [ ] ${view.content}`;
};

const markdownBlock = (level: string, title: string, views: TodoView[]): string => {
  const counts = countViews(views);
  const lines = views.map((view) => view.note ? `${markdownLine(view)}\n  - Note: ${view.note}` : markdownLine(view));
  return [`${level} ${title} (${counts.done + counts.mine}/${counts.total})`, '', ...lines].join('\n');
};

export const toMarkdown = (title: string, views: TodoView[], children: { title: string; todos: TodoView[] }[] = []): string => [
  markdownBlock('##', title, views),
  ...children.map((child) => markdownBlock('###', child.title, child.todos)),
].join('\n\n');

// ----- History -----

export type Revision = { at: number; source: string; todos: Todo[] };

export const MAX_REVISIONS = 200;

const sameList = (left: Todo[], right: Todo[]): boolean => (
  left.length === right.length && left.every((todo, index) => todo.content === right[index]?.content && todo.status === right[index]?.status)
);

/** Every agent update replaces the whole list; keep each one that differs. Returns the same array when nothing changed. */
export const appendRevision = (revisions: Revision[], todos: Todo[], at: number, source: string, max = MAX_REVISIONS): Revision[] => {
  const last = revisions[revisions.length - 1];
  if (last && sameList(last.todos, todos)) return revisions;
  return [...revisions, { at, source, todos }].slice(-max);
};

export type ItemEvent = { at: number; what: 'added' | 'started' | 'finished' | 'cancelled' | 'reopened' | 'gone' | 'returned' };

export type ItemHistory = { events: ItemEvent[]; inProgressMs: number };

export const itemHistory = (revisions: Revision[], content: string, now = Date.now()): ItemHistory => {
  const events: ItemEvent[] = [];
  let previous: TodoStatus | 'absent' | null = null;
  let startedAt: number | null = null;
  let inProgressMs = 0;
  for (const revision of revisions) {
    const status: TodoStatus | 'absent' = revision.todos.find((todo) => todo.content === content)?.status ?? 'absent';
    if (status !== previous) {
      if (startedAt !== null && status !== 'in_progress') {
        inProgressMs += revision.at - startedAt;
        startedAt = null;
      }
      if (status === 'in_progress' && startedAt === null) startedAt = revision.at;
      if (previous === null || previous === 'absent') {
        if (status !== 'absent') events.push({ at: revision.at, what: previous === 'absent' && events.length > 0 ? 'returned' : 'added' });
        if (status === 'in_progress') events.push({ at: revision.at, what: 'started' });
        if (status === 'completed') events.push({ at: revision.at, what: 'finished' });
        if (status === 'cancelled') events.push({ at: revision.at, what: 'cancelled' });
      } else if (status === 'absent') events.push({ at: revision.at, what: 'gone' });
      else if (status === 'in_progress') events.push({ at: revision.at, what: 'started' });
      else if (status === 'completed') events.push({ at: revision.at, what: 'finished' });
      else if (status === 'cancelled') events.push({ at: revision.at, what: 'cancelled' });
      else events.push({ at: revision.at, what: 'reopened' });
      previous = status;
    }
  }
  if (startedAt !== null) inProgressMs += Math.max(0, now - startedAt);
  return { events, inProgressMs };
};

export type DroppedItem = { content: string; priority?: string; goneAt: number };

/** Items last seen open that the current list no longer has, with no word about why. */
export const droppedItems = (revisions: Revision[], current: Todo[]): DroppedItem[] => {
  const present = new Set(current.map((todo) => todo.content));
  const lastOpen = new Map<string, Todo>();
  const dropped = new Map<string, DroppedItem>();
  let before: Revision | null = null;
  for (const revision of revisions) {
    const here = new Set(revision.todos.map((todo) => todo.content));
    if (before) {
      for (const todo of before.todos) {
        if (here.has(todo.content) || !isOpen(todo.status)) continue;
        dropped.set(todo.content, { content: todo.content, ...(todo.priority ? { priority: todo.priority } : {}), goneAt: revision.at });
      }
    }
    for (const todo of revision.todos) {
      dropped.delete(todo.content);
      if (isOpen(todo.status)) lastOpen.set(todo.content, todo);
    }
    before = revision;
  }
  return [...dropped.values()].filter((item) => !present.has(item.content) && lastOpen.has(item.content));
};

// ----- Attention -----

export type Activity = 'unknown' | 'idle' | 'running' | 'retrying' | 'waiting-permission' | 'waiting-question';

export type Notice = { kind: 'attention' | 'quiet'; text: string; since: number };

export const needsYou = (activity: string | undefined): boolean => activity === 'waiting-permission' || activity === 'waiting-question';

/** What the list can't say for itself. Inferred states state the measurement, never a verdict. */
export const quietNotice = (input: { activity: Activity | undefined; updatedAt: number; open: number; active: number; thresholdMin: number; now: number }): Notice | null => {
  const { activity, updatedAt, open, active, thresholdMin, now } = input;
  if (activity === 'waiting-permission') return { kind: 'attention', text: 'Waiting on your permission', since: updatedAt };
  if (activity === 'waiting-question') return { kind: 'attention', text: 'Waiting on your answer', since: updatedAt };
  if (activity !== 'idle' || open + active === 0 || updatedAt <= 0) return null;
  const minutes = Math.floor((now - updatedAt) / 60_000);
  if (minutes < thresholdMin) return null;
  const rest = active > 0 ? `${active} still marked in progress` : `${open} still open`;
  return { kind: 'quiet', text: `No activity for ${minutes} min, ${rest}`, since: updatedAt };
};

export const elapsedLabel = (ms: number): string => {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
};
