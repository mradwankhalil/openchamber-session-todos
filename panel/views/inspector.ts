import { h, icon } from '../../shared/dom.ts';
import { elapsedLabel, itemHistory, splitTag, type TodoView } from '../../shared/model.ts';
import type { App } from '../app.ts';

const WORDS: Record<string, string> = {
  added: 'Added',
  started: 'Started',
  finished: 'Finished',
  cancelled: 'Cancelled',
  reopened: 'Reopened',
  gone: 'Left the list',
  returned: 'Came back',
};

const STATUS: Record<TodoView['status'], string> = {
  in_progress: 'In progress',
  pending: 'Next',
  completed: 'Done',
  cancelled: 'Cancelled',
};

export const clock = (at: number, now = Date.now()): string => {
  const date = new Date(at);
  const sameDay = date.toDateString() === new Date(now).toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
    : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
};

/** Why the list says what it says about one item, and what you can do about it. */
export const inspector = (app: Pick<App, 'state' | 'actions' | 'feed'>, view: TodoView): HTMLElement[] => {
  const { state, actions, feed } = app;
  const { tag, title } = feed.settings.tags ? splitTag(view.content) : { tag: null, title: view.content };
  const open = view.status === 'pending' || view.status === 'in_progress';
  const history = itemHistory(state.revisions, view.content);
  const spent = history.inProgressMs > 60_000 ? elapsedLabel(history.inProgressMs) : null;
  const ticking = feed.settings.ticking;

  const parts: (HTMLElement | null)[] = [
    h('h2', null, tag ? h('span', { class: 'tag' }, tag) : null, title),
    h('div', { class: 'stat' },
      h('div', null, h('b', null, STATUS[view.status]), 'Agent says'),
      spent ? h('div', null, h('b', null, spent), 'In progress for') : null,
      view.priority ? h('div', null, h('b', null, view.priority[0]?.toUpperCase() + view.priority.slice(1)), 'Priority') : null),
    view.mine ? h('div', { class: 'notice quiet' }, icon('mine'), h('span', null, 'You ticked this. The agent still lists it as open and doesn\'t know yet.')) : null,
    history.events.length > 0
      ? h('ol', { class: 'hist' }, ...history.events.map((event) => h('li', null, h('time', null, clock(event.at)), h('span', null, WORDS[event.what] ?? event.what))))
      : null,
    open && ticking
      ? h('textarea', {
          class: 'note', id: `note-${view.key}`, placeholder: 'Your note. Kept here, sent only if you choose to.', 'aria-label': 'Your note',
          onInput: (event: Event) => actions.saveNote(view.key, (event.target as HTMLTextAreaElement).value),
        }, view.note)
      : null,
    h('div', { class: 'btns' },
      open && ticking ? h('button', { type: 'button', class: 'btn', onClick: () => actions.toggleTick(view.key) }, icon(view.mine ? 'ring' : 'mine'), view.mine ? 'Untick' : 'Tick') : null,
      open ? h('button', { type: 'button', class: `btn${view.mine ? ' go' : ''}`, onClick: () => actions.tell(view) }, icon('send'), 'Tell the agent') : null,
      h('button', { type: 'button', class: 'btn', onClick: () => void actions.copy(view.content, 'Item') }, icon('copy'), 'Copy')),
  ];
  return parts.filter((node): node is HTMLElement => node !== null);
};
