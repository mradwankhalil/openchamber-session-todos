import { h, icon } from './dom.ts';
import { elapsedLabel, findRefs, splitTag, type Counts, type Notice, type TodoView } from './model.ts';

// The vocabulary both surfaces draw with.

export const glyphName = (view: Pick<TodoView, 'status' | 'mine'>): string => {
  if (view.mine) return 'mine';
  if (view.status === 'completed') return 'check';
  if (view.status === 'cancelled') return 'cancel';
  if (view.status === 'in_progress') return 'active';
  return 'ring';
};

export const rowTone = (view: Pick<TodoView, 'status' | 'mine'>): string => {
  if (view.mine) return 'mine';
  return ({ completed: 'done', cancelled: 'cancelled', in_progress: 'active', pending: 'next' } as const)[view.status];
};

export type RowOptions = {
  oneLine?: boolean;
  twoLines?: boolean;
  threeLines?: boolean;
  /** show: as a tag. hide: drop the prefix, keep the title. raw: the agent's text as written. */
  tags: 'show' | 'hide' | 'raw';
  markPriority: boolean;
  /** No hover text on the row. */
  noHover?: boolean;
  /** `ses_…` in the text becomes a named link when this is given. */
  ref?: (id: string) => HTMLElement | null;
  meta?: string;
  selected?: boolean;
  onSelect?: () => void;
  onTick?: () => void;
};

export const todoRow = (view: TodoView, options: RowOptions): HTMLElement => {
  const { tag, title } = options.tags === 'raw' ? { tag: null, title: view.content } : splitTag(view.content);
  const refs = options.ref ? findRefs(view.content).flatMap((id) => options.ref?.(id) ?? []) : [];
  const glyph = options.onTick
    ? h('button', {
        type: 'button',
        class: 'tick',
        'aria-label': `${view.mine ? 'Remove your tick from' : 'Tick'}: ${view.content}`,
        title: view.mine ? 'Remove your tick' : 'Tick this yourself',
        onClick: (event: Event) => { event.stopPropagation(); options.onTick?.(); },
      }, icon(glyphName(view)))
    : h('span', { class: 'glyph' }, icon(glyphName(view)));
  const text = h('span', { class: 'txt' }, title);
  const body = h('span', { class: 'body' }, tag && options.tags === 'show' ? h('span', { class: 'tag' }, tag) : null, text, ...refs);
  const row = h(options.onSelect ? 'div' : 'button', {
    class: `row ${rowTone(view)}${options.oneLine ? ' one' : ''}${options.twoLines ? ' two' : ''}${options.threeLines ? ' three' : ''}`,
    ...(options.noHover ? {} : { title: view.content }),
    ...(options.onSelect
      ? { role: 'option', tabindex: '-1', 'aria-selected': options.selected ? 'true' : 'false', onClick: options.onSelect, 'data-key': view.key }
      : { type: 'button' }),
    style: `view-transition-name:todo-${view.key.replace(/[^a-z0-9]/gi, '')}`,
  }, glyph, body,
    view.mine ? h('span', { class: 'you' }, 'you') : null,
    options.markPriority && view.priority === 'high' && !view.mine && (view.status === 'pending' || view.status === 'in_progress')
      ? h('span', { class: 'prio', title: 'High priority' }, icon('flag')) : null,
    view.note ? h('span', { class: 'prio note-mark', title: 'You left a note' }, icon('note')) : null,
    options.meta ? h('span', { class: 'meta' }, options.meta) : null);
  return row;
};

export const progressBar = (counts: Counts): HTMLElement => {
  const label = `${counts.done} done, ${counts.mine} ticked by you, ${counts.active} in progress, ${counts.open} still open, of ${counts.total}`;
  const part = (cls: string, count: number): HTMLElement | null => (count > 0 ? h('i', { class: cls, style: `flex:${count} 1 0` }) : null);
  return h('div', { class: 'progress', role: 'img', 'aria-label': label, title: label },
    part('p-done', counts.done), part('p-mine', counts.mine), part('p-active', counts.active), part('p-open', counts.open));
};

export const countLabel = (counts: Counts): HTMLElement => h('span', { class: 'cnt' }, String(counts.done + counts.mine), h('small', null, `/${counts.total}`));

export const noticeLine = (notice: Notice, now: number, action?: HTMLElement | null): HTMLElement => {
  const age = notice.kind === 'attention' && notice.since > 0 ? ` · ${elapsedLabel(now - notice.since)}` : '';
  return h('div', { class: `notice ${notice.kind}` }, icon(notice.kind === 'attention' ? 'alert' : 'quiet'), h('span', { class: 'grow' }, `${notice.text}${age}`), action ?? null);
};

export const ago = (at: number, now: number): string => {
  const label = elapsedLabel(now - at);
  return label === 'now' ? 'just now' : `${label} ago`;
};
