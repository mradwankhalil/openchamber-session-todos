import { connectHost } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';

import { h } from '../shared/dom.ts';
import { readOwn, ownKey, type OwnItem } from '../shared/settings.ts';
import { TIP_LABELS, readTip } from '../shared/tip.ts';
import { startApp } from './app.ts';

// One entry for every way the host loads this package: the rail panel, the
// full-screen page, a row's popover, and hidden frames for actions and /todo.

const host = connectHost();
const root = document.querySelector<HTMLElement>('#root');
if (!root) throw new Error('Missing root');

const addOwn = async (sessionId: string, text: string): Promise<void> => {
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!clean) return;
  const own: OwnItem[] = readOwn(await host.storage.get(ownKey(sessionId)));
  own.push({ id: `${Date.now().toString(36)}-${own.length}`, text: clean, done: false, at: Date.now() });
  await host.storage.set(ownKey(sessionId), own);
};

// These two must be registered before the first await.
host.onAction(async (item) => {
  if (item.kind === 'message') await addOwn(item.sessionId, item.text);
});

let currentSession: string | null = null;
host.onSession((session) => { currentSession = session?.id ?? null; });
host.onResolve(async ({ args }) => {
  if (!currentSession) throw new Error('Open a session first.');
  if (!args.trim()) throw new Error('Write the item after /todo.');
  await addOwn(currentSession, args);
  await host.toast({ kind: 'success', message: 'Added to your todos.' }).catch(() => undefined);
  return null;
});

let started = false;
host.onReady((context) => {
  applyHostReady(context, document.documentElement);
  if (context.surface === 'popover') {
    const tip = readTip(context.popover?.data);
    root.className = 'tip';
    root.replaceChildren(...(tip ? [h('div', { class: 'tip-label' }, TIP_LABELS[tip.status]), h('div', { class: 'tip-text' }, tip.text)] : []));
    return;
  }
  if (started || context.surface === 'background') return;
  started = true;
  startApp(host, root, context.surface === 'page' ? 'page' : 'panel', addOwn);
});
