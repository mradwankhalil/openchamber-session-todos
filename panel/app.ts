import { version } from '../package.json';
import type { GuestSessionRecord, connectHost } from '@openchamber/sdk';

import { h, icon } from '../shared/dom.ts';
import { createFeed, service } from '../shared/feed.ts';
import {
  EMPTY_MARKS,
  applyMarks,
  countViews,
  descendants,
  droppedItems,
  filterViews,
  subagentSections,
  subagentsFor,
  groupTodos,
  isRecord,
  liveFamilies,
  looseSession,
  mixedPriorities,
  pathProjectId,
  projectForFolder,
  pruneMarks,
  quietNotice,
  readBacklog,
  readPlan,
  readMarks,
  readTodos,
  resolveDepth,
  sessionState,
  toMarkdown,
  type BacklogItem,
  type PlanStep,
  type SessionPlan,
  type DroppedItem,
  type Filter,
  type Marks,
  type Revision,
  type SessionState,
  type Todo,
  type TodoView,
} from '../shared/model.ts';
import { ago, countLabel, noticeLine, progressBar, todoRow } from '../shared/rows.ts';
import { SETUP_KEY, applySettings, foldsKey, marksKey, ownKey, readFolds, readOwn, type Folds, type OwnItem } from '../shared/settings.ts';
import { createWorkspace } from '../shared/workspace.ts';
import { MAIN_TIMELINE, viewHistory } from './views/history.ts';
import { inspector } from './views/inspector.ts';
import { viewOverview, type Lists } from './views/overview.ts';
import { columnHandle, pageTop, sessionLines, treed } from './views/parts.ts';
import { viewSettings } from './views/settings.ts';
import { viewSetup, type Report } from './views/setup.ts';

export type Host = ReturnType<typeof connectHost>;
export type Tab = 'list' | 'history' | 'overview' | 'settings' | 'setup';

// Everything the views read and do. They draw; this file owns state and storage.
export type App = ReturnType<typeof createApp>;

const SUBAGENTS_EVERY_MS = 5000;
const OVERVIEW_EVERY_MS = 5000;
const LISTS_AT_A_TIME = 60;
const PLAY_EVERY_MS = 1000;

// Every session opens the same way each time: its folds last only while the frame is open.
const kept = (folds: Folds): Folds => Object.fromEntries(Object.entries(folds).filter(([key]) => !key.startsWith('ov:')));

const createApp = (host: Host, root: HTMLElement, surface: 'panel' | 'page', addOwn: (sessionId: string, text: string) => Promise<void>) => {
  const state = {
    tab: (surface === 'page' ? 'overview' : 'list') as Tab,
    filter: 'all' as Filter,
    query: '',
    selected: null as string | null,
    marks: EMPTY_MARKS as Marks,
    folds: {} as Folds,
    own: [] as OwnItem[],
    revisions: [] as Revision[],
    // Per timeline: where the replay stands (missing: the latest) and which row is open.
    replay: {} as Record<string, number>,
    historyOpen: {} as Record<string, string>,
    playing: null as string | null,
    childRevisions: {} as Record<string, Revision[]>,
    historyChildren: {} as Record<string, boolean>,
    backlog: [] as BacklogItem[],
    plan: null as SessionPlan | null,
    backlogShown: null as string | null,
    children: [] as { id: string; title: string; agent: string; activity: string; updatedAt: number; depth: number; todos: TodoView[] }[],
    configuredDepth: null as number | null,
    otherSessions: [] as GuestSessionRecord[],
    ownState: null as SessionState | null,
    lists: {} as Lists,
    overviewMode: 'sessions' as 'sessions' | 'open',
    report: null as Report | null,
    reportError: '',
    setupAgree: false,
    wantNative: false,
    needsRestart: false,
    restartEverywhere: false,
    setupResult: null as Record<string, unknown> | null,
    digest: null as string | null,
    digestBusy: false,
    status: '',
  };

  const foldKey = foldsKey(surface);
  let statusTimer = 0;
  let lastSession: string | null = null;
  let renderSig = '';
  let overviewBusy = false;
  let playTimer = 0;
  const listsRead = new Map<string, number>();

  const feed = createFeed(host, (reason) => {
    if (reason === 'session') resetForSession();
    if (reason === 'settings') applySettings(feed.settings);
    if (reason === 'view') onView();
    render(reason !== 'view');
  });
  const workspace = createWorkspace(host, () => render());

  const say = (message: string): void => {
    state.status = message;
    window.clearTimeout(statusTimer);
    statusTimer = window.setTimeout(() => { state.status = ''; render(true); }, 4000);
    render(true);
  };

  const resetForSession = (): void => {
    const id = feed.session?.id ?? null;
    if (id === lastSession) return;
    lastSession = id;
    state.selected = null;
    stopPlay();
    state.replay = {};
    state.historyOpen = {};
    state.childRevisions = {};
    state.historyChildren = {};
    state.backlogShown = null;
    state.plan = null;
    state.query = '';
    state.marks = EMPTY_MARKS;
    state.own = [];
    state.revisions = [];
    state.children = [];
    state.backlog = [];
    state.ownState = null;
    void loadSessionData();
  };

  const loadSessionData = async (): Promise<void> => {
    const id = feed.session?.id;
    if (!id) return;
    try {
      const [marks, own] = await Promise.all([host.storage.get(marksKey(id)), host.storage.get(ownKey(id))]);
      if (feed.session?.id !== id) return;
      state.marks = readMarks(marks);
      state.own = readOwn(own);
      render(true);
    } catch { /* keep the empty defaults */ }
    void loadHistory();
    void loadChildren();
  };

  const loadHistory = async (): Promise<void> => {
    const id = feed.session?.id;
    if (!id) return;
    try {
      const answer = await service(host, '/v1/history', { sessionId: id });
      if (feed.session?.id !== id || !Array.isArray(answer.revisions)) return;
      state.revisions = readRevisions(answer.revisions);
      render();
    } catch { /* no service: no history */ }
  };

  const readRevisions = (raw: unknown[]): Revision[] => raw.flatMap((entry) => (
    isRecord(entry) && typeof entry.at === 'number' ? [{ at: entry.at, source: String(entry.source ?? ''), todos: readTodos(entry.todos) }] : []
  ));

  // The service keeps a subagent's history from the first time its list is read, as the list view does every few seconds.
  const loadChildHistories = async (): Promise<void> => {
    const id = feed.session?.id;
    if (!id || state.tab !== 'history' || state.children.length === 0) return;
    const next: Record<string, Revision[]> = {};
    await Promise.all(state.children.map(async (child) => {
      const answer = await service(host, '/v1/history', { sessionId: child.id }).catch(() => null);
      if (answer && Array.isArray(answer.revisions)) next[child.id] = readRevisions(answer.revisions);
    }));
    if (feed.session?.id !== id) return;
    state.childRevisions = next;
    render();
  };

  const revisionsOf = (id: string): Revision[] => (id === MAIN_TIMELINE ? state.revisions : state.childRevisions[id] ?? []);

  function stopPlay(): void {
    window.clearInterval(playTimer);
    playTimer = 0;
    state.playing = null;
  }

  const loadChildren = async (): Promise<void> => {
    const id = feed.session?.id;
    if (!id) return;
    try {
      await loadOtherSessions();
      const links = await service(host, '/v1/children', { sessionId: id, directory: feed.directory }).catch(() => ({} as Record<string, unknown>));
      if (typeof links.depth === 'number') state.configuredDepth = links.depth;
      // Two records of who started whom: the agent's file and the host's. Together they cover both worlds.
      const parents: Record<string, unknown> = { ...(isRecord(links.parents) ? links.parents : {}) };
      for (const session of [...workspace.sessions, ...state.otherSessions]) if (session.parentId) parents[session.id] = session.parentId;
      const tree = descendants(id, parents, resolveDepth(feed.settings.subagentDepth, state.configuredDepth));
      const depthOf = new Map(tree.map((item) => [item.id, item.depth]));
      const ids = tree.map((item) => item.id);
      if (ids.length === 0) {
        if (state.children.length > 0) { state.children = []; render(); }
        return;
      }
      const answer = await service(host, '/v1/lists', {
        sessions: ids.map((child) => ({ id: child, directory: (workspace.byId(child) ?? state.otherSessions.find((other) => other.id === child))?.directory ?? feed.directory })),
        titles: true,
      });
      if (feed.session?.id !== id || !isRecord(answer.lists)) return;
      const lists = answer.lists;
      const everyone = ids.map((child) => {
        const entry = lists[child];
        const todos = isRecord(entry) && entry.status === 'ok' ? readTodos(entry.todos) : [];
        const record = workspace.byId(child) ?? state.otherSessions.find((other) => other.id === child);
        const title = record?.title || (isRecord(entry) && typeof entry.title === 'string' && entry.title) || todos[0]?.content || child;
        return { id: child, title, agent: isRecord(entry) && typeof entry.agent === 'string' ? entry.agent : '', activity: record?.activity ?? 'unknown', updatedAt: Math.max(record?.updatedAt ?? 0, isRecord(entry) && typeof entry.at === 'number' ? entry.at : 0), depth: depthOf.get(child) ?? 1, todos: applyMarks(todos, EMPTY_MARKS, false) };
      });
      // Parents come before children, so from the end: keep a list, and whoever leads to one.
      const kept: typeof everyone = [];
      for (const child of [...everyone].reverse()) {
        const leads = (kept[0]?.depth ?? 0) > child.depth;
        if (child.todos.length > 0 || leads) kept.unshift(child);
      }
      state.children = kept;
      render();
    } catch { /* subagent lists are an addition; the session's own list is untouched */ }
  };

  const loadBacklog = async (): Promise<void> => {
    const id = feed.session?.id;
    if (!id) return;
    const projectId = workspace.byId(id)?.projectId ?? (feed.directory ? pathProjectId(feed.directory) : undefined);
    if (!projectId) return;
    try {
      const answer = await service(host, '/v1/backlog', { projectId });
      if (feed.session?.id !== id) return;
      state.backlog = readBacklog(answer);
      render();
    } catch { /* an addition; the session's own list is untouched */ }
  };

  const loadPlan = async (): Promise<void> => {
    const id = feed.session?.id;
    if (!id) return;
    const projectId = workspace.byId(id)?.projectId ?? (feed.directory ? pathProjectId(feed.directory) : undefined);
    if (!projectId) return;
    try {
      const answer = await service(host, '/v1/plan', { projectId, sessionId: id });
      if (feed.session?.id !== id) return;
      state.plan = readPlan(answer);
      render();
    } catch { /* an addition; the session's own list is untouched */ }
  };

  // A chat isn't in any project the host lists, so its state comes from the service.
  const loadOwnState = async (): Promise<void> => {
    const id = feed.session?.id;
    if (!id || workspace.byId(id)) return;
    const answer = await service(host, '/v1/session', { sessionId: id, directory: feed.directory }).catch(() => null);
    if (feed.session?.id === id && answer) { state.ownState = sessionState(answer.session); render(); }
  };

  const onView = (): void => {
    const view = feed.view;
    if (view.kind !== 'list') return;
    // Only a confirmed list may forget marks; the model refuses an empty one.
    if (feed.settings.ticking) {
      const next = pruneMarks(state.marks, view.todos);
      if (next !== state.marks) {
        state.marks = next;
        if (feed.session) void host.storage.set(marksKey(feed.session.id), next).catch(() => undefined);
      }
    }
    if (feed.settings.badge) {
      const open = view.todos.filter((todo) => todo.status === 'pending' || todo.status === 'in_progress').length;
      void host.setBadge(open || null).catch(() => undefined);
    }
    void loadHistory();
  };

  const views = (): TodoView[] => (feed.view.kind === 'list' ? applyMarks(feed.view.todos, state.marks, feed.settings.ticking) : []);

  const dropped = (): DroppedItem[] => (feed.view.kind === 'list' ? droppedItems(state.revisions, feed.view.todos) : []);

  const notice = () => {
    const id = feed.session?.id;
    const record = id ? workspace.byId(id) : undefined;
    const known = record ?? state.ownState;
    if (!known) return null;
    const counts = countViews(views());
    return quietNotice({ activity: known.activity, updatedAt: known.updatedAt, open: counts.open, active: counts.active, thresholdMin: feed.settings.quietMinutes, now: Date.now() });
  };

  const actions = {
    go(tab: Tab) {
      if (tab !== 'history') stopPlay();
      state.tab = tab;
      render(true);
      if (tab === 'overview') void refreshOverview();
      if (tab === 'history') void loadChildHistories();
    },
    setFilter(filter: Filter) { state.filter = filter; render(true, true); },
    setQuery(query: string) { state.query = query; render(true); },
    select(key: string) { state.selected = state.selected === key ? null : key; render(true); },
    setFold(key: string, open: boolean) {
      state.folds = { ...state.folds, [key]: open };
      if (!key.startsWith('ov:')) void host.storage.set(foldKey, kept(state.folds)).catch(() => undefined);
      render(true, true);
    },
    isOpen: (key: string, fallback: boolean): boolean => state.folds[key] ?? fallback,
    toggleTick(key: string) {
      const id = feed.session?.id;
      if (!id) return;
      const ticks = { ...state.marks.ticks };
      if (Object.hasOwn(ticks, key)) delete ticks[key];
      else ticks[key] = Date.now();
      state.marks = { ...state.marks, ticks };
      void host.storage.set(marksKey(id), state.marks).catch(() => say('Could not save your tick.'));
      render(true, true);
    },
    saveNote(key: string, text: string) {
      const id = feed.session?.id;
      if (!id) return;
      const notes = { ...state.marks.notes };
      if (text.trim()) notes[key] = text;
      else delete notes[key];
      state.marks = { ...state.marks, notes };
      void host.storage.set(marksKey(id), state.marks).catch(() => say('Could not save your note.'));
    },
    clearTicks() {
      const id = feed.session?.id;
      if (!id) return;
      state.marks = EMPTY_MARKS;
      void host.storage.delete(marksKey(id)).catch(() => undefined);
      say('Your ticks and notes for this session are cleared.');
    },
    async compose(text: string) {
      try {
        await host.compose({ text, mode: 'append' });
        say('Put in the message box. Nothing has been sent.');
      } catch (error) {
        say(`Could not reach the message box: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
    },
    tell(view: TodoView) {
      const note = view.note ? ` ${view.note}` : '';
      void actions.compose(`I finished this myself: "${view.content}".${note} Please update your todo list.`);
    },
    askWhy(item: DroppedItem) {
      void actions.compose(`"${item.content}" left your todo list without a mention. Was that deliberate?`);
    },
    async copy(text: string, label: string) {
      try {
        await host.writeClipboard(text.slice(0, 32000));
        say(`${label} copied.`);
      } catch {
        say('Could not copy.');
      }
    },
    copyMarkdown() {
      const title = feed.session?.title ?? 'Todos';
      void actions.copy(toMarkdown(title, views(), state.children.map((child) => ({ title: child.title, todos: child.todos }))), 'List');
    },
    openSession(id: string) {
      host.openSession(id).catch(() => say('Could not open that session.'));
    },
    async addOwnItem(text: string) {
      const id = feed.session?.id;
      if (!id || !text.trim()) return;
      await addOwn(id, text).catch(() => say('Could not save it.'));
      state.own = readOwn(await host.storage.get(ownKey(id)).catch(() => state.own));
      render(true);
    },
    saveOwn(next: OwnItem[]) {
      const id = feed.session?.id;
      if (!id) return;
      state.own = next;
      void host.storage.set(ownKey(id), next).catch(() => say('Could not save it.'));
      render(true, true);
    },
    setReplay(id: string, index: number) {
      if (state.playing === id) stopPlay();
      state.replay = { ...state.replay, [id]: index };
      render(true, true);
    },
    toggleHistoryItem(id: string, key: string) {
      const next = { ...state.historyOpen };
      if (next[id] === key) delete next[id];
      else next[id] = key;
      state.historyOpen = next;
      render(true);
    },
    toggleHistoryChild(id: string) {
      const open = state.historyChildren[id] !== true;
      if (!open && state.playing === id) stopPlay();
      state.historyChildren = { ...state.historyChildren, [id]: open };
      render(true);
    },
    // One timeline plays at a time, a version a second, and stops on the latest.
    togglePlay(id: string) {
      if (state.playing === id) { stopPlay(); render(true); return; }
      stopPlay();
      const total = revisionsOf(id).length;
      if (total < 2) return;
      const at = state.replay[id];
      // From the start, unless it was paused partway.
      if (at === undefined || at < 0 || at >= total - 1) state.replay = { ...state.replay, [id]: 0 };
      state.playing = id;
      playTimer = window.setInterval(() => {
        const count = revisionsOf(id).length;
        const next = (state.replay[id] ?? 0) + 1;
        if (state.playing !== id) return;
        if (next >= count - 1) {
          const { [id]: _done, ...rest } = state.replay;
          state.replay = rest;
          stopPlay();
        } else {
          state.replay = { ...state.replay, [id]: next };
        }
        render(true);
      }, PLAY_EVERY_MS);
      render(true);
    },
    toggleBacklogItem(id: string) { state.backlogShown = state.backlogShown === id ? null : id; render(true); },
    openBacklog() {
      host.openSurface('notes').catch((error: unknown) => say(`Could not open Project knowledge: ${error instanceof Error ? error.message : 'unknown error'}`));
    },
    setOverviewMode(mode: 'sessions' | 'open') { state.overviewMode = mode; render(true); },
    async runSetupCheck() {
      await loadOtherSessions();
      try {
        const answer = await service(host, '/v1/report', { sessionId: feed.session?.id ?? null, directory: feed.directory });
        state.report = answer as unknown as Report;
        state.reportError = '';
      } catch (error) {
        state.reportError = error instanceof Error ? error.message : 'The local service did not answer.';
      }
      render(true);
    },
    setAgree(value: boolean) { state.setupAgree = value; render(true); },
    setWantNative(value: boolean) { state.wantNative = value; render(true); },
    async enableTodo() {
      // With oh-my-openagent loaded the switch is for this folder only. Either way nothing reloads here.
      const folder = state.wantNative ? feed.directory : null;
      const answer: Record<string, unknown> = await service(host, '/v1/enable-todo', { reload: false, directory: folder }).catch((error: unknown) => ({ ok: false, reason: error instanceof Error ? error.message : 'The service did not answer.' }));
      state.setupResult = answer;
      if (answer.ok === true && folder) {
        feed.saveSettings({ ...feed.settings, nativeFolders: { ...feed.settings.nativeFolders, [folder]: Date.now() } });
        state.wantNative = false;
        state.setupAgree = false;
      }
      if (answer.ok === true && answer.changed === true) state.needsRestart = true;
      await actions.runSetupCheck();
    },
    // A folder's own switch reloads that folder. The redirect is for every folder.
    reloadFolder: (): string | null => (!state.restartEverywhere && feed.settings.nativeFolders[feed.directory ?? ''] !== undefined ? feed.directory : null),
    agentsBusy: (): boolean => {
      const folder = actions.reloadFolder();
      return [...workspace.sessions, ...state.otherSessions].some((session) => (session.activity === 'running' || session.activity === 'retrying') && (!folder || session.directory === folder));
    },
    async applyNow() {
      // Reloading under a running agent can take tools from it, so check again right now.
      await loadOtherSessions();
      if (actions.agentsBusy()) {
        say('An agent started working. It will apply at the next restart, or try again when it finishes.');
        return;
      }
      const folder = actions.reloadFolder();
      const answer = await service(host, '/v1/reload', { directory: folder }).catch(() => ({ ok: false }));
      if (answer.ok === true) { state.needsRestart = false; state.restartEverywhere = false; }
      else say('OpenCode did not reload. It will still apply when OpenChamber restarts.');
      await actions.runSetupCheck();
    },
    async setRedirect(on: boolean) {
      const answer: Record<string, unknown> = await service(host, '/v1/redirect', { on }).catch((error: unknown) => ({ ok: false, reason: error instanceof Error ? error.message : 'The service did not answer.' }));
      if (answer.ok !== true) say(String(answer.reason));
      if (answer.ok === true && answer.changed === true) {
        state.needsRestart = true;
        state.restartEverywhere = true;
      }
      await actions.runSetupCheck();
    },
    async stopNative() {
      const folder = feed.directory;
      if (!folder) return;
      const answer: Record<string, unknown> = await service(host, '/v1/enable-todo', { reload: false, directory: folder, value: false }).catch((error: unknown) => ({ ok: false, reason: error instanceof Error ? error.message : 'The service did not answer.' }));
      state.setupResult = answer.ok === true ? null : answer;
      if (answer.ok === true) {
        const { [folder]: _gone, ...rest } = feed.settings.nativeFolders;
        feed.saveSettings({ ...feed.settings, nativeFolders: rest });
        state.needsRestart = answer.changed === true;
      }
      await actions.runSetupCheck();
    },
    async finishSetup() {
      await host.storage.set(SETUP_KEY, true).catch(() => undefined);
      state.tab = surface === 'page' ? 'overview' : 'list';
      render(true);
    },
    async digest() {
      if (state.digestBusy) return;
      state.digestBusy = true;
      render(true);
      const summary = Object.entries(state.lists).map(([id, list]) => {
        const session = workspace.byId(id) ?? state.otherSessions.find((other) => other.id === id);
        return `${session?.title ?? id} (${session?.activity ?? 'unknown'}): ${list.todos.map((todo) => `[${todo.status}] ${todo.content}`).join('; ')}`;
      }).join('\n').slice(0, 60000);
      try {
        const result = await host.generate({
          system: DIGEST_SYSTEM,
          prompt: `Sessions and their todo lists:\n${summary}`,
          maxOutputTokens: 400,
        });
        state.digest = result.text;
      } catch (error) {
        state.digest = `No digest: ${error instanceof Error ? error.message : 'the Small Model did not answer.'}`;
      }
      state.digestBusy = false;
      render(true);
    },
    exportAll() {
      const data = { settings: feed.settings, session: feed.session, todos: views(), own: state.own, revisions: state.revisions };
      service(host, '/v1/export', { data })
        .then((answer) => say(`Saved to ${String(answer.path)}`))
        .catch(() => void actions.copy(JSON.stringify(data, null, 2), 'Export'));
    },
    moveSelection(step: number) {
      const list = selectable();
      if (list.length === 0) return;
      const index = list.findIndex((view) => view.key === state.selected);
      const next = list[Math.max(0, Math.min(list.length - 1, index + step))] ?? list[0];
      if (next) { state.selected = next.key; render(true); }
    },
    tickSelected() {
      const view = views().find((item) => item.key === state.selected);
      if (feed.settings.ticking && view && (view.status === 'pending' || view.status === 'in_progress')) actions.toggleTick(view.key);
    },
    tellSelected() {
      const view = views().find((item) => item.key === state.selected);
      if (view && (view.status === 'pending' || view.status === 'in_progress')) actions.tell(view);
    },
  };

  const selectable = (): TodoView[] => {
    const groups = groupTodos(filterViews(views(), state.filter, state.query));
    const list = [...groups.active];
    if (actions.isOpen('pending', true)) list.push(...groups.pending);
    if (actions.isOpen('completed', false)) list.push(...groups.completed);
    if (actions.isOpen('cancelled', false)) list.push(...groups.cancelled);
    return list;
  };

  const ctx = { host, feed, workspace, state, actions, surface, views, dropped };

  // ----- The list view -----

  const refButton = (id: string): HTMLElement => {
    const title = workspace.byId(id)?.title ?? id.slice(0, 12);
    return h('button', { type: 'button', class: 'ref trunc', title: `Open ${id}`, onClick: (event: Event) => { event.stopPropagation(); actions.openSession(id); } }, title);
  };

  // A section of this page: a box whose title folds it. Open until the user folds it.
  const sectionBox = (key: string, title: string, count: number | null, body: HTMLElement[]): HTMLElement => {
    const open = actions.isOpen(key, true);
    return h('section', { class: 'sbox' },
      h('button', { type: 'button', class: 'sbox-head', 'aria-expanded': String(open), onClick: () => actions.setFold(key, !open) },
        h('span', { class: 'car' }, icon('caret')), h('span', { class: 'sbox-title' }, title), count !== null ? h('span', { class: 'n' }, String(count)) : null),
      ...(open ? [h('div', { class: 'sbox-body' }, ...body)] : []));
  };

  // A phase's short name: the part before its first ": ". The whole text is its hover text.
  const stepLabel = (text: string): string => {
    const cut = text.indexOf(': ');
    return cut >= 3 ? text.slice(0, cut) : text;
  };
  const PLAN_INDENT_PX = 22;

  // The plan this session works on, from Project knowledge, with its steps.
  // Phases with work left start unfolded and finished ones folded.
  const planBody = (plan: SessionPlan): HTMLElement[] => {
    const step = (item: PlanStep, path: string, level: number): HTMLElement[] => {
      const key = `plan:${plan.id}:${path}`;
      const nested = item.steps.length > 0;
      const open = nested && actions.isOpen(key, !item.done);
      const parts = [
        h('span', { class: 'car' }, nested ? icon('caret') : null),
        h('span', { class: 'pbox', role: 'img', 'aria-label': item.done ? 'Done' : 'Not done' }),
        h('span', { class: 'grow trunc' }, level === 0 ? stepLabel(item.text) : item.text),
        nested ? h('span', { class: 'num small' }, `${item.steps.filter((child) => child.done).length}/${item.steps.length}`) : null,
      ];
      const props = { class: `pstep${item.done ? ' done' : ''}${level > 0 ? ' sub' : ''}`, style: `padding-left:${6 + level * PLAN_INDENT_PX}px`, title: item.text };
      const line = nested
        ? h('button', { ...props, type: 'button', 'aria-expanded': String(open), onClick: () => actions.setFold(key, !open) }, ...parts)
        : h('div', props, ...parts);
      return [line, ...(open ? item.steps.flatMap((child, index) => step(child, `${path}.${index}`, level + 1)) : [])];
    };
    return [
      h('div', { class: 'plan-top' },
        h('button', { type: 'button', class: 'ref trunc plan-title', title: `${plan.title}: open Project knowledge`, onClick: () => actions.openBacklog() }, plan.title)),
      planLine(plan),
      ...(plan.steps.length > 0 ? [h('div', { class: 'psteps' }, ...plan.steps.flatMap((item, index) => step(item, String(index), 0)))] : []),
    ];
  };

  const planLine = (plan: SessionPlan): HTMLElement => h('div', { class: 'plan-line' },
    plan.total > 0 ? h('span', { class: 'plan-bar', role: 'progressbar', 'aria-label': 'Plan steps done', 'aria-valuemin': '0', 'aria-valuemax': String(plan.total), 'aria-valuenow': String(plan.done) }, h('i', { style: `width:${Math.round((plan.done / plan.total) * 100)}%` })) : null,
    plan.total > 0 ? h('span', { class: 'num' }, `${plan.done}/${plan.total}`) : null,
    h('span', { class: 'plan-how', title: plan.how === 'linked' ? 'OpenChamber sent this plan to this session.' : 'No session is linked to this plan in OpenChamber; this is the top-level session that last edited its file.' }, plan.how === 'linked' ? 'sent to this session' : `last edited here${plan.at ? ` ${ago(plan.at, Date.now())}` : ''}`));

  const listView = (): HTMLElement[] => {
    const settings = feed.settings;
    const all = views();
    const session = feed.session;
    const view = feed.view;
    if (!session || view.kind === 'no-session') return [pageTop('This session'), h('p', { class: 'empty', style: 'padding:14px 0' }, 'Open a session to see its todo list.')];
    if (view.kind === 'loading') return [pageTop('This session'), h('p', { class: 'empty', style: 'padding:14px 0' }, 'Reading this session.')];

    const counts = countViews(all);
    const record = workspace.byId(session.id);
    const project = record ? workspace.projects.find((item) => item.id === record.projectId)?.name : null;
    const live = notice();
    const head = h('div', { class: 'p-head' },
      pageTop('This session', all.length ? countLabel(counts) : null),
      h('div', { class: 'p-sub' },
        session.agent ? h('span', null, session.agent) : null,
        project ? h('span', null, project) : null,
        view.kind === 'list' && view.at > 0 ? h('span', null, `updated ${ago(view.at, Date.now())}`) : null,
        view.kind === 'list' && view.source ? h('button', { type: 'button', class: 'ref', style: 'margin:0', title: 'Where this list comes from', onClick: () => actions.go('settings') }, view.source) : null),
      all.length ? progressBar(counts) : null,
      live ? noticeLine(live, Date.now()) : null);

    if (view.kind === 'problem') return [head, sessionLines(session, actions.copy), h('p', { class: 'empty problem', style: 'padding:0 0 14px' }, view.message)];

    const markPriority = settings.priority && mixedPriorities(all);
    const filtered = filterViews(all, state.filter, state.query);
    const groups = groupTodos(filtered);

    const row = (item: TodoView): (HTMLElement)[] => {
      const open = item.status === 'pending' || item.status === 'in_progress';
      const node = todoRow(item, {
        tags: settings.tags ? 'show' : 'hide',
        markPriority,
        threeLines: true,
        selected: state.selected === item.key,
        onSelect: () => actions.select(item.key),
        ...(settings.refs ? { ref: refButton } : {}),
        ...(settings.ticking && open ? { onTick: () => actions.toggleTick(item.key) } : {}),
      });
      return state.selected === item.key ? [node, h('div', { class: 'insp inline' }, ...inspector(ctx, item))] : [node];
    };
    const fold = (key: string, label: string, cls: string, items: TodoView[], fallback: boolean): HTMLElement[] => {
      if (items.length === 0) return [];
      const open = actions.isOpen(key, fallback);
      return [
        h('button', { type: 'button', class: `ghead ${cls}`, 'aria-expanded': String(open), onClick: () => actions.setFold(key, !open) }, h('span', { class: 'car' }, icon('caret')), label, h('span', { class: 'n' }, String(items.length))),
        ...(open ? [h('div', { class: 'gitems' }, ...items.flatMap(row))] : []),
      ];
    };

    const list: HTMLElement[] = [];
    if (all.length === 0) list.push(h('p', { class: 'empty' }, view.reason ?? 'No todo list in this session.'));
    else if (filtered.length === 0) {
      list.push(h('p', { class: 'empty' }, 'Nothing matches. ', h('button', { type: 'button', class: 'ref', style: 'margin:0', onClick: () => { state.query = ''; state.filter = 'all'; render(true); } }, 'Clear the filter')));
    }
    if (groups.active.length > 0) {
      list.push(h('div', { class: 'ghead g-active' }, h('span', { class: 'car' }), 'In progress', h('span', { class: 'n' }, String(groups.active.length))), h('div', { class: 'gitems' }, ...groups.active.flatMap(row)));
    }
    list.push(...fold('pending', 'Next', 'g-next', groups.pending, true));
    list.push(...fold('completed', 'Done', 'g-done', groups.completed, false));
    list.push(...fold('cancelled', 'Cancelled', '', groups.cancelled, false));

    const gone = state.filter === 'done' ? [] : dropped().filter((item) => !state.query || item.content.toLowerCase().includes(state.query.toLowerCase()));
    if (gone.length > 0) {
      // Under Open it is one line: these items are not open work, but losing them is worth a look.
      const foldKey = state.filter === 'open' ? 'dropped-open' : 'dropped';
      const open = actions.isOpen(foldKey, state.filter !== 'open');
      list.push(h('button', { type: 'button', class: 'ghead g-attn', 'aria-expanded': String(open), title: 'Items the agent had open that left its list', onClick: () => actions.setFold(foldKey, !open) }, h('span', { class: 'car' }, icon('caret')), 'Dropped without a word', h('span', { class: 'n' }, String(gone.length))));
      if (open) {
        list.push(h('div', { class: 'gitems' }, ...gone.map((item) => h('div', { class: 'row cancelled gone' }, h('span', { class: 'glyph' }, icon('gone')), h('span', { class: 'body' }, h('span', { class: 'txt' }, item.content)), h('button', { type: 'button', class: 'ref', title: 'Put a question in the message box', onClick: () => actions.askWhy(item) }, 'Ask why')))));
      }
    }

    // OpenChamber's project backlog: not this session's list, and labelled so.
    const backlogOpen = state.backlog.filter((item) => !item.done);
    if (backlogOpen.length > 0 && state.filter !== 'done' && !state.query) {
      const open = actions.isOpen('backlog', true);
      list.push(h('div', { class: 'bl-head' },
        h('button', { type: 'button', class: 'ghead', 'aria-expanded': String(open), title: 'Items saved to this project in OpenChamber, not to this session.', onClick: () => actions.setFold('backlog', !open) },
          h('span', { class: 'car' }, icon('caret')), h('span', { class: 'bl-title' }, 'Project Todos Backlog'), h('span', { class: 'bl-what' }, "(Todo's OpenChamber Project knowledge)"), h('span', { class: 'n' }, String(backlogOpen.length))),
        h('button', { type: 'button', class: 'ib tiny', title: 'Open Project knowledge', 'aria-label': 'Open Project knowledge', onClick: () => actions.openBacklog() }, icon('open'))));
      if (open) {
        list.push(h('div', { class: 'gitems' },
          ...backlogOpen.map((item) => {
            const shown = state.backlogShown === item.id;
            return h('button', { type: 'button', class: `row next${shown ? '' : ' one'}`, 'aria-expanded': String(shown), title: shown ? undefined : item.text, onClick: () => actions.toggleBacklogItem(item.id) },
              h('span', { class: 'glyph' }, icon('flag')), h('span', { class: 'body' }, h('span', { class: 'txt' }, item.text)));
          }),
          h('p', { class: 'empty small' }, 'Saved to the project, not this session. Agents may have put them here by mistake.')));
      }
    }

    // The user's own items: a separate, labelled list.
    if (state.filter !== 'done' || state.own.some((item) => item.done)) {
      const open = actions.isOpen('own', true);
      const shown = state.own.filter((item) => (state.filter === 'done' ? item.done : state.filter === 'open' ? !item.done : true));
      list.push(h('button', { type: 'button', class: 'ghead', style: 'margin-top:8px', 'aria-expanded': String(open), onClick: () => actions.setFold('own', !open) }, h('span', { class: 'car' }, icon('caret')), 'Your own', h('span', { class: 'n' }, String(state.own.filter((item) => !item.done).length))));
      if (open) {
        const mine: HTMLElement[] = [];
        for (const item of shown) {
          mine.push(h('div', { class: `row ${item.done ? 'done' : 'next'}` },
            h('button', { type: 'button', class: 'tick', 'aria-label': `${item.done ? 'Reopen' : 'Finish'}: ${item.text}`, onClick: () => actions.saveOwn(state.own.map((own) => own.id === item.id ? { ...own, done: !own.done } : own)) }, icon(item.done ? 'check' : 'ring')),
            h('span', { class: 'body' }, h('span', { class: 'txt' }, item.text)),
            h('button', { type: 'button', class: 'prio note-mark', 'aria-label': `Delete: ${item.text}`, title: 'Delete', onClick: () => actions.saveOwn(state.own.filter((own) => own.id !== item.id)) }, icon('trash'))));
        }
        const input = h('input', { class: 'field', id: 'own-add', type: 'text', placeholder: 'Add something for yourself', 'aria-label': 'Add your own item' });
        mine.push(h('form', { class: 'addrow', onSubmit: (event: Event) => { event.preventDefault(); const text = input.value; input.value = ''; void actions.addOwnItem(text); } }, input, h('button', { type: 'submit', class: 'btn' }, icon('plus'), 'Add')));
        list.push(h('div', { class: 'gitems' }, ...mine));
      }
    }

    // Other sessions' lists: their own box, each with its own label.
    const subs: HTMLElement[] = [];
    let subCount = 0;
    const subagentSection = (label: string, rows: ReturnType<typeof subagentsFor<(typeof state.children)[number]>>): void => {
      if (rows.length === 0) return;
      const shownCount = rows.filter((child) => child.shown.length > 0).length;
      subCount += shownCount;
      subs.push(h('div', { class: 'ghead g-sub' }, h('span', { class: 'car' }, icon('tree')), label, h('span', { class: 'n' }, String(shownCount))));
      let hideBelow = Infinity;
      rows.forEach((child) => {
        if (child.depth > hideBelow) return;
        hideBelow = Infinity;
        const key = `child:${child.id}`;
        const open = state.folds[key] ?? false;
        if (!open) hideBelow = child.depth;
        const childCounts = countViews(child.todos);
        subs.push(treed(child.depth, h('button', { type: 'button', class: 'subhead', 'aria-expanded': String(open), title: child.depth > 1 ? `Level ${child.depth} subagent` : undefined, onClick: () => actions.setFold(key, !open) },
          h('span', { class: 'car' }, icon('caret')), h('span', { class: `dot ${child.activity}`, title: child.activity }), h('span', { class: 'grow trunc', title: child.title }, child.title),
          child.agent ? h('span', { class: 'muted small' }, child.agent) : null,
          childCounts.total > 0 ? h('span', { class: 'mini' }, progressBar(childCounts)) : null,
          childCounts.total > 0 ? h('span', { class: 'num small' }, `${childCounts.done}/${childCounts.total}`) : null)));
        if (open) {
          const line = (item: TodoView, depth: number): HTMLElement => treed(depth, todoRow(item, { oneLine: true, tags: settings.tags ? 'show' : 'hide', markPriority: false }));
          for (const item of child.shown) subs.push(line(item, child.depth + 1));
          if (child.tucked.length > 0) {
            const tuckKey = `${key}:cancelled`;
            const tuckOpen = state.folds[tuckKey] ?? false;
            subs.push(treed(child.depth + 1, h('button', { type: 'button', class: 'ghead', 'aria-expanded': String(tuckOpen), onClick: () => actions.setFold(tuckKey, !tuckOpen) }, h('span', { class: 'car' }, icon('caret')), 'Cancelled', h('span', { class: 'n' }, String(child.tucked.length)))));
            if (tuckOpen) for (const item of child.tucked) subs.push(line(item, child.depth + 2));
          }
          subs.push(treed(child.depth + 1, h('button', { type: 'button', class: 'more', style: 'padding-left:6px', onClick: () => actions.openSession(child.id) }, 'Open this session')));
        }
      });
    };
    if (!state.query) {
      const sections = subagentSections(subagentsFor(state.children, state.filter));
      subagentSection('Active subagents', sections.active);
      subagentSection('Idle subagents', sections.idle);
    }

    const selected = all.find((item) => item.key === state.selected) ?? null;
    const boxes: HTMLElement[] = [
      sectionBox('sec:session', 'This session', null, [sessionLines(session, actions.copy), ...list]),
      ...(subs.length > 0 ? [sectionBox('sec:subagents', 'Subagents', subCount, subs)] : []),
      ...(state.plan ? [sectionBox('sec:plans', 'Plans', 1, planBody(state.plan))] : []),
    ];
    return [
      head,
      h('div', { class: 'tools' },
        h('span', { class: 'seg', role: 'group', 'aria-label': 'Filter' }, ...(['all', 'open', 'done'] as Filter[]).map((filter) => (
          h('button', { type: 'button', 'aria-pressed': String(state.filter === filter), onClick: () => actions.setFilter(filter) }, filter[0]?.toUpperCase() + filter.slice(1))))),
        h('input', { class: 'search', id: 'q', type: 'search', placeholder: 'Filter', value: state.query, 'aria-label': 'Filter this list', onInput: (event: Event) => actions.setQuery((event.target as HTMLInputElement).value) }),
        h('button', { type: 'button', class: 'ib', title: 'Copy as Markdown', 'aria-label': 'Copy as Markdown', onClick: () => actions.copyMarkdown() }, icon('copy'))),
      h('div', { class: `split${selected ? ' with-side' : ''}`, style: `--side-w:${settings.sideWidth}px` },
        h('div', { class: 'list', role: 'listbox', 'aria-label': 'Todos' }, ...boxes),
        selected ? columnHandle(feed) : null,
        selected ? h('aside', { class: 'insp side' }, ...inspector(ctx, selected)) : null),
      h('div', { class: 'keys' }, h('kbd', null, 'j'), ' ', h('kbd', null, 'k'), ' move · ', settings.ticking ? h('span', null, h('kbd', null, 'x'), ' tick · ') : null, h('kbd', null, 't'), ' tell the agent · ', h('kbd', null, '/'), ' filter · ', h('kbd', null, 'h'), ' history'),
    ];
  };

  // ----- Frame -----

  const nav = (): HTMLElement => {
    const tabs: [Tab, string, string][] = surface === 'page'
      ? [['overview', 'layers', 'Every session'], ['settings', 'gear', 'Settings']]
      : [['list', 'list', 'This session'], ['history', 'history', 'History'], ['overview', 'layers', 'Every session'], ['settings', 'gear', 'Settings']];
    return h('nav', { class: 'page-nav', 'aria-label': 'Views' },
      state.status ? h('span', { class: 'grow small muted', role: 'status' }, state.status) : h('span', { class: 'grow small version', title: 'Session Todos version' }, `v${version}`),
      ...tabs.map(([tab, name, label]) => h('button', { type: 'button', class: 'ib', title: label, 'aria-label': label, 'aria-pressed': String(state.tab === tab), onClick: () => actions.go(tab) }, icon(name))));
  };

  const body = (): HTMLElement[] => {
    if (state.tab === 'history') return viewHistory(ctx);
    if (state.tab === 'overview') return viewOverview(ctx);
    if (state.tab === 'settings') return viewSettings(ctx);
    if (state.tab === 'setup') return viewSetup(ctx);
    return listView();
  };

  const transitions = (): boolean => feed.settings.motion && 'startViewTransition' in document && !matchMedia('(prefers-reduced-motion: reduce)').matches;

  // A poll never interrupts typing, and a redraw keeps focus and scroll.
  function render(force = false, animate = false): void {
    const active = document.activeElement;
    const typing = active instanceof HTMLTextAreaElement || (active instanceof HTMLInputElement && active.type === 'text');
    if (!force && typing) return;
    const signature = JSON.stringify([state, feed.view, feed.session, feed.settings, workspace.sessions.length, workspace.byId(feed.session?.id ?? '')?.activity]);
    if (!force && signature === renderSig) return;
    renderSig = signature;
    const focusId = active instanceof HTMLElement ? active.id : '';
    const selection = active instanceof HTMLInputElement && active.type !== 'range' ? active.selectionStart : null;
    const scroll = document.scrollingElement?.scrollTop ?? 0;
    const paint = (): void => {
      root.replaceChildren(h('div', { class: surface === 'page' ? 'overview' : 'panel' }, nav(), h('div', { class: 'page' }, ...body())));
      if (document.scrollingElement) document.scrollingElement.scrollTop = scroll;
      if (focusId) {
        const again = document.getElementById(focusId);
        again?.focus();
        if (again instanceof HTMLInputElement && selection !== null) again.setSelectionRange(selection, selection);
      }
    };
    if (animate && transitions()) (document as unknown as { startViewTransition(run: () => void): void }).startViewTransition(paint);
    else paint();
  }

  window.addEventListener('keydown', (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (state.tab === 'list' || state.tab === 'history') {
      if (event.key === 'h') { state.tab = state.tab === 'list' ? 'history' : 'list'; render(true); return; }
    }
    if (state.tab !== 'list') return;
    if (event.key === 'j') actions.moveSelection(1);
    else if (event.key === 'k') actions.moveSelection(-1);
    else if (event.key === 'x') actions.tickSelected();
    else if (event.key === 't') actions.tellSelected();
    else if (event.key === '/') { event.preventDefault(); document.getElementById('q')?.focus(); }
    else return;
  });

  host.onLateGenerateResult((late) => {
    if (late.request.system !== DIGEST_SYSTEM) return;
    state.digest = late.ok ? late.result.text : `No digest: ${late.error}`;
    state.digestBusy = false;
    render(true);
  });

  const loadOtherSessions = async (): Promise<void> => {
    const known = new Set(workspace.sessions.map((session) => session.id));
    const others = await service(host, '/v1/sessions').catch(() => null);
    if (others && Array.isArray(others.sessions)) {
      state.otherSessions = others.sessions.flatMap((raw) => {
        const record = looseSession(raw);
        if (!record || known.has(record.id)) return [];
        // Outside the host's list, but maybe in a project's folder. Otherwise it is a chat.
        const project = projectForFolder(record.directory, workspace.projects);
        return [(project ? { ...record, projectId: project.id } : record) as unknown as GuestSessionRecord];
      });
    }
  };

  const refreshOverview = async (): Promise<void> => {
    if (state.tab !== 'overview') return;
    if (overviewBusy) return;
    overviewBusy = true;
    try {
      const since = Date.now() - feed.settings.overviewDays * 86_400_000;
      await loadOtherSessions();
      const running = (session: GuestSessionRecord): boolean => session.activity === 'running' || session.activity === 'retrying';
      // A list only changes when its session does, so read each once and again when it moves. The newest go first.
      const stale = liveFamilies([...workspace.sessions, ...state.otherSessions], since)
        .filter((session) => running(session) || listsRead.get(session.id) !== session.updatedAt)
        .sort((left, right) => right.updatedAt - left.updatedAt);
      for (let at = 0; at < stale.length; at += LISTS_AT_A_TIME) {
        const batch = stale.slice(at, at + LISTS_AT_A_TIME);
        const answer = await service(host, '/v1/lists', { sessions: batch.map((session) => ({ id: session.id, directory: session.directory })) });
        if (!isRecord(answer.lists)) return;
        const next: Lists = { ...state.lists };
        for (const session of batch) {
          const entry = answer.lists[session.id];
          if (!isRecord(entry)) continue;
          // A failed read keeps what is on screen, and is tried again.
          if (entry.status !== 'ok' && entry.status !== 'none') continue;
          listsRead.set(session.id, session.updatedAt);
          const todos: Todo[] = entry.status === 'ok' ? readTodos(entry.todos) : [];
          if (todos.length > 0) next[session.id] = { todos, source: String(entry.source ?? ''), at: Number(entry.at) || 0 };
          else delete next[session.id];
        }
        state.lists = next;
        render();
        if (state.tab !== 'overview') return;
      }
    } catch { /* labels and counts stay as they were */ } finally {
      overviewBusy = false;
    }
  };

  const start = (): void => {
    feed.start();
    workspace.start();
    applySettings(feed.settings);
    void host.storage.get(foldKey).then((value) => { state.folds = kept(readFolds(value)); render(true); }).catch(() => undefined);
    void host.storage.get(SETUP_KEY).then((done) => {
      if (done !== true && surface === 'panel') {
        state.tab = 'setup';
        void actions.runSetupCheck();
        render(true);
      }
    }).catch(() => undefined);
    window.setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      void loadChildren().then(loadChildHistories);
      void loadBacklog();
      void loadPlan();
      void loadOwnState();
    }, SUBAGENTS_EVERY_MS);
    window.setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      void refreshOverview();
      if (state.tab === 'setup' && state.needsRestart) void loadOtherSessions().then(() => render(true));
      // Times on screen ("updated 3m ago") age even when nothing else moves.
      if (state.tab === 'list' || state.tab === 'overview') render(true);
    }, OVERVIEW_EVERY_MS);
    render(true);
    void refreshOverview();
  };

  return { ...ctx, start };
};

const DIGEST_SYSTEM = 'You summarise coding agents\' progress for the developer who runs them. Plain sentences, at most four. Say first which sessions wait on the developer, then what moved, then anything that looks stalled. State only what the lists and states show. No preamble.';

export const startApp = (host: Host, root: HTMLElement, surface: 'panel' | 'page', addOwn: (sessionId: string, text: string) => Promise<void>): void => {
  createApp(host, root, surface, addOwn).start();
};
