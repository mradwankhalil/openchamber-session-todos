import { h } from '../../shared/dom.ts';
import { EMPTY_MARKS, applyMarks, countViews, groupTodos, type Revision } from '../../shared/model.ts';
import { countLabel, progressBar, todoRow } from '../../shared/rows.ts';
import type { App } from '../app.ts';
import { clock } from './inspector.ts';
import { columnHandle, pageTop, sessionIdentity } from './parts.ts';

const change = (revisions: Revision[], index: number): { added: number; dropped: number; moved: number; words: string } => {
  const current = revisions[index];
  const before = revisions[index - 1];
  if (!current) return { added: 0, dropped: 0, moved: 0, words: '' };
  if (!before) return { added: current.todos.length, dropped: 0, moved: 0, words: 'First list' };
  const was = new Map(before.todos.map((todo) => [todo.content, todo]));
  const here = new Set(current.todos.map((todo) => todo.content));
  const added = current.todos.filter((todo) => !was.has(todo.content)).length;
  const dropped = before.todos.filter((todo) => !here.has(todo.content)).length;
  const moved = current.todos.filter((todo) => was.has(todo.content) && was.get(todo.content)?.status !== todo.status);
  const started = moved.find((todo) => todo.status === 'in_progress');
  const finished = moved.filter((todo) => todo.status === 'completed').length;
  let words = 'List changed';
  if (started) words = `Started: ${started.content}`;
  else if (finished > 0) words = `${finished} finished`;
  else if (added > 0) words = 'Plan extended';
  else if (dropped > 0) words = 'Items removed';
  return { added, dropped, moved: moved.length, words };
};

export const viewHistory = (app: Pick<App, 'state' | 'actions' | 'feed'>): HTMLElement[] => {
  const { state, actions, feed } = app;
  const revisions = state.revisions;
  if (revisions.length === 0) {
    return [h('div', { class: 'p-head' },
      pageTop('History'),
      feed.session ? sessionIdentity(feed.session, actions.copy) : null,
      h('p', { class: 'empty', style: 'padding:6px 0' }, feed.settings.history
        ? 'Nothing recorded for this session yet. Each change to its list is kept from now on.'
        : 'History is off. Turn it on in Settings.'))];
  }
  const index = state.replayAt < 0 || state.replayAt >= revisions.length ? revisions.length - 1 : state.replayAt;
  const revision = revisions[index];
  if (!revision) return [];
  const views = applyMarks(revision.todos, EMPTY_MARKS, false);
  const groups = groupTodos(views);
  const ordered = [...groups.active, ...groups.pending, ...groups.completed, ...groups.cancelled];
  const first = revisions[0];
  const last = revisions[revisions.length - 1];
  return [
    h('div', { class: 'p-head' },
      pageTop('History', countLabel(countViews(views))),
      feed.session ? sessionIdentity(feed.session, actions.copy) : null,
      h('div', { class: 'p-sub' }, h('span', null, index === revisions.length - 1 ? 'Latest' : `As of ${clock(revision.at)}`), h('span', null, `${revisions.length} versions`), revision.source ? h('span', null, revision.source) : null),
      progressBar(countViews(views))),
    h('div', { class: 'scrub' },
      h('span', { class: 'num faint small' }, first ? clock(first.at) : ''),
      h('input', { type: 'range', id: 'replay', min: '0', max: String(revisions.length - 1), value: String(index), 'aria-label': 'Replay this list over time', onInput: (event: Event) => actions.setReplay(Number((event.target as HTMLInputElement).value)) }),
      h('span', { class: 'num faint small' }, last ? clock(last.at) : '')),
    h('div', { class: 'split with-side', style: `--side-w:${feed.settings.sideWidth}px` },
      h('div', { class: 'list' }, ...ordered.map((view) => todoRow(view, { oneLine: true, tags: feed.settings.tags ? 'show' : 'raw', markPriority: false }))),
      columnHandle(feed),
      h('aside', { class: 'insp side' }, ...[...revisions.keys()].reverse().slice(0, 60).map((at) => {
        const item = revisions[at];
        const diff = change(revisions, at);
        return h('button', { type: 'button', class: 'rev', 'aria-current': String(at === index), onClick: () => actions.setReplay(at) },
          h('time', null, item ? clock(item.at) : ''),
          h('span', { class: 'grow trunc', title: diff.words }, diff.words),
          h('span', { class: 'num' }, diff.added ? h('span', { class: 'd-add' }, `+${diff.added}`) : null, diff.added && diff.dropped ? ' ' : null, diff.dropped ? h('span', { class: 'd-drop' }, `−${diff.dropped}`) : null));
      }))),
  ];
};
