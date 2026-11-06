import { h, icon } from '../../shared/dom.ts';
import type { App } from '../app.ts';

// What several tabs share: the page title, the session's identity, tree indent, the column handle.

export type PageTitle = 'This session' | 'History' | 'Every session' | 'Settings';
// The same icon as the page's button in the top bar.
const PAGE_ICONS: Record<PageTitle, string> = { 'This session': 'list', History: 'history', 'Every session': 'layers', Settings: 'gear' };

export const pageTop = (title: PageTitle, right: HTMLElement | null = null): HTMLElement => (
  h('div', { class: 'page-top' }, h('h1', null, icon(PAGE_ICONS[title]), title), right)
);

const copyIcon = (copy: App['actions']['copy'], text: string, label: string): HTMLElement => (
  h('button', { type: 'button', class: 'ib tiny', title: `Copy the ${label}`, 'aria-label': `Copy the ${label}`, onClick: () => void copy(text, label) }, icon('copy'))
);

const copyBoth = (session: { id: string; title: string }): string => `Session ID: ${session.id}\nSession Name: ${session.title}`;

/** This session's name and id on one plain line, each copyable, and both at once. */
export const sessionLines = (session: { id: string; title: string }, copy: App['actions']['copy']): HTMLElement => (
  h('div', { class: 'sid' },
    h('div', { class: 'sid-line' },
      h('span', { class: 'sid-k' }, 'Session name:'), h('span', { class: 'sid-v sid-name trunc', title: session.title }, session.title), copyIcon(copy, session.title, 'session name'),
      h('span', { class: 'sid-k sid-gap' }, 'Session ID:'), h('code', { class: 'sid-v trunc' }, session.id), copyIcon(copy, session.id, 'session ID'),
      h('button', { type: 'button', class: 'sid-both', title: 'Copy the session name and ID', 'aria-label': 'Copy the session name and ID', onClick: () => void copy(copyBoth(session), 'Session ID and name') }, 'both', icon('copy'))))
);

export const sessionIdentity = (session: { id: string; title: string }, copy: App['actions']['copy']): HTMLElement => {
  const copyButton = (text: string, label: string): HTMLElement => copyIcon(copy, text, label);
  return h('dl', { class: 'ident' },
    h('dt', null, 'Session ID'),
    h('dd', null, h('code', { class: 'trunc' }, session.id), copyButton(session.id, 'session ID')),
    h('dt', null, 'Session Name'),
    h('dd', null, h('span', { class: 'ident-name trunc', title: session.title }, session.title), copyButton(session.title, 'session name')),
    h('button', { type: 'button', class: 'btn ident-both', onClick: () => void copy(copyBoth(session), 'Session ID and name') }, icon('copy'), 'Copy both'));
};

const INDENT_PX = 16;
// Under the caret of the level above: a row's padding plus half its caret.
const RAIL_START_PX = 13;

/** Vertical lines for a row `level` steps in. Rows stack with no gap, so the lines join up. */
export const rails = (level: number): HTMLElement[] => (
  Array.from({ length: Math.max(0, level) }, (_, step) => h('i', { class: 'rail', style: `left:${RAIL_START_PX + step * INDENT_PX}px` }))
);

export const indentStyle = (level: number): string => `padding-left:${Math.max(0, level) * INDENT_PX}px`;

/** Any row, placed in the tree. */
export const treed = (level: number, node: HTMLElement): HTMLElement => (
  h('div', { class: 'treed', style: indentStyle(level) }, ...rails(level), node)
);

const SIDE_MIN = 160;
const SIDE_MAX = 700;
const KEY_STEP = 16;

/** The handle between a list and its right column. The width is kept in settings. */
export const columnHandle = (feed: App['feed']): HTMLElement => {
  const bound = (width: number): number => Math.round(Math.min(SIDE_MAX, Math.max(SIDE_MIN, width)));
  const save = (width: number): void => feed.saveSettings({ ...feed.settings, sideWidth: width });
  return h('div', {
    class: 'split-h', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize the right column',
    'aria-valuemin': String(SIDE_MIN), 'aria-valuemax': String(SIDE_MAX), 'aria-valuenow': String(feed.settings.sideWidth),
    tabindex: '0', title: 'Drag to resize',
    onPointerDown: (event: PointerEvent) => {
      event.preventDefault();
      const handle = event.currentTarget as HTMLElement;
      handle.setPointerCapture(event.pointerId);
      // This handle's own split: History holds one per open timeline, and the first is the main one.
      const split = handle.closest<HTMLElement>('.split.with-side');
      const startX = event.clientX;
      const startWidth = feed.settings.sideWidth;
      let width = startWidth;
      const move = (next: PointerEvent): void => { width = bound(startWidth + startX - next.clientX); split?.style.setProperty('--side-w', `${width}px`); };
      const up = (): void => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        if (width !== startWidth) save(width);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    },
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      save(bound(feed.settings.sideWidth + (event.key === 'ArrowLeft' ? KEY_STEP : -KEY_STEP)));
    },
  });
};
