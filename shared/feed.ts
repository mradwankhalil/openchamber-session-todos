import { HostRequestError, type SessionSnapshot, type connectHost } from '@openchamber/sdk';

import { isRecord, parseTodosFile, readTodos, todosForSession, type Todo } from './model.ts';
import { DEFAULTS, SETTINGS_KEY, readSettings, type Settings } from './settings.ts';

// The read loop both surfaces share. Its one promise: a list on screen is never
// blanked by a bad read. Unparseable or failed reads keep what is there.

type Host = ReturnType<typeof connectHost>;

const POLL_MS = 1500;
const SERVICE_EVERY_MS = 3000;
const SETTINGS_EVERY_MS = 3000;
// The host may restart the service, and a new one knows neither the address nor the settings.
const HELLO_EVERY_MS = 10000;
// After a session switch the host may answer a moment longer for the previous
// session's folder. "No todo list" is only believed once it has held this long.
const SETTLE_MS = 1200;
const SETTLE_RETRY_MS = 250;

export type View =
  | { kind: 'loading' }
  | { kind: 'no-session' }
  | { kind: 'list'; todos: Todo[]; source: string | null; at: number; reason?: string }
  | { kind: 'problem'; message: string };

export const service = async (host: Host, route: string, body: unknown = {}): Promise<Record<string, unknown>> => {
  const answer = await host.serviceRequest({ method: 'POST', path: route, body: JSON.stringify(body) });
  const parsed: unknown = typeof answer.body === 'string' ? JSON.parse(answer.body) : answer.body;
  if (answer.status >= 400 || !isRecord(parsed)) throw new Error(`Service answered ${answer.status}`);
  return parsed;
};

const describeProblem = (error: unknown): string => {
  const code = error instanceof HostRequestError ? error.code : '';
  if (code === 'NOT_GRANTED') return 'Session Todos needs your approval. Approve it in Settings → Extensions.';
  if (code === 'DISABLED') return 'Session Todos is paused in Settings → Extensions.';
  return `Could not read this session's todo list${code ? ` (${code})` : ''}.`;
};

export type Feed = {
  readonly session: SessionSnapshot | null;
  readonly directory: string | null;
  readonly view: View;
  readonly settings: Settings;
  /** The whole file last read: other sessions' lists, for the subagent blocks. */
  readonly file: Record<string, unknown> | null;
  readonly generation: number;
  /** True once the service has answered at least once. */
  readonly serviceUp: boolean;
  check(): Promise<void>;
  saveSettings(next: Settings): void;
  start(): void;
};

export const createFeed = (host: Host, onChange: (reason: 'view' | 'session' | 'settings') => void): Feed => {
  let session: SessionSnapshot | null = null;
  let directory: string | null = null;
  let view: View = { kind: 'loading' };
  let settings: Settings = DEFAULTS;
  let file: Record<string, unknown> | null = null;
  let stamp = '';
  let generation = 0;
  let checking = false;
  let settleUntil = 0;
  let serviceUp = false;
  let lastService = 0;
  let serviceSig = '';
  let settingsSig = '';

  const show = (next: View): void => {
    view = next;
    onChange('view');
  };

  const todosPath = (): string => `${settings.omoDir}/todos.json`;

  const hello = (): void => {
    let origin: string | null = null;
    try {
      const url = new URL(window.location.href);
      if (url.protocol === 'http:' || url.protocol === 'https:') origin = url.origin;
    } catch { /* an opaque frame: the service finds the server by itself */ }
    service(host, '/v1/hello', { origin, settings }).then(() => { serviceUp = true; }).catch(() => undefined);
  };

  // Everything other than the agent's own file, through the service.
  const askService = async (sessionId: string, mine: number): Promise<View | null> => {
    const answer = await service(host, '/v1/list', { sessionId, directory });
    serviceUp = true;
    if (mine !== generation) return null;
    if (answer.status === 'ok') return { kind: 'list', todos: readTodos(answer.todos), source: String(answer.source ?? ''), at: Number(answer.at) || 0 };
    return { kind: 'list', todos: [], source: null, at: 0, reason: typeof answer.reason === 'string' ? answer.reason : undefined };
  };

  const check = async (force = false): Promise<void> => {
    if (checking) return;
    if (!session) {
      show({ kind: 'no-session' });
      return;
    }
    const mine = generation;
    const sessionId = session.id;
    checking = true;
    try {
      let fileError: unknown = null;
      let todos: Todo[] | null = null;
      let at = 0;
      if (settings.useOmo) {
        try {
          const path = todosPath();
          const info = await host.stat(path);
          if (mine !== generation) return;
          const nextStamp = `${info.kind}:${info.size}:${info.mtime}`;
          if (nextStamp === stamp && view.kind === 'list' && view.source === 'oh-my-openagent' && !force) return;
          if (info.kind === 'file') {
            const { content } = await host.readFile(path);
            if (mine !== generation) return;
            const parsed = parseTodosFile(content);
            // Caught mid-write: keep what is on screen, the next poll reads it whole.
            if (!parsed) return;
            file = parsed;
            if (Object.hasOwn(parsed, sessionId)) {
              todos = todosForSession(parsed, sessionId);
              at = info.mtime;
              stamp = nextStamp;
            }
          }
        } catch (error) {
          fileError = error;
        }
      }
      if (todos) {
        show({ kind: 'list', todos, source: 'oh-my-openagent', at });
        return;
      }

      // Not in the agent's file here. Ask the service, at its own pace.
      if (!force && Date.now() - lastService < SERVICE_EVERY_MS && view.kind === 'list') return;
      lastService = Date.now();
      let next: View | null = null;
      try {
        next = await askService(sessionId, mine);
      } catch (error) {
        // No service: what we have stays. With nothing to show, say what went wrong.
        if (view.kind === 'list' && view.todos.length > 0) return;
        const refused = error instanceof HostRequestError && error.code === 'NOT_GRANTED';
        next = fileError || refused
          ? { kind: 'problem', message: describeProblem(fileError ?? error) }
          : { kind: 'list', todos: [], source: null, at: 0 };
      }
      if (mine !== generation || !next) return;
      if (next.kind === 'list' && next.todos.length === 0 && Date.now() < settleUntil) {
        window.setTimeout(() => void check(), SETTLE_RETRY_MS);
        return;
      }
      // A list on screen is never blanked by a source that found nothing. An agent that
      // emptied its own list answers with a real source, and that is believed.
      if (next.kind === 'list' && next.source === null && view.kind === 'list' && view.todos.length > 0) return;
      const sig = JSON.stringify(next);
      if (sig === serviceSig && view.kind === next.kind) return;
      serviceSig = sig;
      show(next);
    } finally {
      checking = false;
      // The session changed while this read was in flight: read for the new one now.
      if (mine !== generation) void check();
    }
  };

  const switched = (): void => {
    generation += 1;
    stamp = '';
    serviceSig = '';
    lastService = 0;
    settleUntil = Date.now() + SETTLE_MS;
    onChange('session');
    show(session ? { kind: 'loading' } : { kind: 'no-session' });
    void check();
  };

  const loadSettings = async (): Promise<void> => {
    try {
      const raw = await host.storage.get(SETTINGS_KEY);
      const sig = JSON.stringify(raw ?? null);
      if (sig === settingsSig) return;
      settingsSig = sig;
      settings = readSettings(raw);
      hello();
      onChange('settings');
    } catch { /* keep what we have */ }
  };

  return {
    get session() { return session; },
    get directory() { return directory; },
    get view() { return view; },
    get settings() { return settings; },
    get file() { return file; },
    get generation() { return generation; },
    get serviceUp() { return serviceUp; },
    check: () => check(true),
    saveSettings(next) {
      settings = next;
      settingsSig = JSON.stringify(next);
      void host.storage.set(SETTINGS_KEY, next).catch(() => undefined);
      hello();
      onChange('settings');
    },
    start() {
      hello();
      void loadSettings();
      host.onSession((next) => {
        const changed = (next?.id ?? null) !== (session?.id ?? null);
        session = next;
        if (changed) switched();
        else onChange('session');
      });
      host.onDirectory((next) => {
        if (next === directory) return;
        directory = next;
        switched();
      });
      // A turn that just started or ended is when the agent's list most likely moved.
      host.onSessionLifecycle(() => {
        lastService = 0;
        void check();
      });
      window.setInterval(() => {
        if (document.visibilityState !== 'hidden') void check();
      }, POLL_MS);
      window.setInterval(() => {
        if (document.visibilityState !== 'hidden') void loadSettings();
      }, SETTINGS_EVERY_MS);
      window.setInterval(hello, HELLO_EVERY_MS);
    },
  };
};
