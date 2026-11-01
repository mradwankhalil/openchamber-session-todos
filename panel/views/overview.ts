import type { GuestSessionRecord } from '@openchamber/sdk';

import { h, icon } from '../../shared/dom.ts';
import { CHATS_PROJECT, EMPTY_MARKS, applyMarks, buildTree, countViews, elapsedLabel, groupTodos, liveFamilies, needsYou, pruneTree, quietNotice, resolveDepth, type Todo, type TreeNode } from '../../shared/model.ts';
import { progressBar, todoRow } from '../../shared/rows.ts';
import type { App } from '../app.ts';
import { indentStyle, pageTop, rails, treed } from './parts.ts';

export type Lists = Record<string, { todos: Todo[]; source: string; at: number }>;

type Node = TreeNode<GuestSessionRecord>;

const say = (session: GuestSessionRecord, todos: Todo[], quiet: string | null): string => {
  if (session.activity === 'waiting-permission') return 'Waiting on your permission';
  if (session.activity === 'waiting-question') return 'Waiting on your answer';
  if (quiet) return quiet;
  const now = todos.find((todo) => todo.status === 'in_progress');
  if (now) return now.content;
  if (session.activity === 'running' || session.activity === 'retrying') return 'Working';
  if (todos.length > 0 && todos.every((todo) => todo.status === 'completed' || todo.status === 'cancelled')) return 'Finished';
  return session.outcome === 'failed' ? 'Last turn failed' : '';
};

const needsBelow = (node: Node): boolean => node.children.some((child) => needsYou(child.item.activity) || needsBelow(child));
const sizeBelow = (node: Node): number => node.children.reduce((total, child) => total + 1 + sizeBelow(child), 0);

/** Chats, then projects, then sessions, then their subagents. Lists stay under their own session's label, never merged. */
export const viewOverview = (app: Pick<App, 'state' | 'actions' | 'feed' | 'workspace'>): HTMLElement[] => {
  const { state, actions, feed, workspace } = app;
  const now = Date.now();
  const allSessions = [...workspace.sessions, ...state.otherSessions];
  if (!workspace.available && allSessions.length === 0) {
    return [pageTop('Every session'), h('p', { class: 'empty', style: 'padding:10px 0' }, 'This needs the sessions permission. Approve Session Todos in Settings → Extensions.')];
  }
  const since = now - feed.settings.overviewDays * 86_400_000;
  const live = liveFamilies(allSessions, since);

  const todosOf = (id: string): Todo[] => state.lists[id]?.todos ?? [];
  const countsOf = (id: string) => countViews(applyMarks(todosOf(id), EMPTY_MARKS, false));
  const quiet = (session: GuestSessionRecord, todos: Todo[]): string | null => {
    const counts = countViews(applyMarks(todos, EMPTY_MARKS, false));
    const notice = quietNotice({ activity: session.activity, updatedAt: session.updatedAt, open: counts.open, active: counts.active, thresholdMin: feed.settings.quietMinutes, now });
    return notice?.kind === 'quiet' ? notice.text : null;
  };

  const waiting = live.filter((session) => needsYou(session.activity)).length;
  const running = live.filter((session) => session.activity === 'running' || session.activity === 'retrying').length;
  const quietCount = live.filter((session) => quiet(session, todosOf(session.id)) !== null).length;
  const depth = resolveDepth(feed.settings.subagentDepth, state.configuredDepth);

  const caret = (open: boolean, label: string, toggle: () => void): HTMLElement => (
    h('button', {
      type: 'button', class: 'car-btn', 'aria-expanded': String(open), 'aria-label': `${open ? 'Collapse' : 'Expand'} ${label}`,
      onClick: (event: Event) => { event.stopPropagation(); toggle(); },
    }, icon('caret'))
  );

  // ----- Sessions: one row each, subagents behind a caret -----

  const sessionRows = (node: Node, level: number): HTMLElement[] => {
    const session = node.item;
    const todos = todosOf(session.id);
    const counts = countsOf(session.id);
    const key = `ov:s:${session.id}`;
    const open = actions.isOpen(key, false);
    const hiddenNeed = !open && needsBelow(node);
    const row = h('div', {
      class: `sess${needsYou(session.activity) || hiddenNeed ? ' attn' : ''}`,
      onClick: () => actions.openSession(session.id),
    },
      ...rails(level),
      h('span', { class: 'tcell', style: indentStyle(level) },
        node.children.length > 0 ? caret(open, session.title, () => actions.setFold(key, !open)) : h('span', { class: 'car-gap' }),
        h('span', { class: `dot ${session.activity}`, title: session.activity }),
        h('button', { type: 'button', class: 'ttl trunc', title: `Open ${session.title}` }, session.title),
        node.children.length > 0 ? h('span', { class: 'num faint small', title: 'Subagents' }, String(sizeBelow(node))) : null),
      h('span', { class: 'now trunc' }, hiddenNeed ? 'A subagent needs you' : say(session, todos, quiet(session, todos))),
      h('span', { class: 'pb' }, todos.length ? progressBar(counts) : null),
      h('span', { class: 'num' }, todos.length ? `${counts.done}/${counts.total}` : ''),
      h('span', { class: 'num faint t' }, elapsedLabel(now - session.updatedAt)));
    return [row, ...(open ? node.children.flatMap((child) => sessionRows(child, level + 1)) : [])];
  };

  // ----- Open todos: session, its list, then its subagents' -----

  const openRows = (node: Node, level: number, top = true): HTMLElement[] => {
    const session = node.item;
    const groups = groupTodos(applyMarks(todosOf(session.id), EMPTY_MARKS, false));
    const items = [...groups.active, ...groups.pending];
    const key = `ov:o:${session.id}`;
    // A top session starts open, its subagents folded.
    const open = actions.isOpen(key, top);
    const below = node.children.flatMap((child) => openRows(child, level + 1, false));
    if (items.length === 0 && below.length === 0) return [];
    return [
      treed(level, h('div', { class: 'sesslabel' },
        caret(open, session.title, () => actions.setFold(key, !open)),
        h('span', { class: `dot ${session.activity}`, title: session.activity }),
        h('button', { type: 'button', class: 'name trunc', title: `Open ${session.title}`, onClick: () => actions.openSession(session.id) }, session.title),
        groups.total > 0 ? h('span', { class: 'num faint' }, `${groups.done}/${groups.total}`) : null)),
      ...(open ? [
        ...items.map((view) => treed(level + 1, todoRow(view, { oneLine: true, tags: feed.settings.tags ? 'show' : 'raw', markPriority: false }))),
        ...below,
      ] : []),
    ];
  };

  const rowsFor = (node: Node, level: number): HTMLElement[] => (state.overviewMode === 'open' ? openRows(node, level) : sessionRows(node, level));

  const byRecent = (left: GuestSessionRecord, right: GuestSessionRecord): number => right.updatedAt - left.updatedAt;
  // A subagent earns a row with a todo list, or by waiting on you.
  const treeOf = (sessions: GuestSessionRecord[]): Node[] => buildTree([...sessions].sort(byRecent), depth)
    .map((node) => ({ ...node, children: pruneTree(node.children, (session) => todosOf(session.id).length > 0 || needsYou(session.activity)) }));
  const tally = (sessions: GuestSessionRecord[]): HTMLElement | null => {
    let done = 0;
    let total = 0;
    for (const session of sessions) {
      const counts = countsOf(session.id);
      done += counts.done;
      total += counts.total;
    }
    return total ? h('span', { class: 'num muted' }, `${done}/${total}`) : null;
  };
  const sectionHead = (key: string, label: string, open: boolean, right: HTMLElement | null): HTMLElement => (
    h('button', { type: 'button', class: 'ov-sec', 'aria-expanded': String(open), onClick: () => actions.setFold(key, !open) },
      h('span', { class: 'car' }, icon('caret')), label, h('span', { class: 'grow' }), right)
  );

  // Chats first.
  const chats = live.filter((session) => session.projectId === CHATS_PROJECT);
  const chatRows = treeOf(chats).flatMap((node) => rowsFor(node, 1));
  const chatsOpen = actions.isOpen('ov:chats', true);

  // Then projects, the most recently active first.
  const projects = workspace.projects.flatMap((project) => {
    const sessions = live.filter((session) => session.projectId === project.id);
    const newest = sessions.reduce((latest, session) => Math.max(latest, session.updatedAt), 0);
    const key = `ov:p:${project.id}`;
    const open = actions.isOpen(key, true);
    const rows = treeOf(sessions).flatMap((node) => rowsFor(node, 2));
    if (sessions.length === 0 || (state.overviewMode === 'open' && rows.length === 0)) return [];
    const head = treed(1, h('button', { type: 'button', class: 'proj-h', 'aria-expanded': String(open), onClick: () => actions.setFold(key, !open) },
      h('span', { class: 'car' }, icon('caret')),
      h('b', null, project.name),
      h('span', { class: 'where', title: project.directory }, project.directory),
      tally(sessions)));
    return [{ newest, nodes: [head, ...(open ? rows : [])] }];
  }).sort((left, right) => right.newest - left.newest);
  const projectsOpen = actions.isOpen('ov:projects', true);

  const nothing = chatRows.length === 0 && projects.length === 0;

  return [
    pageTop('Every session', h('span', { class: 'seg', role: 'group', 'aria-label': 'Show' }, ...([['sessions', 'Sessions'], ['open', 'Open todos']] as const).map(([mode, label]) => (
      h('button', { type: 'button', 'aria-pressed': String(state.overviewMode === mode), onClick: () => actions.setOverviewMode(mode) }, label))))),
    h('div', { class: 'attn-line' },
      waiting ? h('strong', { class: 'num' }, `${waiting} need${waiting === 1 ? 's' : ''} you`) : h('span', null, 'Nothing needs you'),
      h('span', { class: 'num' }, `${running} running`),
      quietCount ? h('span', { class: 'num' }, `${quietCount} quiet, with open todos`) : null,
      h('span', { class: 'num' }, `${chats.length} chat${chats.length === 1 ? '' : 's'}`),
      h('span', { class: 'num' }, `${projects.length} project${projects.length === 1 ? '' : 's'}`)),
    feed.settings.digest
      ? h('div', { class: 'digest' },
          h('button', { type: 'button', class: 'btn', disabled: state.digestBusy, onClick: () => void actions.digest() }, icon('spark'), state.digestBusy ? 'Asking your Small Model' : 'While you were away'),
          state.digest ? h('p', null, state.digest.replace(/\n+/g, '\n\n')) : null)
      : null,
    ...(chatRows.length > 0 ? [h('section', { class: 'proj' }, sectionHead('ov:chats', 'Chats', chatsOpen, tally(chats)), ...(chatsOpen ? chatRows : []))] : []),
    ...(projects.length > 0 ? [h('section', { class: 'proj' }, sectionHead('ov:projects', 'Projects', projectsOpen, h('span', { class: 'num muted' }, String(projects.length))), ...(projectsOpen ? projects.flatMap((project) => project.nodes) : []))] : []),
    ...(nothing ? [h('p', { class: 'empty' }, state.overviewMode === 'open' ? 'No open todos.' : 'No recent sessions.')] : []),
  ].filter((part): part is HTMLElement => part !== null);
};
