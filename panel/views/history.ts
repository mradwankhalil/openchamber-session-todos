import { h, icon } from '../../shared/dom.ts';
import { EMPTY_MARKS, applyMarks, countViews, groupTodos, type Revision, type TodoView } from '../../shared/model.ts';
import { countLabel, progressBar, todoRow } from '../../shared/rows.ts';
import type { App } from '../app.ts';
import { clock } from './inspector.ts';
import { columnHandle, pageTop, sessionIdentity, treed } from './parts.ts';

type Ctx = Pick<App, 'state' | 'actions' | 'feed'>;

/** The open session's own timeline; subagents' are keyed by their session id. */
export const MAIN_TIMELINE = 'main';

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

// A timeline can span days, so the replay shows the date with the time.
const stamp = (at: number): string => new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

const indexOf = (revisions: Revision[], at: number | undefined): number => (at === undefined || at < 0 || at >= revisions.length ? revisions.length - 1 : at);

const viewsAt = (revisions: Revision[], index: number): TodoView[] => applyMarks(revisions[index]?.todos ?? [], EMPTY_MARKS, false);

const asOf = (revisions: Revision[], index: number): string => (index === revisions.length - 1 ? 'Latest' : `As of ${clock(revisions[index]?.at ?? 0)}`);

/** One session's recorded lists: play and scrub, the list as it was then, and every version beside it. */
const timeline = (app: Ctx, id: string, revisions: Revision[]): HTMLElement[] => {
  const { state, actions, feed } = app;
  const index = indexOf(revisions, state.replay[id]);
  const revision = revisions[index];
  if (!revision) return [];
  const groups = groupTodos(viewsAt(revisions, index));
  const ordered = [...groups.active, ...groups.pending, ...groups.completed, ...groups.cancelled];
  const first = revisions[0];
  const last = revisions[revisions.length - 1];
  const playing = state.playing === id;
  // One row open at a time: a click opens it downward, and closes whichever was open.
  const row = (view: TodoView): HTMLElement => {
    const open = state.historyOpen[id] === view.key;
    const node = todoRow(view, { oneLine: !open, noHover: open, tags: feed.settings.tags ? 'show' : 'hide', markPriority: false });
    node.setAttribute('aria-expanded', String(open));
    node.addEventListener('click', () => actions.toggleHistoryItem(id, view.key));
    return node;
  };
  return [
    h('div', { class: 'scrub' },
      h('button', {
        type: 'button', class: 'ib play', 'aria-pressed': String(playing), disabled: revisions.length < 2,
        title: playing ? 'Pause' : 'Play the timeline', 'aria-label': playing ? 'Pause' : 'Play the timeline',
        onClick: () => actions.togglePlay(id),
      }, icon(playing ? 'pause' : 'play')),
      h('span', { class: 'num faint small' }, first ? clock(first.at) : ''),
      h('input', { type: 'range', id: `replay-${id}`, min: '0', max: String(revisions.length - 1), value: String(index), 'aria-label': 'Replay this list over time', onInput: (event: Event) => actions.setReplay(id, Number((event.target as HTMLInputElement).value)) }),
      h('span', { class: 'num faint small' }, last ? clock(last.at) : '')),
    h('div', { class: 'stamp small' }, h('time', { class: 'num' }, stamp(revision.at)), h('span', { class: 'faint num' }, `Version ${index + 1} of ${revisions.length}`)),
    h('div', { class: 'split with-side', style: `--side-w:${feed.settings.sideWidth}px` },
      h('div', { class: 'list' }, ...ordered.map(row)),
      columnHandle(feed),
      h('aside', { class: 'insp side' }, ...[...revisions.keys()].reverse().slice(0, 60).map((at) => {
        const item = revisions[at];
        const diff = change(revisions, at);
        return h('button', { type: 'button', class: 'rev', 'aria-current': String(at === index), onClick: () => actions.setReplay(id, at) },
          h('time', null, item ? clock(item.at) : ''),
          h('span', { class: 'grow trunc', title: diff.words }, diff.words),
          h('span', { class: 'num' }, diff.added ? h('span', { class: 'd-add' }, `+${diff.added}`) : null, diff.added && diff.dropped ? ' ' : null, diff.dropped ? h('span', { class: 'd-drop' }, `−${diff.dropped}`) : null));
      }))),
  ];
};

/** Every subagent down to the depth setting, folded until clicked. A folded one hides its own subagents. */
const subagents = (app: Ctx): HTMLElement[] => {
  const { state, actions } = app;
  if (state.children.length === 0) return [];
  const out: HTMLElement[] = [h('div', { class: 'ghead g-sub' }, h('span', { class: 'car' }, icon('tree')), 'Subagents', h('span', { class: 'n' }, String(state.children.length)))];
  let hideBelow = Infinity;
  for (const child of state.children) {
    if (child.depth > hideBelow) continue;
    hideBelow = Infinity;
    const open = state.historyChildren[child.id] === true;
    if (!open) hideBelow = child.depth;
    const revisions = state.childRevisions[child.id] ?? [];
    const index = indexOf(revisions, state.replay[child.id]);
    const counts = countViews(revisions.length > 0 ? viewsAt(revisions, index) : child.todos);
    out.push(treed(child.depth, h('button', { type: 'button', class: 'subhead', 'aria-expanded': String(open), title: child.depth > 1 ? `Level ${child.depth} subagent` : undefined, onClick: () => actions.toggleHistoryChild(child.id) },
      h('span', { class: 'car' }, icon('caret')), h('span', { class: `dot ${child.activity}`, title: child.activity }), h('span', { class: 'grow trunc', title: child.title }, child.title),
      child.agent ? h('span', { class: 'muted small' }, child.agent) : null,
      h('span', { class: 'faint small num' }, `${revisions.length} version${revisions.length === 1 ? '' : 's'}`),
      counts.total > 0 ? h('span', { class: 'mini' }, progressBar(counts)) : null,
      counts.total > 0 ? h('span', { class: 'num small sub-n' }, `${counts.done}/${counts.total}`) : null)));
    if (!open) continue;
    const source = revisions[index]?.source;
    out.push(treed(child.depth + 1, h('div', { class: 'hist-child' },
      sessionIdentity(child, actions.copy),
      h('div', { class: 'p-sub' },
        revisions.length > 0 ? h('span', null, asOf(revisions, index)) : null,
        h('span', null, `${revisions.length} version${revisions.length === 1 ? '' : 's'}`),
        source ? h('span', null, source) : null,
        h('button', { type: 'button', class: 'ref', style: 'margin:0', onClick: () => actions.openSession(child.id) }, 'Open this session')),
      ...(revisions.length > 0
        ? [progressBar(counts), ...timeline(app, child.id, revisions)]
        : [h('p', { class: 'empty small' }, 'Nothing recorded for this subagent yet. Its list is kept from the first time this panel reads it.')]))));
  }
  return out;
};

export const viewHistory = (app: Ctx): HTMLElement[] => {
  const { state, actions, feed } = app;
  const revisions = state.revisions;
  if (revisions.length === 0) {
    return [h('div', { class: 'p-head' },
      pageTop('History'),
      feed.session ? sessionIdentity(feed.session, actions.copy) : null,
      h('p', { class: 'empty', style: 'padding:6px 0' }, feed.settings.history
        ? 'Nothing recorded for this session yet. Each change to its list is kept from now on.'
        : 'History is off. Turn it on in Settings.')),
    ...subagents(app)];
  }
  const index = indexOf(revisions, state.replay[MAIN_TIMELINE]);
  const revision = revisions[index];
  if (!revision) return [];
  const counts = countViews(viewsAt(revisions, index));
  return [
    h('div', { class: 'p-head' },
      pageTop('History', countLabel(counts)),
      feed.session ? sessionIdentity(feed.session, actions.copy) : null,
      h('div', { class: 'p-sub' }, h('span', null, asOf(revisions, index)), h('span', null, `${revisions.length} versions`), revision.source ? h('span', null, revision.source) : null),
      progressBar(counts)),
    ...timeline(app, MAIN_TIMELINE, revisions),
    ...subagents(app),
  ];
};
