// Pure pieces of the service: testable with no server, no files and no SQLite.
import { isRecord, readTodos, type Todo } from '../shared/model.ts';

export const MIN_OPENCODE = '2.1.0';

/** `2.2.4` >= `2.1.0`. A leading `v` and any pre-release suffix are ignored; unreadable means false. */
export const atLeast = (version: string, floor: string): boolean => {
  const parse = (value: string): number[] | null => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  };
  const left = parse(version);
  const right = parse(floor);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
};

export type ToolHit = { todos: Todo[]; at: number; behind?: true };

// A plain JavaScript literal, read and never run. Anything computed gives up.
const NOT_LITERAL = Symbol('not literal');

const readLiteral = (code: string, start: number): unknown => {
  let index = start;
  const skip = (): void => {
    for (;;) {
      while (index < code.length && /\s/.test(code[index] ?? '')) index += 1;
      if (code.startsWith('//', index)) {
        while (index < code.length && code[index] !== '\n') index += 1;
      } else if (code.startsWith('/*', index)) {
        const end = code.indexOf('*/', index + 2);
        index = end < 0 ? code.length : end + 2;
      } else return;
    }
  };
  const string = (quote: string): string | typeof NOT_LITERAL => {
    index += 1;
    let out = '';
    while (index < code.length && code[index] !== quote) {
      const char = code[index] ?? '';
      if (quote === '`' && code.startsWith('${', index)) return NOT_LITERAL;
      if (char === '\\') {
        const next = code[index + 1] ?? '';
        out += ({ n: '\n', t: '\t', r: '\r' } as Record<string, string>)[next] ?? next;
        index += 2;
      } else {
        out += char;
        index += 1;
      }
    }
    if (index >= code.length) return NOT_LITERAL;
    index += 1;
    return out;
  };
  const value = (): unknown => {
    skip();
    const char = code[index] ?? '';
    if (char === '"' || char === "'" || char === '`') return string(char);
    if (char === '[') {
      index += 1;
      const list: unknown[] = [];
      for (;;) {
        skip();
        if (code[index] === ']') { index += 1; return list; }
        const item = value();
        if (item === NOT_LITERAL) return NOT_LITERAL;
        list.push(item);
        skip();
        if (code[index] === ',') index += 1;
        else if (code[index] !== ']') return NOT_LITERAL;
      }
    }
    if (char === '{') {
      index += 1;
      const object: Record<string, unknown> = {};
      for (;;) {
        skip();
        if (code[index] === '}') { index += 1; return object; }
        const first = code[index] ?? '';
        let key: unknown;
        if (first === '"' || first === "'") key = string(first);
        else {
          const name = /^[A-Za-z_$][\w$]*/.exec(code.slice(index, index + 64));
          if (!name) return NOT_LITERAL;
          key = name[0];
          index += name[0].length;
        }
        if (typeof key !== 'string') return NOT_LITERAL;
        skip();
        if (code[index] !== ':') return NOT_LITERAL;
        index += 1;
        const item = value();
        if (item === NOT_LITERAL) return NOT_LITERAL;
        object[key] = item;
        skip();
        if (code[index] === ',') index += 1;
        else if (code[index] !== '}') return NOT_LITERAL;
      }
    }
    const word = /^(true|false|null|-?\d+(?:\.\d+)?)(?![\w$.])/.exec(code.slice(index, index + 32));
    if (!word?.[1]) return NOT_LITERAL;
    index += word[1].length;
    return JSON.parse(word[1]);
  };
  return value();
};

/** The list in a script's last `todowrite(...)` call. `null` when the script doesn't spell it out. */
export const readScriptTodos = (code: string): Todo[] | null => {
  const calls = [...code.matchAll(/\btodowrite\s*\(/g)];
  const last = calls[calls.length - 1];
  if (!last) return null;
  const argument = readLiteral(code, last.index + last[0].length);
  return isRecord(argument) && Array.isArray(argument.todos) ? readTodos(argument.todos) : null;
};

const toolHit = (item: unknown, fallbackAt: number): ToolHit | 'unreadable' | null => {
  if (!isRecord(item) || !isRecord(item.state)) return null;
  if (item.state.status !== 'completed' || !isRecord(item.state.input)) return null;
  const { input } = item.state;
  const time = isRecord(item.time) ? item.time : {};
  const at = [time.completed, time.ended, time.created, time.started].find((value): value is number => typeof value === 'number') ?? fallbackAt;
  if (item.name === 'todowrite') return Array.isArray(input.todos) ? { todos: readTodos(input.todos), at } : null;
  // Code Mode: the agent wrote a script that calls the tool.
  if (typeof input.code !== 'string' || !/\btodowrite\s*\(/.test(input.code)) return null;
  const todos = readScriptTodos(input.code);
  return todos ? { todos, at } : 'unreadable';
};

const scanMessage = (message: Record<string, unknown>): ToolHit | 'unreadable' | null => {
  const content = Array.isArray(message.content) ? message.content : [];
  const time = isRecord(message.time) ? message.time : {};
  const fallback = typeof time.created === 'number' ? time.created : 0;
  let unreadable = false;
  for (let index = content.length - 1; index >= 0; index -= 1) {
    const hit = toolHit(content[index], fallback);
    if (hit === 'unreadable') unreadable = true;
    else if (hit) return unreadable ? { ...hit, behind: true } : hit;
  }
  return unreadable ? 'unreadable' : null;
};

/**
 * The current list is the newest completed `todowrite`: OpenCode keeps no other
 * record of it. Messages arrive newest first; those after a revert boundary
 * were undone, so they don't count. A newer call this can't read marks the
 * answer `behind`, so nobody takes an older list for the current one.
 */
export const pickFromMessages = (messages: unknown[], revertMessageId?: string | null): ToolHit | null => {
  let behind = false;
  for (const message of messages) {
    if (!isRecord(message)) continue;
    if (revertMessageId && typeof message.id === 'string' && message.id >= revertMessageId) continue;
    const hit = scanMessage(message);
    if (hit === 'unreadable') behind = true;
    else if (hit) return behind ? { ...hit, behind: true } : hit;
  }
  return null;
};

/** One row's JSON from `session_message.data` or `session_part.data`. Tolerant of both shapes. */
export const pickFromRow = (raw: unknown, at: number): ToolHit | 'unreadable' | null => {
  if (typeof raw !== 'string' || !raw.includes('todowrite')) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const direct = toolHit(value, at);
  if (direct) return direct;
  return isRecord(value) ? scanMessage({ ...value, time: { created: at } }) : null;
};

/** Rows newest first. */
export const pickFromRows = (rows: { data: unknown; at: unknown }[]): ToolHit | null => {
  let behind = false;
  for (const row of rows) {
    const hit = pickFromRow(row.data, Number(row.at) || 0);
    if (hit === 'unreadable') behind = true;
    else if (hit) return behind ? { ...hit, behind: true } : hit;
  }
  return null;
};

/** The route's next-page cursor: `{ previous, next }`, or a plain string on older servers. */
export const nextCursor = (body: unknown): string | null => {
  if (!isRecord(body)) return null;
  const { cursor } = body;
  if (typeof cursor === 'string') return cursor || null;
  return isRecord(cursor) && typeof cursor.next === 'string' && cursor.next ? cursor.next : null;
};

// ----- Config -----

/** JSONC to JSON, leaving text inside strings alone. */
export const stripJsonc = (text: string): string => {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index] ?? '';
    if (char === '"') {
      const start = index;
      index += 1;
      while (index < text.length && text[index] !== '"') index += text[index] === '\\' ? 2 : 1;
      index += 1;
      out += text.slice(start, index);
    } else if (char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
    } else if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2);
      index = end < 0 ? text.length : end + 2;
    } else {
      out += char;
      index += 1;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
};

export const parseJsonc = (text: string): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(stripJsonc(text.replace(/^﻿/, '')));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
};

export type ConfigEdit = { ok: true; text: string; changed: boolean } | { ok: false; reason: string };

// Finds a key at the top level of the object opening at `open`, skipping strings, comments and nested values.
const findKey = (text: string, open: number, key: string): { keyStart: number; valueStart: number } | null => {
  let depth = 0;
  let index = open;
  while (index < text.length) {
    const char = text[index] ?? '';
    if (char === '/' && text[index + 1] === '/') { while (index < text.length && text[index] !== '\n') index += 1; continue; }
    if (char === '/' && text[index + 1] === '*') { const end = text.indexOf('*/', index + 2); index = end < 0 ? text.length : end + 2; continue; }
    if (char === '"') {
      const start = index;
      index += 1;
      while (index < text.length && text[index] !== '"') index += text[index] === '\\' ? 2 : 1;
      index += 1;
      if (depth === 1 && text.slice(start + 1, index - 1) === key) {
        const rest = /^\s*:\s*/.exec(text.slice(index));
        if (rest) return { keyStart: start, valueStart: index + rest[0].length };
      }
      continue;
    }
    if (char === '{' || char === '[') depth += 1;
    if (char === '}' || char === ']') { depth -= 1; if (depth === 0) return null; }
    index += 1;
  }
  return null;
};

const insertFirst = (text: string, open: number, entry: string): string => {
  const inner = text.slice(open + 1);
  const empty = /^\s*}/.test(stripJsonc(inner.slice(0, 200)));
  const line = text.slice(0, open).lastIndexOf('\n');
  const baseIndent = /^[ \t]*/.exec(text.slice(line + 1, open))?.[0] ?? '';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const indent = `${baseIndent}  `;
  return empty
    ? `${text.slice(0, open + 1)}${eol}${indent}${entry}${eol}${baseIndent}${inner.trimStart()}`
    : `${text.slice(0, open + 1)}${eol}${indent}${entry},${inner}`;
};

/** Sets `experimental.todo` by editing the text, so comments and layout survive. The result must parse, or nothing is written. */
export const enableTodoInText = (text: string, value = true): ConfigEdit => {
  const parsed = parseJsonc(text);
  if (!parsed) return { ok: false, reason: 'This config file could not be read as JSON.' };
  const experimental = parsed.experimental;
  if (experimental !== undefined && !isRecord(experimental)) return { ok: false, reason: '"experimental" in this file is not an object.' };
  const current = isRecord(experimental) ? experimental.todo : undefined;
  if (current === value || (!value && current === undefined)) return { ok: true, text, changed: false };

  const root = text.indexOf('{');
  const found = findKey(text, root, 'experimental');
  let next: string;
  if (!found) next = insertFirst(text, root, `"experimental": { "todo": ${value} }`);
  else {
    const inner = findKey(text, found.valueStart, 'todo');
    if (inner) {
      const tail = text.slice(inner.valueStart);
      const old = /^(true|false|null)/.exec(tail);
      if (!old) return { ok: false, reason: '"experimental.todo" in this file has an unexpected value.' };
      next = `${text.slice(0, inner.valueStart)}${value}${tail.slice(old[0].length)}`;
    } else next = insertFirst(text, found.valueStart, `"todo": ${value}`);
  }
  const check = parseJsonc(next);
  if (!isRecord(check?.experimental) || check.experimental.todo !== value) return { ok: false, reason: 'The edit could not be made safely.' };
  return { ok: true, text: next, changed: true };
};

export type ConfigDocument = { type?: unknown; path?: unknown; info?: unknown };

/** `/api/config` lists each layer. Later documents win, as the managed one does. */
export const todoFlag = (documents: ConfigDocument[]): { on: boolean; lockedBy: string | null } => {
  let on = false;
  let lockedBy: string | null = null;
  for (const document of documents) {
    if (!isRecord(document.info) || !isRecord(document.info.experimental)) continue;
    const value = document.info.experimental.todo;
    if (typeof value !== 'boolean') continue;
    on = value;
    lockedBy = typeof document.path === 'string' && /managed/i.test(document.path) ? document.path : null;
  }
  return { on, lockedBy };
};

/** The user's own global config file: a real document, never a managed one. */
export const editableConfig = (documents: ConfigDocument[]): string | null => {
  for (const document of documents) {
    if (document.type !== 'document' || typeof document.path !== 'string') continue;
    if (!/\.jsonc?$/i.test(document.path) || /managed/i.test(document.path)) continue;
    return document.path;
  }
  return null;
};

/** Whether the config loads oh-my-openagent. `null` when the config doesn't say. A leftover list file proves nothing. */
export const omoPlugin = (documents: ConfigDocument[]): boolean | null => {
  let listed = false;
  for (const document of documents) {
    if (!isRecord(document.info)) continue;
    for (const entries of [document.info.plugins, document.info.plugin]) {
      if (!Array.isArray(entries)) continue;
      listed = true;
      if (/oh-my-open(?:agent|code)/i.test(JSON.stringify(entries))) return true;
    }
  }
  return listed ? false : null;
};

/** Where the user's global config goes when there is no file yet: their config folder. */
export const newConfigPath = (documents: ConfigDocument[], join: (...parts: string[]) => string): string | null => {
  for (const document of documents) {
    if (document.type === 'directory' && typeof document.path === 'string') return join(document.path, 'opencode.json');
  }
  return null;
};

const OMO_DEFAULT_DEPTH = 3;
export const OMO_CONFIG_FILES = ['oh-my-openagent.jsonc', 'oh-my-openagent.json', 'oh-my-opencode.jsonc', 'oh-my-opencode.json'];

/**
 * How deep subagents can go, from what is configured. OpenCode's limit and
 * oh-my-openagent's are separate, so the larger one decides what can exist.
 * `null` when nothing says.
 */
export const configuredDepth = (documents: ConfigDocument[], omoLoaded: boolean | null, omoConfigs: string[]): number | null => {
  const found: number[] = [];
  for (const document of documents) {
    if (isRecord(document.info) && isRecord(document.info.experimental) && typeof document.info.experimental.subagent_depth === 'number') found.push(document.info.experimental.subagent_depth);
  }
  if (omoLoaded) {
    let omo: number | null = null;
    for (const text of omoConfigs) {
      const parsed = parseJsonc(text);
      const task = isRecord(parsed) ? parsed.background_task : null;
      if (isRecord(task) && typeof task.maxDepth === 'number') omo = task.maxDepth;
    }
    found.push(omo ?? OMO_DEFAULT_DEPTH);
  }
  return found.length > 0 ? Math.max(...found) : null;
};

export const TODO_SNIPPET = '"experimental": { "todo": true }';

// ----- Finding the database -----

/** The right file holds this session. Freshest only breaks a tie, or decides when there is no session to look up. */
export const chooseDatabase = <T extends { path: string; newestMs: number }>(candidates: T[], holds: (path: string) => boolean): T | null => {
  const sorted = [...candidates].sort((left, right) => right.newestMs - left.newestMs);
  return sorted.find((candidate) => holds(candidate.path)) ?? sorted[0] ?? null;
};

/** OpenCode moved with XDG roots: `<root>/config/opencode/x.json` means data is likely at `<root>/data/opencode`. */
export const dataDirFromConfig = (configPath: string | null, join: (...parts: string[]) => string): string | null => {
  if (!configPath) return null;
  const parts = configPath.replace(/\\/g, '/').split('/');
  const at = parts.lastIndexOf('config');
  if (at < 1 || parts[at + 1] !== 'opencode') return null;
  return join(...parts.slice(0, at), 'data', 'opencode');
};

export const databaseDirs = (env: Record<string, string | undefined>, home: string, platform: string, join: (...parts: string[]) => string): string[] => {
  const dirs: string[] = [];
  if (env.XDG_DATA_HOME) dirs.push(join(env.XDG_DATA_HOME, 'opencode'));
  dirs.push(join(home, '.local', 'share', 'opencode'));
  if (platform === 'win32') {
    if (env.LOCALAPPDATA) dirs.push(join(env.LOCALAPPDATA, 'opencode'));
    dirs.push(join(home, 'AppData', 'Local', 'opencode'));
  }
  if (platform === 'darwin') dirs.push(join(home, 'Library', 'Application Support', 'opencode'));
  return [...new Set(dirs)];
};
