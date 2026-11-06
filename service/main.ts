// The extension's local service. The host starts it, binds it to loopback and
// proxies the frames to it. It does what a sandboxed frame can't: read another
// folder's list, read session messages through OpenChamber, keep history.
//
// It never handles a password. If OpenChamber asks for one, it falls back to
// reading OpenCode's database, read-only.
import { copyFile, mkdir, readFile, rename, stat, writeFile, unlink } from 'node:fs/promises';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { appendRevision, editsFile, isRecord, parseTodosFile, planSessionId, planSteps, readTodos, readsOwnFile, repairRevisions, todosForSession, OLDER_VERSION, type Revision, type Todo } from '../shared/model.ts';
import { DEFAULTS, readSettings, type Settings } from '../shared/settings.ts';
import {
  MIN_OPENCODE,
  TODO_SNIPPET,
  atLeast,
  OMO_CONFIG_FILES,
  chooseDatabase,
  configuredDepth,
  dataDirFromConfig,
  databaseDirs,
  editableConfig,
  enableTodoInText,
  nextCursor,
  newConfigPath,
  omoPlugin,
  pickFromMessages,
  pickFromRows,
  type ToolHit,
  todoFlag,
  type ConfigDocument,
} from './sources.ts';
import { REDIRECT_FILE, REDIRECT_MARK, REDIRECT_PLUGIN } from './redirect-plugin.ts';

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';

let settings: Settings = DEFAULTS;
let serverOrigin: string | null = null;
let offeredOrigin: string | null = null;

// ----- Finding OpenChamber's server -----

// XDG_CONFIG_HOME may be set for another tool while OpenChamber stays in ~/.config.
const settingsFiles = (): string[] => [
  ...(process.env.XDG_CONFIG_HOME ? [path.join(process.env.XDG_CONFIG_HOME, 'openchamber', 'settings.json')] : []),
  path.join(os.homedir(), '.config', 'openchamber', 'settings.json'),
];

const isOpenChamber = async (origin: string): Promise<boolean> => {
  try {
    const response = await fetch(new URL('/health', origin), { signal: AbortSignal.timeout(1500), redirect: 'manual' });
    if (!response.ok) return false;
    const body: unknown = await response.json();
    return isRecord(body) && typeof body.openchamberVersion === 'string';
  } catch {
    return false;
  }
};

const resolveOrigin = async (): Promise<string | null> => {
  if (serverOrigin && await isOpenChamber(serverOrigin)) return serverOrigin;
  serverOrigin = null;
  const candidates: string[] = [];
  if (offeredOrigin) candidates.push(offeredOrigin);
  for (const file of settingsFiles()) {
    try {
      const raw: unknown = JSON.parse(await readFile(file, 'utf8'));
      if (isRecord(raw) && typeof raw.desktopLocalPort === 'number') candidates.push(`http://127.0.0.1:${raw.desktopLocalPort}`);
    } catch { /* no desktop settings here */ }
  }
  for (const candidate of candidates) {
    if (await isOpenChamber(candidate)) return serverOrigin = candidate;
  }
  return null;
};

type ApiAnswer = { status: number; body: unknown };

const api = async (route: string, options: { method?: string; directory?: string | null; timeoutMs?: number } = {}): Promise<ApiAnswer> => {
  const origin = await resolveOrigin();
  if (!origin) return { status: 0, body: null };
  const response = await fetch(new URL(route, origin), {
    method: options.method ?? 'GET',
    headers: { Accept: 'application/json', ...(options.directory ? { 'x-opencode-directory': options.directory } : {}) },
    signal: AbortSignal.timeout(options.timeoutMs ?? 6000),
    redirect: 'manual',
  });
  const text = await response.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* a non-JSON answer */ }
  return { status: response.status, body };
};

// ----- Read-only SQLite, loaded lazily so a runtime without it can still explain itself -----

type Row = Record<string, unknown>;
type Db = { prepare(sql: string): { all(...params: unknown[]): Row[]; get(...params: unknown[]): Row | undefined }; close(): void };
type DbCtor = new (file: string, options?: { readOnly?: boolean; timeout?: number }) => Db;

let dbCtor: DbCtor | null | undefined;
const sqlite = (): DbCtor | null => {
  if (dbCtor !== undefined) return dbCtor;
  try {
    const require = createRequire(import.meta.url);
    dbCtor = (require('node:sqlite') as { DatabaseSync: DbCtor }).DatabaseSync;
  } catch {
    dbCtor = null;
  }
  return dbCtor;
};

const withDb = <T>(file: string, run: (db: Db) => T): T | null => {
  const Ctor = sqlite();
  if (!Ctor) return null;
  let db: Db | null = null;
  try {
    db = new Ctor(file, { readOnly: true, timeout: 1500 });
    return run(db);
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
};

const tables = (db: Db): Set<string> => new Set(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all().map((row) => String(row.name)));

// Learned from OpenChamber's own answer about the config; a thin service environment can't see it otherwise.
let extraDataDir: string | null = null;

const databaseCandidates = (): { path: string; newestMs: number }[] => {
  if (settings.databasePath.trim()) {
    const file = settings.databasePath.trim().replace(/^~(?=[/\\])/, os.homedir());
    return fs.existsSync(file) ? [{ path: file, newestMs: Date.now() }] : [];
  }
  const out: { path: string; newestMs: number }[] = [];
  const dirs = databaseDirs(process.env as Record<string, string | undefined>, os.homedir(), process.platform, path.join);
  for (const dir of extraDataDir ? [extraDataDir, ...dirs] : dirs) {
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!/^opencode(?:-[\w.-]+)?\.db$/.test(name)) continue;
      const file = path.join(dir, name);
      const main = fs.statSync(file, { throwIfNoEntry: false });
      const wal = fs.statSync(`${file}-wal`, { throwIfNoEntry: false });
      if (main) out.push({ path: file, newestMs: Math.max(main.mtimeMs, wal?.mtimeMs ?? 0) });
    }
  }
  return out;
};

const holdsSession = (file: string, sessionId: string): boolean => withDb(file, (db) => {
  const names = tables(db);
  if (names.has('session_v2') && db.prepare('SELECT 1 FROM session_v2 WHERE id = ?').get(sessionId)) return true;
  return names.has('session') && db.prepare('SELECT 1 FROM session WHERE id = ?').get(sessionId) !== undefined;
}) === true;

const databaseFor = (sessionId: string | null): string | null => chooseDatabase(databaseCandidates(), (file) => (sessionId ? holdsSession(file, sessionId) : false))?.path ?? null;

type Found = { todos: Todo[]; at: number; source: string };

const found = (hit: ToolHit, source: string): Found => ({
  todos: hit.todos,
  at: hit.at,
  source: hit.behind ? `${source}${OLDER_VERSION}` : source,
});

const fromDatabase = (sessionId: string): Found | null => {
  const file = databaseFor(sessionId);
  if (!file || !holdsSession(file, sessionId)) return null;
  return withDb(file, (db): Found | null => {
    const names = tables(db);
    if (names.has('session_part')) {
      const rows = db.prepare("SELECT data, time_created AS at FROM session_part WHERE session_id = ? AND data LIKE '%todowrite%' ORDER BY time_created DESC LIMIT 60").all(sessionId);
      const hit = pickFromRows(rows.map((row) => ({ data: row.data, at: row.at })));
      if (hit) return found(hit, 'database');
    }
    if (names.has('session_message')) {
      const rows = db.prepare("SELECT data, time_created AS at FROM session_message WHERE session_id = ? AND type = 'assistant' AND data LIKE '%todowrite%' ORDER BY seq DESC LIMIT 60").all(sessionId);
      const hit = pickFromRows(rows.map((row) => ({ data: row.data, at: row.at })));
      if (hit) return found(hit, 'database');
    }
    if (names.has('todo')) {
      const rows = db.prepare('SELECT content, status, priority, time_updated AS at FROM todo WHERE session_id = ? ORDER BY position').all(sessionId);
      if (rows.length > 0) return { todos: readTodos(rows), at: Math.max(...rows.map((row) => Number(row.at) || 0)), source: 'old list' };
    }
    return null;
  });
};

// ----- A session's list, wherever it lives -----

// The agent rewrites its file often. A read caught mid-write is tried again for a while before
// the slower sources are asked, which may only hold an older list.
const OMO_RETRY_MS = 150;
const OMO_TRIES = 4;

type OmoFile = { value: Record<string, unknown>; at: number };

const omoReadState = async (directory: string, name: string): Promise<OmoFile | 'missing' | 'unreadable'> => {
  const file = path.join(directory, ...settings.omoDir.split('/'), name);
  for (let attempt = 0; attempt < OMO_TRIES; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, OMO_RETRY_MS));
    try {
      const [text, info] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
      const value = parseTodosFile(text);
      if (value) return { value, at: info.mtimeMs };
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 'missing';
    }
  }
  return 'unreadable';
};

const omoRead = async (directory: string, name: string): Promise<OmoFile | null> => {
  const file = await omoReadState(directory, name);
  return typeof file === 'string' ? null : file;
};

const created = new Map<string, number>();

const sessionCreatedAt = async (sessionId: string, directory: string | null): Promise<number | null> => {
  const known = created.get(sessionId);
  if (known !== undefined) return known;
  try {
    const answer = await api(`/api/session/${encodeURIComponent(sessionId)}`, { directory });
    const data = isRecord(answer.body) && isRecord(answer.body.data) ? answer.body.data : isRecord(answer.body) ? answer.body : {};
    const time = isRecord(data.time) ? data.time : {};
    if (typeof time.created !== 'number') return null;
    created.set(sessionId, time.created);
    return time.created;
  } catch {
    return null;
  }
};

const fromOmo = async (sessionId: string, directory: string | null, file: OmoFile | null, anySession = false): Promise<Found | null> => {
  if (!directory || !file || !Object.hasOwn(file.value, sessionId)) return null;
  const switchedAt = settings.nativeFolders[directory];
  if (!anySession && switchedAt !== undefined && !readsOwnFile(await sessionCreatedAt(sessionId, directory), switchedAt)) return null;
  return { todos: todosForSession(file.value, sessionId), at: file.at, source: 'oh-my-openagent' };
};

const fromLog = async (sessionId: string, directory: string | null): Promise<Found | null> => {
  if (!settings.useLog) return null;
  const session = await api(`/api/session/${encodeURIComponent(sessionId)}`, { directory });
  if (session.status !== 200 || !isRecord(session.body)) return null;
  const data = isRecord(session.body.data) ? session.body.data : session.body;
  const revert = isRecord(data.revert) && typeof data.revert.messageID === 'string' ? data.revert.messageID : null;
  let cursor: string | null = null;
  for (let page = 0; page < 4; page += 1) {
    // The route refuses `order` next to a cursor; the cursor already carries it.
    const query = cursor ? `limit=100&cursor=${encodeURIComponent(cursor)}` : 'limit=100&order=desc';
    const answer = await api(`/api/session/${encodeURIComponent(sessionId)}/message?${query}`, { directory, timeoutMs: 8000 });
    if (answer.status !== 200 || !isRecord(answer.body) || !Array.isArray(answer.body.data)) return null;
    const hit = pickFromMessages(answer.body.data, revert);
    if (hit) return found(hit, 'OpenCode session');
    cursor = answer.body.data.length > 0 ? nextCursor(answer.body) : null;
    if (!cursor) return null;
  }
  return null;
};

type ListAnswer = { status: 'ok'; todos: Todo[]; at: number; source: string } | { status: 'none'; reason: string };

const cache = new Map<string, { at: number; answer: ListAnswer }>();
// The agent's file is cheap to read. A message log is pages of JSON from OpenChamber, and a
// session with no list costs the most, because every page has to be read to know that.
const freshFor = (answer: ListAnswer): number => {
  if (answer.status === 'none') return 8000;
  return answer.source === 'oh-my-openagent' ? 1500 : 4000;
};

const readList = async (sessionId: string, directory: string | null, atLeastMs = 0): Promise<ListAnswer> => {
  const hit = cache.get(sessionId);
  if (hit && Date.now() - hit.at < Math.max(atLeastMs, freshFor(hit.answer))) return hit.answer;
  const agentFile = settings.useOmo && directory ? await omoReadState(directory, 'todos.json') : 'missing';
  const omo = typeof agentFile === 'string' ? null : agentFile;
  let list = await fromOmo(sessionId, directory, omo);
  if (!list) {
    try {
      list = await fromLog(sessionId, directory);
    } catch {
      list = null;
    }
  }
  if (!list && settings.useDatabase) list = fromDatabase(sessionId);
  // A list on record beats saying there is none, whichever folder rule applied above.
  if (!list) list = await fromOmo(sessionId, directory, omo, true);
  const answer: ListAnswer = list
    ? { status: 'ok', ...list }
    : { status: 'none', reason: 'No todo list in this session.' };
  cache.set(sessionId, { at: Date.now(), answer });
  if (cache.size > 400) cache.delete(cache.keys().next().value as string);
  // History takes only lists the service can stand behind: not one its source knows is older,
  // and nothing while the agent's file can't be read, since it may hold a newer list than the
  // other sources. Both are still shown; the next good read records the current list.
  if (list && agentFile !== 'unreadable' && !list.source.endsWith(OLDER_VERSION)) void record(sessionId, list);
  return answer;
};

// ----- History: every list that differs, kept per session -----

const historyDir = (): string => path.join(settings.dataDir.trim().replace(/^~(?=[/\\])/, os.homedir()) || path.join(os.homedir(), '.local', 'share', 'openchamber-session-todos'), 'history');
const historyFile = (sessionId: string): string => path.join(historyDir(), `${sessionId.replace(/[^\w.-]/g, '_')}.json`);

// The history last read or written, with the file's time then: another process may write the file too.
const histories = new Map<string, { revisions: Revision[]; mtimeMs: number }>();

// One history job at a time per session, so a repair and a record never race in this process.
const jobs = new Map<string, Promise<unknown>>();
const serial = <T>(sessionId: string, job: () => Promise<T>): Promise<T> => {
  const run = (jobs.get(sessionId) ?? Promise.resolve()).then(job, job);
  jobs.set(sessionId, run);
  void run.finally(() => { if (jobs.get(sessionId) === run) jobs.delete(sessionId); }).catch(() => undefined);
  return run;
};

const mtimeOf = (file: string): Promise<number> => stat(file).then((info) => info.mtimeMs, () => 0);

const RENAME_TRIES = 4;
const RENAME_RETRY_MS = 60;

/** Writes the whole history and answers the file's new time. Throws when it could not. */
const saveHistory = async (sessionId: string, revisions: Revision[], keepOld = false): Promise<number> => {
  const file = historyFile(sessionId);
  await mkdir(path.dirname(file), { recursive: true });
  if (keepOld) await copyFile(file, `${file}.bak`);
  const scratch = `${file}.${process.pid}.tmp`;
  await writeFile(scratch, JSON.stringify(revisions));
  // A reader holding the file (a backup, a virus scanner) blocks a rename on Windows for a moment.
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(scratch, file);
      break;
    } catch (error) {
      if (attempt >= RENAME_TRIES) {
        await unlink(scratch).catch(() => undefined);
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_MS));
    }
  }
  return mtimeOf(file);
};

const readRevision = (entry: unknown): Revision[] => (
  isRecord(entry) && typeof entry.at === 'number' && Array.isArray(entry.todos) ? [{ at: entry.at, source: String(entry.source ?? ''), todos: readTodos(entry.todos) }] : []
);

const loadHistoryNow = async (sessionId: string): Promise<Revision[]> => {
  const file = historyFile(sessionId);
  const mtimeMs = await mtimeOf(file);
  const known = histories.get(sessionId);
  if (known && known.mtimeMs === mtimeMs) return known.revisions;
  let text: string | null = null;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    // Missing is a first time. Anything else (locked, no access) is not an empty history.
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  let revisions: Revision[] = [];
  let damaged = false;
  if (text !== null) {
    try {
      const raw: unknown = JSON.parse(text);
      if (Array.isArray(raw)) {
        revisions = raw.flatMap(readRevision);
        damaged = revisions.length !== raw.length;
      } else damaged = true;
    } catch {
      damaged = true;
    }
  }
  // Never write over what could not be read whole: set the file aside first, once per version of it.
  if (damaged) {
    const aside = `${file}.damaged-${Math.round(mtimeMs)}`;
    if (!fs.existsSync(aside)) await copyFile(file, aside);
  }
  // Older copies were once kept as new versions. Drop them, and keep the file as it was beside it.
  const repaired = repairRevisions(revisions);
  const savedAt = repaired !== revisions ? await saveHistory(sessionId, repaired, true) : mtimeMs;
  histories.set(sessionId, { revisions: repaired, mtimeMs: savedAt });
  return repaired;
};

const loadHistory = (sessionId: string): Promise<Revision[]> => serial(sessionId, () => loadHistoryNow(sessionId));

const record = (sessionId: string, list: Found): Promise<void> => {
  if (!settings.history || list.todos.length === 0) return Promise.resolve();
  return serial(sessionId, async () => {
    const revisions = await loadHistoryNow(sessionId);
    const next = appendRevision(revisions, list.todos, list.at || Date.now(), list.source);
    if (next === revisions) return;
    // Kept as read only once it is on disk: a failed write is tried again on the next read.
    histories.set(sessionId, { revisions: next, mtimeMs: await saveHistory(sessionId, next) });
  }).catch(() => undefined);
};

// The recorder keeps history when no frame is open, for the sessions a frame last named.
const watched = new Map<string, string | null>();
const WATCH_MS = 5000;
const WATCH_MAX = 12;
const watch = (id: string, directory: string | null): void => {
  watched.delete(id);
  watched.set(id, directory);
  if (watched.size > WATCH_MAX * 4) watched.delete(watched.keys().next().value as string);
};
// Sessions a frame names through /v1/watch stay recorded while it keeps naming them, however
// many other lists are read in between.
const pinned = new Map<string, { directory: string | null; until: number }>();
const PIN_MS = 60000;
const PIN_MAX = 50;
setInterval(() => {
  if (!settings.history) return;
  const now = Date.now();
  for (const [id, pin] of pinned) if (pin.until < now) pinned.delete(id);
  const due = new Map([...watched].slice(-WATCH_MAX));
  for (const [id, pin] of pinned) due.set(id, pin.directory);
  for (const [id, directory] of due) void readList(id, directory).catch(() => undefined);
}, WATCH_MS).unref();

// ----- First-run report and the one edit this service may make -----

const readConfig = async (directory: string | null = null): Promise<ConfigDocument[] | null> => {
  const answer = await api('/api/config', { directory });
  return answer.status === 200 && Array.isArray(answer.body) ? answer.body as ConfigDocument[] : null;
};

const readDepth = async (documents: ConfigDocument[]): Promise<number | null> => {
  const plugin = omoPlugin(documents);
  const config = editableConfig(documents);
  const texts = plugin && config
    ? (await Promise.all(OMO_CONFIG_FILES.map((name) => readFile(path.join(path.dirname(config), name), 'utf8').catch(() => null)))).filter((text): text is string => text !== null)
    : [];
  return configuredDepth(documents, plugin, texts);
};

let depthCache: { at: number; value: number | null } | null = null;
const DEPTH_FRESH_MS = 30000;

const cachedDepth = async (): Promise<number | null> => {
  if (depthCache && Date.now() - depthCache.at < DEPTH_FRESH_MS) return depthCache.value;
  const documents = await readConfig().catch(() => null);
  const value = documents ? await readDepth(documents) : null;
  depthCache = { at: Date.now(), value };
  return value;
};

const report = async (sessionId: string | null, directory: string | null): Promise<Record<string, unknown>> => {
  const origin = await resolveOrigin();
  let version: string | null = null;
  let configPath: string | null = null;
  let plugin: boolean | null = null;
  let todo: { on: boolean; lockedBy: string | null } | null = null;
  let redirect: { on: boolean; path: string | null } = { on: false, path: null };
  let access: 'open' | 'locked' | 'unreachable' = origin ? 'open' : 'unreachable';
  if (origin) {
    const info = await api('/api/opencode/version').catch(() => null);
    if (info?.status === 401 || info?.status === 403) access = 'locked';
    if (isRecord(info?.body) && typeof info.body.version === 'string') version = info.body.version;
    const documents = await readConfig(directory).catch(() => null);
    if (documents) {
      redirect = await redirectState(redirectPath(documents));
      todo = todoFlag(documents);
      configPath = editableConfig(documents) ?? newConfigPath(documents, path.join);
      plugin = omoPlugin(documents);
      extraDataDir = dataDirFromConfig(configPath, path.join);
    }
  }
  const omoFolder = directory ? path.join(directory, ...settings.omoDir.split('/')) : null;
  const database = databaseFor(sessionId);
  const omoFile = directory ? await omoRead(directory, 'todos.json') : null;
  return {
    origin,
    access,
    version,
    minVersion: MIN_OPENCODE,
    versionOk: version ? atLeast(version, MIN_OPENCODE) : null,
    todo,
    configPath,
    redirect,
    snippet: TODO_SNIPPET,
    omo: { found: omoFolder ? fs.existsSync(path.join(omoFolder, 'todos.json')) : false, folder: omoFolder, plugin, holdsSession: Boolean(omoFile && sessionId && Object.hasOwn(omoFile.value, sessionId)) },
    database: { path: database, sqlite: sqlite() !== null, holdsSession: Boolean(database && sessionId && holdsSession(database, sessionId)) },
    historyDir: historyDir(),
    subagentDepth: await cachedDepth(),
    node: process.versions.node,
  };
};

// One folder: its own config, made if it isn't there yet. Otherwise the user's global config.
const folderConfig = (directory: string): string => path.join(directory, '.opencode', 'opencode.json');

const setTodo = async (options: { reload: boolean; directory: string | null; value: boolean }): Promise<Record<string, unknown>> => {
  const { reload, directory, value } = options;
  const documents = directory ? null : await readConfig();
  const file = directory ? folderConfig(directory) : documents ? editableConfig(documents) ?? newConfigPath(documents, path.join) : null;
  if (!file) return { ok: false, reason: 'OpenChamber did not say which config file to change.', snippet: TODO_SNIPPET };
  let text: string;
  let existed = true;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { ok: false, reason: `Could not read ${file}.`, path: file, snippet: TODO_SNIPPET };
    if (!value) return { ok: true, path: file, backup: null, changed: false, reloaded: false };
    text = '{}\n';
    existed = false;
  }
  const edit = enableTodoInText(text, value);
  if (!edit.ok) return { ok: false, reason: edit.reason, path: file, snippet: TODO_SNIPPET };
  let backup: string | null = null;
  if (edit.changed) {
    try {
      if (existed) {
        backup = `${file}.session-todos.bak`;
        await copyFile(file, backup);
      } else await mkdir(path.dirname(file), { recursive: true });
      const scratch = `${file}.${process.pid}.tmp`;
      await writeFile(scratch, edit.text);
      await rename(scratch, file);
    } catch {
      return { ok: false, reason: `Could not write ${file}.`, path: file, snippet: TODO_SNIPPET };
    }
  }
  let reloaded = false;
  if (reload) {
    const answer = await api('/api/location/reload', { method: 'POST', timeoutMs: 15000, directory }).catch(() => null);
    reloaded = answer !== null && answer.status >= 200 && answer.status < 300;
  }
  return { ok: true, path: file, backup, changed: edit.changed, reloaded };
};

const redirectPath = (documents: ConfigDocument[] | null): string | null => {
  const config = documents ? editableConfig(documents) ?? newConfigPath(documents, path.join) : null;
  return config ? path.join(path.dirname(config), 'plugins', REDIRECT_FILE) : null;
};

const redirectState = async (file: string | null): Promise<{ on: boolean; path: string | null }> => ({
  on: file ? (await readFile(file, 'utf8').catch(() => '')).startsWith(REDIRECT_MARK) : false,
  path: file,
});

const setRedirect = async (on: boolean): Promise<Record<string, unknown>> => {
  const file = redirectPath(await readConfig().catch(() => null));
  if (!file) return { ok: false, reason: 'OpenChamber did not say where your config is.' };
  const current = await readFile(file, 'utf8').catch(() => null);
  if (current !== null && !current.startsWith(REDIRECT_MARK)) return { ok: false, path: file, reason: `${file} is not ours, so it was left alone.` };
  if (on === (current !== null) && (!on || current === REDIRECT_PLUGIN)) return { ok: true, path: file, changed: false };
  try {
    if (on) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, REDIRECT_PLUGIN);
    } else await unlink(file);
  } catch {
    return { ok: false, path: file, reason: `Could not change ${file}.` };
  }
  return { ok: true, path: file, changed: true };
};

const sessionTitle = async (sessionId: string, directory: string | null): Promise<{ title: string | null; agent: string | null; cost: number | null }> => {
  try {
    const answer = await api(`/api/session/${encodeURIComponent(sessionId)}`, { directory });
    const data = isRecord(answer.body) ? (isRecord(answer.body.data) ? answer.body.data : answer.body) : {};
    return { title: typeof data.title === 'string' ? data.title : null, agent: typeof data.agent === 'string' ? data.agent : null, cost: typeof data.cost === 'number' ? data.cost : null };
  } catch {
    return { title: null, agent: null, cost: null };
  }
};

// ----- Routes -----

// The top-level session in this session's project that last edited `file`, from OpenCode's own record.
const lastEditor = (sessionId: string, file: string): { id: string; at: number } | null => {
  const db = databaseFor(sessionId);
  if (!db) return null;
  return withDb(db, (handle) => {
    const names = tables(handle);
    if (!names.has('session_message') || !names.has('session_v2')) return null;
    const rows = handle.prepare(`SELECT session_id AS id, data, time_created AS at FROM session_message
      WHERE type = 'assistant' AND data LIKE ? AND session_id IN (
        SELECT id FROM session_v2 WHERE parent_id IS NULL AND project_id = (SELECT project_id FROM session_v2 WHERE id = ?))
      ORDER BY time_created DESC LIMIT 80`).all(`%${file}%`, sessionId);
    for (const row of rows) if (editsFile(String(row.data), file)) return { id: String(row.id), at: Number(row.at) || 0 };
    return null;
  });
};

const planCache = new Map<string, { at: number; value: Record<string, unknown> }>();
const PLAN_FRESH_MS = 30000;

const claims = new Map<string, number>();
let sessionList: { at: number; value: unknown[] } | null = null;
const SESSIONS_FRESH_MS = 15000;
const SESSION_PAGES = 10;
// Asking about many sessions at once: older answers are fine, and only a few reads run together.
const LISTS_FRESH_MS = 15000;
const LISTS_AT_ONCE = 6;

const routes: Record<string, (body: Record<string, unknown>) => Promise<unknown>> = {
  '/v1/hello': async (body) => {
    if (typeof body.origin === 'string' && /^https?:\/\//.test(body.origin)) offeredOrigin = body.origin;
    if (body.settings !== undefined) settings = readSettings(body.settings);
    return { ok: true };
  },
  '/v1/report': (body) => report(typeof body.sessionId === 'string' ? body.sessionId : null, typeof body.directory === 'string' ? body.directory : null),
  '/v1/list': async (body) => {
    const id = String(body.sessionId ?? '');
    const directory = typeof body.directory === 'string' ? body.directory : null;
    if (!id) return { status: 'none', reason: 'No session.' };
    watch(id, directory);
    return readList(id, directory);
  },
  // A frame that reads the agent's file itself names its session here, so it is still recorded.
  '/v1/watch': async (body) => {
    const id = String(body.sessionId ?? '');
    if (id) {
      pinned.delete(id);
      pinned.set(id, { directory: typeof body.directory === 'string' ? body.directory : null, until: Date.now() + PIN_MS });
      if (pinned.size > PIN_MAX) pinned.delete(pinned.keys().next().value as string);
    }
    return { ok: true };
  },
  '/v1/lists': async (body) => {
    const sessions = Array.isArray(body.sessions) ? body.sessions.filter(isRecord).slice(0, 200) : [];
    const out: Record<string, unknown> = {};
    const queue = [...sessions];
    const worker = async (): Promise<void> => {
      for (let session = queue.shift(); session; session = queue.shift()) {
        const id = String(session.id ?? '');
        if (!id) continue;
        const directory = typeof session.directory === 'string' ? session.directory : null;
        out[id] = { ...(await readList(id, directory, LISTS_FRESH_MS).catch((): ListAnswer => ({ status: 'none', reason: '' }))), ...(body.titles === true ? await sessionTitle(id, directory) : {}) };
      }
    };
    await Promise.all(Array.from({ length: LISTS_AT_ONCE }, worker));
    return { lists: out };
  },
  '/v1/children': async (body) => {
    const id = String(body.sessionId ?? '');
    const directory = typeof body.directory === 'string' ? body.directory : null;
    if (!directory) return { children: [], parents: {}, depth: await cachedDepth() };
    const parents = await omoRead(directory, 'parents.json');
    const file = await omoRead(directory, 'todos.json');
    const ids = parents ? Object.entries(parents.value).filter(([, parent]) => parent === id).map(([child]) => child) : [];
    return { children: ids, lists: file ? ids.filter((child) => Object.hasOwn(file.value, child)) : [], parents: parents?.value ?? {}, depth: await cachedDepth() };
  },
  '/v1/backlog': async (body) => {
    const id = typeof body.projectId === 'string' ? body.projectId : '';
    if (!id) return { todos: [] };
    const answer = await api(`/api/project-context/${encodeURIComponent(id)}`).catch(() => null);
    return { todos: answer?.status === 200 && isRecord(answer.body) && Array.isArray(answer.body.todos) ? answer.body.todos : [] };
  },
  // The plan this session works on: the one OpenChamber sent to it, else the plan file it was the last
  // top-level session to edit. A plan sent to another session is that session's.
  '/v1/plan': async (body) => {
    const projectId = typeof body.projectId === 'string' ? body.projectId : '';
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
    if (!projectId || !sessionId) return { plan: null };
    const key = `${projectId}:${sessionId}`;
    const hit = planCache.get(key);
    if (hit && Date.now() - hit.at < PLAN_FRESH_MS) return hit.value;
    const answer = await api(`/api/project-context/${encodeURIComponent(projectId)}`).catch(() => null);
    const plans = answer?.status === 200 && isRecord(answer.body) && Array.isArray(answer.body.plans) ? answer.body.plans.filter(isRecord) : [];
    let value: Record<string, unknown> = { plan: null };
    const linked = plans.find((plan) => planSessionId(plan.session) === sessionId);
    if (linked) value = { plan: linked, how: 'linked' };
    else if (settings.useDatabase) {
      let best: { plan: Record<string, unknown>; at: number } | null = null;
      for (const plan of plans) {
        if (planSessionId(plan.session) || typeof plan.file !== 'string') continue;
        const editor = lastEditor(sessionId, plan.file);
        if (editor?.id === sessionId && (!best || editor.at > best.at)) best = { plan, at: editor.at };
      }
      if (best) value = { plan: best.plan, how: 'edited', at: best.at };
    }
    if (isRecord(value.plan) && typeof value.plan.id === 'string') {
      const full = await api(`/api/project-context/${encodeURIComponent(projectId)}/plans/${encodeURIComponent(value.plan.id)}`).catch(() => null);
      const text = full?.status === 200 && isRecord(full.body) && typeof full.body.body === 'string' ? full.body.body : '';
      value = { ...value, steps: planSteps(text) };
    }
    planCache.set(key, { at: Date.now(), value });
    if (planCache.size > 200) planCache.delete(planCache.keys().next().value as string);
    return value;
  },
  '/v1/sessions': async () => {
    if (sessionList && Date.now() - sessionList.at < SESSIONS_FRESH_MS) return { sessions: sessionList.value };
    const value: unknown[] = [];
    let cursor: string | null = null;
    let complete = false;
    for (let page = 0; page < SESSION_PAGES; page += 1) {
      const answer: Awaited<ReturnType<typeof api>> | null = await api(`/api/session?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { timeoutMs: 8000 }).catch(() => null);
      if (answer?.status !== 200 || !isRecord(answer.body) || !Array.isArray(answer.body.data)) break;
      // Only what the frames use: this crosses the proxy every few seconds.
      for (const raw of answer.body.data) if (isRecord(raw)) value.push({ id: raw.id, title: raw.title, parentID: raw.parentID, location: raw.location, time: raw.time });
      cursor = answer.body.data.length > 0 ? nextCursor(answer.body) : null;
      if (!cursor) { complete = true; break; }
    }
    if (complete || value.length > 0) sessionList = { at: Date.now(), value };
    return { sessions: value };
  },
  '/v1/session': async (body) => {
    const answer = await api(`/api/session/${encodeURIComponent(String(body.sessionId ?? ''))}`, { directory: typeof body.directory === 'string' ? body.directory : null }).catch(() => null);
    return { session: isRecord(answer?.body) ? (isRecord(answer.body.data) ? answer.body.data : answer.body) : null };
  },
  '/v1/history': async (body) => ({ revisions: await loadHistory(String(body.sessionId ?? '')).catch((): Revision[] => []) }),
  '/v1/redirect': (body) => setRedirect(body.on === true),
  '/v1/enable-todo': (body) => setTodo({ reload: body.reload === true, directory: typeof body.directory === 'string' ? body.directory : null, value: body.value !== false }),
  '/v1/reload': async (body) => {
    const answer = await api('/api/location/reload', { method: 'POST', timeoutMs: 15000, directory: typeof body.directory === 'string' ? body.directory : null }).catch(() => null);
    return { ok: answer !== null && answer.status >= 200 && answer.status < 300 };
  },
  // Several frames may see one state change; the first to ask gets to tell the user.
  '/v1/claim': async (body) => {
    const key = String(body.key ?? '');
    if (!key || claims.has(key)) return { first: false };
    claims.set(key, Date.now());
    if (claims.size > 500) claims.delete(claims.keys().next().value as string);
    return { first: true };
  },
  '/v1/export': async (body) => {
    const dir = path.dirname(historyDir());
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `export-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    await writeFile(file, JSON.stringify(body.data ?? {}, null, 2));
    return { path: file };
  },
};

const readBody = (request: http.IncomingMessage): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
  const chunks: Buffer[] = [];
  let size = 0;
  request.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > 8_000_000) { reject(new Error('Too large')); request.destroy(); return; }
    chunks.push(chunk);
  });
  request.on('end', () => {
    try {
      const value: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      resolve(isRecord(value) ? value : {});
    } catch {
      resolve({});
    }
  });
  request.on('error', reject);
});

const server = http.createServer(async (request, response) => {
  const send = (status: number, value: unknown): void => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
  };
  if (request.headers.authorization !== `Bearer ${token}`) return send(401, { ok: false, error: 'unauthorized' });
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (request.method === 'GET' && url.pathname === '/health') return send(200, { ok: true });
  const route = routes[url.pathname];
  if (!route || request.method !== 'POST') return send(404, { ok: false, error: 'not found' });
  try {
    send(200, await route(await readBody(request)));
  } catch (error) {
    send(500, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[session-todos] listening on 127.0.0.1:${port} (node ${process.versions.node})`);
});
