import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

// The built service, as a real process, against a stand-in OpenChamber. Needs Node
// with node:sqlite and `bun run build` first. Touches only a temp folder.

const root = mkdtempSync(path.join(tmpdir(), 'session-todos-run-'));
const configFile = path.join(root, 'opencode.json');
const dbFile = path.join(root, 'opencode.db');
const token = 'test-token';
let child: ChildProcess;
let servicePort = 0;
let fake: http.Server;
let fakeOrigin = '';
// What the stand-in does right now.
const host = { locked: false, reloads: 0, messages: [] as unknown[], olderPage: null as unknown[] | null };

const freePort = (): Promise<number> => new Promise((resolve) => {
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1', () => {
    const { port } = socket.address() as net.AddressInfo;
    socket.close(() => resolve(port));
  });
});

const call = async (route: string, body: unknown = {}): Promise<Record<string, unknown>> => {
  const response = await fetch(`http://127.0.0.1:${servicePort}${route}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  return await response.json() as Record<string, unknown>;
};

const seedDatabase = (): void => {
  const code = `const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(${JSON.stringify(dbFile)});
    db.exec("CREATE TABLE session_v2 (id TEXT); CREATE TABLE session_part (session_id TEXT, data TEXT, time_created INTEGER)");
    db.prepare('INSERT INTO session_v2 VALUES (?)').run('ses_indatabase');
    db.prepare('INSERT INTO session_part VALUES (?, ?, ?)').run('ses_indatabase', JSON.stringify({ type: 'tool', name: 'todowrite', state: { status: 'completed', input: { todos: [{ content: 'from the database', status: 'pending' }] } } }), 50);
    db.close();`;
  const run = Bun.spawnSync(['node', '--no-warnings', '-e', code]);
  if (run.exitCode !== 0) throw new Error(run.stderr.toString());
};

beforeAll(async () => {
  seedDatabase();
  fake = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const send = (status: number, value: unknown): void => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if (url.pathname === '/health') return send(200, { openchamberVersion: '2.5.3' });
    if (host.locked) return send(401, { error: 'password' });
    if (url.pathname === '/api/opencode/version') return send(200, { version: '2.2.4' });
    if (url.pathname === '/api/config') return send(200, [{ type: 'document', path: configFile, info: parsedConfig() }]);
    if (url.pathname === '/api/location/reload') { host.reloads += 1; return send(200, { ok: true }); }
    if (/^\/api\/session\/[^/]+$/.test(url.pathname)) return send(200, { data: { title: 'A session', agent: 'general', time: { created: url.pathname.includes('ses_new') ? 2000 : 1000 } } });
    if (/\/message$/.test(url.pathname)) {
      if (url.searchParams.get('cursor') && url.searchParams.get('order')) return send(400, { message: 'Cursor cannot be combined with order' });
      if (host.olderPage && !url.searchParams.get('cursor')) return send(200, { data: [{ id: 'm9', content: [{ type: 'text', text: 'nothing here' }] }], cursor: { previous: 'p', next: 'page2' } });
      if (host.olderPage) return send(200, { data: host.olderPage, cursor: { previous: 'p2' } });
      return send(200, { data: host.messages, cursor: null });
    }
    return send(404, {});
  });
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
  fakeOrigin = `http://127.0.0.1:${(fake.address() as net.AddressInfo).port}`;

  servicePort = await freePort();
  child = spawn('node', ['--no-warnings', path.resolve('service/main.js')], {
    env: { PATH: process.env.PATH, Path: process.env.Path, HOME: root, USERPROFILE: root, SystemRoot: process.env.SystemRoot, OPENCHAMBER_SERVICE_PORT: String(servicePort), OPENCHAMBER_SERVICE_TOKEN: token } as NodeJS.ProcessEnv,
    stdio: 'ignore',
  });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const health = await fetch(`http://127.0.0.1:${servicePort}/health`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(500) });
      if (health.ok) break;
    } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  await call('/v1/hello', { origin: fakeOrigin, settings: { databasePath: dbFile, dataDir: path.join(root, 'data') } });
});

afterAll(() => {
  child?.kill();
  fake?.close();
  try { rmSync(root, { recursive: true, force: true }); } catch { /* the process may still hold it for a moment */ }
});

const stripped = (): string => readFileSync(configFile, 'utf8').replace(/\/\/.*$/gm, '');
const parsedConfig = (): unknown => {
  try { return JSON.parse(stripped()); } catch { return {}; }
};

describe('backlog redirect', () => {
  const plugin = (): string => path.join(root, 'plugins', 'session-todos-redirect.js');
  test('installs, reports and removes its own file', async () => {
    expect((await call('/v1/redirect', { on: true })).changed).toBe(true);
    expect(readFileSync(plugin(), 'utf8')).toContain('openchamber_knowledge');
    expect((await call('/v1/report', {})).redirect).toEqual({ on: true, path: plugin() });
    expect((await call('/v1/redirect', { on: true })).changed).toBe(false);
    expect((await call('/v1/redirect', { on: false })).changed).toBe(true);
    expect(existsSync(plugin())).toBe(false);
    expect((await call('/v1/redirect', { on: false })).changed).toBe(false);
  });
  test('a file of the same name that is not ours is left alone', async () => {
    await call('/v1/redirect', { on: true });
    writeFileSync(plugin(), '// somebody else');
    const answer = await call('/v1/redirect', { on: false });
    expect(answer.ok).toBe(false);
    expect(readFileSync(plugin(), 'utf8')).toBe('// somebody else');
    expect((await call('/v1/redirect', { on: true })).ok).toBe(false);
    rmSync(plugin());
  });
});

describe('the service as a process', () => {
  test('refuses a caller without the token', async () => {
    const response = await fetch(`http://127.0.0.1:${servicePort}/v1/report`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(401);
  });

  test('reads a list from the session log, and records it', async () => {
    host.messages = [{ id: 'm1', time: { created: 7 }, content: [{ type: 'tool', name: 'todowrite', state: { status: 'completed', input: { todos: [{ content: 'from the log', status: 'in_progress' }] } } }] }];
    const answer = await call('/v1/list', { sessionId: 'ses_inlog', directory: root });
    expect(answer.source).toBe('OpenCode session');
    expect(answer.todos).toEqual([{ content: 'from the log', status: 'in_progress' }]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const history = await call('/v1/history', { sessionId: 'ses_inlog' });
    expect(history.revisions).toHaveLength(1);
    expect(existsSync(path.join(root, 'data', 'history', 'ses_inlog.json'))).toBe(true);
  });

  test('finds a list older than the first page of messages', async () => {
    host.olderPage = [{ id: 'm1', time: { created: 7 }, content: [{ type: 'tool', name: 'todowrite', state: { status: 'completed', input: { todos: [{ content: 'on page two', status: 'pending' }] } } }] }];
    const answer = await call('/v1/list', { sessionId: 'ses_deep', directory: root });
    host.olderPage = null;
    expect(answer.todos).toEqual([{ content: 'on page two', status: 'pending' }]);
  });

  test('prefers the agent\'s file, for this session only', async () => {
    const folder = path.join(root, 'project', '.omo', 'v2-state');
    Bun.spawnSync(['node', '-e', `require('fs').mkdirSync(${JSON.stringify(folder)},{recursive:true})`]);
    writeFileSync(path.join(folder, 'todos.json'), JSON.stringify({ ses_omo: [{ content: 'from the file', status: 'pending' }], other: [{ content: 'not mine', status: 'pending' }] }));
    const answer = await call('/v1/list', { sessionId: 'ses_omo', directory: path.join(root, 'project') });
    expect(answer.source).toBe('oh-my-openagent');
    expect(answer.todos).toEqual([{ content: 'from the file', status: 'pending' }]);
  });

  test('with a password set, falls back to the database, read-only', async () => {
    host.locked = true;
    const before = statSync(dbFile).mtimeMs;
    const answer = await call('/v1/list', { sessionId: 'ses_indatabase', directory: root });
    const report = await call('/v1/report', { sessionId: 'ses_indatabase', directory: root });
    host.locked = false;
    expect(answer.source).toBe('database');
    expect(answer.todos).toEqual([{ content: 'from the database', status: 'pending' }]);
    expect(report.access).toBe('locked');
    expect((report.database as { holdsSession: boolean }).holdsSession).toBe(true);
    expect(statSync(dbFile).mtimeMs).toBe(before);
  });

  test('a database that does not hold the session gives no list', async () => {
    host.locked = true;
    const answer = await call('/v1/list', { sessionId: 'ses_elsewhere', directory: root });
    host.locked = false;
    expect(answer.status).toBe('none');
  });

  test('turning the todo tool on keeps comments, backs up, and can wait for agents', async () => {
    const original = '{\n  // mine\n  "shell": "bash"\n}\n';
    writeFileSync(configFile, original);
    host.reloads = 0;
    const waited = await call('/v1/enable-todo', { reload: false });
    expect(waited.ok).toBe(true);
    expect(waited.reloaded).toBe(false);
    expect(host.reloads).toBe(0);
    expect(readFileSync(String(waited.backup), 'utf8')).toBe(original);
    expect(readFileSync(configFile, 'utf8')).toContain('// mine');
    expect(JSON.parse(stripped()).experimental.todo).toBe(true);

    const report = await call('/v1/report', {});
    expect(report.todo).toEqual({ on: true, lockedBy: null });

    const again = await call('/v1/enable-todo', { reload: true });
    expect(again.changed).toBe(false);
    expect(host.reloads).toBe(1);
  });

  test('one folder: makes its own config, touches no other, and can be undone', async () => {
    const folder = path.join(root, 'one-folder');
    const globalBefore = readFileSync(configFile, 'utf8');
    const on = await call('/v1/enable-todo', { reload: true, directory: folder });
    const file = path.join(folder, '.opencode', 'opencode.json');
    expect(on.path).toBe(file);
    expect(on.backup).toBeNull();
    expect(JSON.parse(readFileSync(file, 'utf8')).experimental.todo).toBe(true);
    expect(readFileSync(configFile, 'utf8')).toBe(globalBefore);
    const off = await call('/v1/enable-todo', { reload: false, directory: folder, value: false });
    expect(off.ok).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8')).experimental.todo).toBe(false);
    expect(readFileSync(configFile, 'utf8')).toBe(globalBefore);
  });

  test('after a folder switches, sessions already there keep the agent\'s file; new ones read the log', async () => {
    const project = path.join(root, 'switched');
    const folder = path.join(project, '.omo', 'v2-state');
    Bun.spawnSync(['node', '-e', `require('fs').mkdirSync(${JSON.stringify(folder)},{recursive:true})`]);
    const item = (content: string) => [{ content, status: 'pending' }];
    writeFileSync(path.join(folder, 'todos.json'), JSON.stringify({ ses_old: item('old, from the file'), ses_new: item('new, from the file') }));
    host.messages = [{ id: 'm1', time: { created: 2100 }, content: [{ type: 'tool', name: 'todowrite', state: { status: 'completed', input: { todos: item('new, from the log') } } }] }];
    await call('/v1/hello', { origin: fakeOrigin, settings: { databasePath: dbFile, dataDir: path.join(root, 'data'), nativeFolders: { [project]: 1500 } } });
    const old = await call('/v1/list', { sessionId: 'ses_old', directory: project });
    const fresh = await call('/v1/list', { sessionId: 'ses_new', directory: project });
    expect(old.source).toBe('oh-my-openagent');
    expect(old.todos).toEqual(item('old, from the file'));
    expect(fresh.source).toBe('OpenCode session');
    expect(fresh.todos).toEqual(item('new, from the log'));
    await call('/v1/hello', { origin: fakeOrigin, settings: { databasePath: dbFile, dataDir: path.join(root, 'data') } });
  });

  test('a config it cannot read is left alone, and the snippet is offered', async () => {
    const broken = '{ "shell": ';
    writeFileSync(configFile, broken);
    const answer = await fetch(`http://127.0.0.1:${servicePort}/v1/enable-todo`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}', signal: AbortSignal.timeout(10000) }).then((response) => response.json()) as Record<string, unknown>;
    expect(answer.ok).toBe(false);
    expect(answer.snippet).toContain('experimental');
    expect(readFileSync(configFile, 'utf8')).toBe(broken);
  });

  test('the first to ask gets to tell the user', async () => {
    expect((await call('/v1/claim', { key: 'k' })).first).toBe(true);
    expect((await call('/v1/claim', { key: 'k' })).first).toBe(false);
  });
});
