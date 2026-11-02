// service/main.ts
import { copyFile, mkdir, readFile, rename, stat, writeFile, unlink } from "node:fs/promises";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

// shared/model.ts
var STATUSES = new Set(["in_progress", "pending", "completed", "cancelled"]);
var isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var parseTodosFile = (raw) => {
  try {
    const parsed = JSON.parse(raw.replace(/^﻿/, ""));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};
var readTodos = (source) => {
  const list = Array.isArray(source) ? source : isRecord(source) && Array.isArray(source.todos) ? source.todos : [];
  const todos = [];
  for (const entry of list) {
    if (!isRecord(entry) || typeof entry.content !== "string")
      continue;
    const content = entry.content.replace(/\s+/g, " ").trim();
    if (!content)
      continue;
    const status = typeof entry.status === "string" && STATUSES.has(entry.status) ? entry.status : "pending";
    const todo = { content, status };
    if (typeof entry.priority === "string" && entry.priority)
      todo.priority = entry.priority;
    if (typeof entry.id === "string" && entry.id)
      todo.id = entry.id;
    todos.push(todo);
  }
  return todos;
};
var todosForSession = (file, sessionId) => {
  if (!file || !Object.hasOwn(file, sessionId))
    return [];
  return readTodos(file[sessionId]);
};
var readsOwnFile = (createdAt, switchedAt) => switchedAt === undefined || createdAt === null || createdAt < switchedAt;
var NOT_TAGS = new Set(["FIX", "TODO", "NOTE", "WIP"]);
var MAX_REVISIONS = 200;
var sameList = (left, right) => left.length === right.length && left.every((todo, index) => todo.content === right[index]?.content && todo.status === right[index]?.status);
var appendRevision = (revisions, todos, at, source, max = MAX_REVISIONS) => {
  const last = revisions[revisions.length - 1];
  if (last && sameList(last.todos, todos))
    return revisions;
  return [...revisions, { at, source, todos }].slice(-max);
};

// shared/settings.ts
var DEFAULTS = {
  textSize: 15,
  sectionTextSize: 13.75,
  sideWidth: 248,
  rowHeight: "normal",
  font: "host",
  customFont: "",
  colors: "theme",
  colorActive: "#7fc15f",
  colorNext: "#a3a1a9",
  colorDone: "#a3a1a9",
  colorAttention: "#e6a457",
  sectionRowHeight: "normal",
  sectionFont: "host",
  sectionCustomFont: "",
  sectionColors: "theme",
  sectionColorActive: "#7fc15f",
  sectionColorNext: "#a3a1a9",
  sectionColorDone: "#a3a1a9",
  sectionColorAttention: "#e6a457",
  motion: true,
  sectionLayout: "groups",
  sectionRows: 5,
  sectionTags: false,
  sectionHover: true,
  sectionWho: true,
  subagentDepth: "auto",
  tags: true,
  refs: true,
  priority: true,
  ticking: false,
  quietMinutes: 10,
  notify: true,
  badge: true,
  digest: true,
  overviewDays: 7,
  useOmo: true,
  useLog: true,
  useDatabase: true,
  history: true,
  nativeFolders: {},
  omoDir: ".omo/v2-state",
  databasePath: "",
  dataDir: ""
};
var clamp = (value, min, max, fallback) => typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
var oneOf = (value, allowed, fallback) => typeof value === "string" && allowed.includes(value) ? value : fallback;
var bool = (value, fallback) => typeof value === "boolean" ? value : fallback;
var text = (value, fallback, max = 400) => typeof value === "string" ? value.slice(0, max) : fallback;
var color = (value, fallback) => typeof value === "string" && /^#[0-9a-f]{3,8}$/i.test(value) ? value : fallback;
var readSettings = (raw) => {
  const value = isRecord(raw) ? raw : {};
  const d = DEFAULTS;
  const fontName = (raw2, fallback) => text(raw2, fallback, 120).replace(/[;{}<>]/g, "");
  const rowHeight = oneOf(value.rowHeight, ["tight", "normal", "roomy"], d.rowHeight);
  const font = oneOf(value.font, ["host", "mono", "custom"], d.font);
  const customFont = fontName(value.customFont, d.customFont);
  const colors = oneOf(value.colors, ["theme", "classic", "mono", "custom"], d.colors);
  const colorActive = color(value.colorActive, d.colorActive);
  const colorNext = color(value.colorNext, d.colorNext);
  const colorDone = color(value.colorDone, d.colorDone);
  const colorAttention = color(value.colorAttention, d.colorAttention);
  return {
    textSize: clamp(value.textSize, 11, 22, d.textSize),
    sectionTextSize: clamp(value.sectionTextSize, 11, 22, clamp(value.textSize, 11, 22, d.sectionTextSize)),
    sideWidth: Math.round(clamp(value.sideWidth, 160, 700, d.sideWidth)),
    rowHeight,
    font,
    customFont,
    colors,
    colorActive,
    colorNext,
    colorDone,
    colorAttention,
    sectionRowHeight: oneOf(value.sectionRowHeight, ["tight", "normal", "roomy"], rowHeight),
    sectionFont: oneOf(value.sectionFont, ["host", "mono", "custom"], font),
    sectionCustomFont: fontName(value.sectionCustomFont, customFont),
    sectionColors: oneOf(value.sectionColors, ["theme", "classic", "mono", "custom"], colors),
    sectionColorActive: color(value.sectionColorActive, colorActive),
    sectionColorNext: color(value.sectionColorNext, colorNext),
    sectionColorDone: color(value.sectionColorDone, colorDone),
    sectionColorAttention: color(value.sectionColorAttention, colorAttention),
    motion: bool(value.motion, d.motion),
    sectionLayout: oneOf(value.sectionLayout, ["glance", "groups"], d.sectionLayout),
    sectionRows: Math.round(clamp(value.sectionRows, 1, 10, d.sectionRows)),
    sectionTags: bool(value.sectionTags, d.sectionTags),
    sectionHover: bool(value.sectionHover, d.sectionHover),
    sectionWho: bool(value.sectionWho, d.sectionWho),
    subagentDepth: value.subagentDepth === 0 || value.subagentDepth === 1 || value.subagentDepth === 2 || value.subagentDepth === 3 || value.subagentDepth === 4 ? value.subagentDepth : "auto",
    tags: bool(value.tags, d.tags),
    refs: bool(value.refs, d.refs),
    priority: bool(value.priority, d.priority),
    ticking: bool(value.ticking, d.ticking),
    quietMinutes: Math.round(clamp(value.quietMinutes, 1, 240, d.quietMinutes)),
    notify: bool(value.notify, d.notify),
    badge: bool(value.badge, d.badge),
    digest: bool(value.digest, d.digest),
    overviewDays: Math.round(clamp(value.overviewDays, 1, 90, d.overviewDays)),
    useOmo: bool(value.useOmo, d.useOmo),
    useLog: bool(value.useLog, d.useLog),
    useDatabase: bool(value.useDatabase, d.useDatabase),
    history: bool(value.history, d.history),
    nativeFolders: isRecord(value.nativeFolders) ? Object.fromEntries(Object.entries(value.nativeFolders).filter((entry) => typeof entry[1] === "number")) : {},
    omoDir: text(value.omoDir, d.omoDir, 200).replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/(^|\/)\.\.(?=\/|$)/g, "") || d.omoDir,
    databasePath: text(value.databasePath, d.databasePath),
    dataDir: text(value.dataDir, d.dataDir)
  };
};

// service/sources.ts
var MIN_OPENCODE = "2.1.0";
var atLeast = (version, floor) => {
  const parse = (value) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  };
  const left = parse(version);
  const right = parse(floor);
  if (!left || !right)
    return false;
  for (let index = 0;index < 3; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b)
      return a > b;
  }
  return true;
};
var NOT_LITERAL = Symbol("not literal");
var readLiteral = (code, start) => {
  let index = start;
  const skip = () => {
    for (;; ) {
      while (index < code.length && /\s/.test(code[index] ?? ""))
        index += 1;
      if (code.startsWith("//", index)) {
        while (index < code.length && code[index] !== `
`)
          index += 1;
      } else if (code.startsWith("/*", index)) {
        const end = code.indexOf("*/", index + 2);
        index = end < 0 ? code.length : end + 2;
      } else
        return;
    }
  };
  const string = (quote) => {
    index += 1;
    let out = "";
    while (index < code.length && code[index] !== quote) {
      const char = code[index] ?? "";
      if (quote === "`" && code.startsWith("${", index))
        return NOT_LITERAL;
      if (char === "\\") {
        const next = code[index + 1] ?? "";
        out += { n: `
`, t: "\t", r: "\r" }[next] ?? next;
        index += 2;
      } else {
        out += char;
        index += 1;
      }
    }
    if (index >= code.length)
      return NOT_LITERAL;
    index += 1;
    return out;
  };
  const value = () => {
    skip();
    const char = code[index] ?? "";
    if (char === '"' || char === "'" || char === "`")
      return string(char);
    if (char === "[") {
      index += 1;
      const list = [];
      for (;; ) {
        skip();
        if (code[index] === "]") {
          index += 1;
          return list;
        }
        const item = value();
        if (item === NOT_LITERAL)
          return NOT_LITERAL;
        list.push(item);
        skip();
        if (code[index] === ",")
          index += 1;
        else if (code[index] !== "]")
          return NOT_LITERAL;
      }
    }
    if (char === "{") {
      index += 1;
      const object = {};
      for (;; ) {
        skip();
        if (code[index] === "}") {
          index += 1;
          return object;
        }
        const first = code[index] ?? "";
        let key;
        if (first === '"' || first === "'")
          key = string(first);
        else {
          const name = /^[A-Za-z_$][\w$]*/.exec(code.slice(index, index + 64));
          if (!name)
            return NOT_LITERAL;
          key = name[0];
          index += name[0].length;
        }
        if (typeof key !== "string")
          return NOT_LITERAL;
        skip();
        if (code[index] !== ":")
          return NOT_LITERAL;
        index += 1;
        const item = value();
        if (item === NOT_LITERAL)
          return NOT_LITERAL;
        object[key] = item;
        skip();
        if (code[index] === ",")
          index += 1;
        else if (code[index] !== "}")
          return NOT_LITERAL;
      }
    }
    const word = /^(true|false|null|-?\d+(?:\.\d+)?)(?![\w$.])/.exec(code.slice(index, index + 32));
    if (!word?.[1])
      return NOT_LITERAL;
    index += word[1].length;
    return JSON.parse(word[1]);
  };
  return value();
};
var readScriptTodos = (code) => {
  const calls = [...code.matchAll(/\btodowrite\s*\(/g)];
  const last = calls[calls.length - 1];
  if (!last)
    return null;
  const argument = readLiteral(code, last.index + last[0].length);
  return isRecord(argument) && Array.isArray(argument.todos) ? readTodos(argument.todos) : null;
};
var toolHit = (item, fallbackAt) => {
  if (!isRecord(item) || !isRecord(item.state))
    return null;
  if (item.state.status !== "completed" || !isRecord(item.state.input))
    return null;
  const { input } = item.state;
  const time = isRecord(item.time) ? item.time : {};
  const at = [time.completed, time.ended, time.created, time.started].find((value) => typeof value === "number") ?? fallbackAt;
  if (item.name === "todowrite")
    return Array.isArray(input.todos) ? { todos: readTodos(input.todos), at } : null;
  if (typeof input.code !== "string" || !/\btodowrite\s*\(/.test(input.code))
    return null;
  const todos = readScriptTodos(input.code);
  return todos ? { todos, at } : "unreadable";
};
var scanMessage = (message) => {
  const content = Array.isArray(message.content) ? message.content : [];
  const time = isRecord(message.time) ? message.time : {};
  const fallback = typeof time.created === "number" ? time.created : 0;
  let unreadable = false;
  for (let index = content.length - 1;index >= 0; index -= 1) {
    const hit = toolHit(content[index], fallback);
    if (hit === "unreadable")
      unreadable = true;
    else if (hit)
      return unreadable ? { ...hit, behind: true } : hit;
  }
  return unreadable ? "unreadable" : null;
};
var pickFromMessages = (messages, revertMessageId) => {
  let behind = false;
  for (const message of messages) {
    if (!isRecord(message))
      continue;
    if (revertMessageId && typeof message.id === "string" && message.id >= revertMessageId)
      continue;
    const hit = scanMessage(message);
    if (hit === "unreadable")
      behind = true;
    else if (hit)
      return behind ? { ...hit, behind: true } : hit;
  }
  return null;
};
var pickFromRow = (raw, at) => {
  if (typeof raw !== "string" || !raw.includes("todowrite"))
    return null;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const direct = toolHit(value, at);
  if (direct)
    return direct;
  return isRecord(value) ? scanMessage({ ...value, time: { created: at } }) : null;
};
var pickFromRows = (rows) => {
  let behind = false;
  for (const row of rows) {
    const hit = pickFromRow(row.data, Number(row.at) || 0);
    if (hit === "unreadable")
      behind = true;
    else if (hit)
      return behind ? { ...hit, behind: true } : hit;
  }
  return null;
};
var nextCursor = (body) => {
  if (!isRecord(body))
    return null;
  const { cursor } = body;
  if (typeof cursor === "string")
    return cursor || null;
  return isRecord(cursor) && typeof cursor.next === "string" && cursor.next ? cursor.next : null;
};
var stripJsonc = (text2) => {
  let out = "";
  let index = 0;
  while (index < text2.length) {
    const char = text2[index] ?? "";
    if (char === '"') {
      const start = index;
      index += 1;
      while (index < text2.length && text2[index] !== '"')
        index += text2[index] === "\\" ? 2 : 1;
      index += 1;
      out += text2.slice(start, index);
    } else if (char === "/" && text2[index + 1] === "/") {
      while (index < text2.length && text2[index] !== `
`)
        index += 1;
    } else if (char === "/" && text2[index + 1] === "*") {
      const end = text2.indexOf("*/", index + 2);
      index = end < 0 ? text2.length : end + 2;
    } else {
      out += char;
      index += 1;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
};
var parseJsonc = (text2) => {
  try {
    const value = JSON.parse(stripJsonc(text2.replace(/^﻿/, "")));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
};
var findKey = (text2, open, key) => {
  let depth = 0;
  let index = open;
  while (index < text2.length) {
    const char = text2[index] ?? "";
    if (char === "/" && text2[index + 1] === "/") {
      while (index < text2.length && text2[index] !== `
`)
        index += 1;
      continue;
    }
    if (char === "/" && text2[index + 1] === "*") {
      const end = text2.indexOf("*/", index + 2);
      index = end < 0 ? text2.length : end + 2;
      continue;
    }
    if (char === '"') {
      const start = index;
      index += 1;
      while (index < text2.length && text2[index] !== '"')
        index += text2[index] === "\\" ? 2 : 1;
      index += 1;
      if (depth === 1 && text2.slice(start + 1, index - 1) === key) {
        const rest = /^\s*:\s*/.exec(text2.slice(index));
        if (rest)
          return { keyStart: start, valueStart: index + rest[0].length };
      }
      continue;
    }
    if (char === "{" || char === "[")
      depth += 1;
    if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0)
        return null;
    }
    index += 1;
  }
  return null;
};
var insertFirst = (text2, open, entry) => {
  const inner = text2.slice(open + 1);
  const empty = /^\s*}/.test(stripJsonc(inner.slice(0, 200)));
  const line = text2.slice(0, open).lastIndexOf(`
`);
  const baseIndent = /^[ \t]*/.exec(text2.slice(line + 1, open))?.[0] ?? "";
  const eol = text2.includes(`\r
`) ? `\r
` : `
`;
  const indent = `${baseIndent}  `;
  return empty ? `${text2.slice(0, open + 1)}${eol}${indent}${entry}${eol}${baseIndent}${inner.trimStart()}` : `${text2.slice(0, open + 1)}${eol}${indent}${entry},${inner}`;
};
var enableTodoInText = (text2, value = true) => {
  const parsed = parseJsonc(text2);
  if (!parsed)
    return { ok: false, reason: "This config file could not be read as JSON." };
  const experimental = parsed.experimental;
  if (experimental !== undefined && !isRecord(experimental))
    return { ok: false, reason: '"experimental" in this file is not an object.' };
  const current = isRecord(experimental) ? experimental.todo : undefined;
  if (current === value || !value && current === undefined)
    return { ok: true, text: text2, changed: false };
  const root = text2.indexOf("{");
  const found = findKey(text2, root, "experimental");
  let next;
  if (!found)
    next = insertFirst(text2, root, `"experimental": { "todo": ${value} }`);
  else {
    const inner = findKey(text2, found.valueStart, "todo");
    if (inner) {
      const tail = text2.slice(inner.valueStart);
      const old = /^(true|false|null)/.exec(tail);
      if (!old)
        return { ok: false, reason: '"experimental.todo" in this file has an unexpected value.' };
      next = `${text2.slice(0, inner.valueStart)}${value}${tail.slice(old[0].length)}`;
    } else
      next = insertFirst(text2, found.valueStart, `"todo": ${value}`);
  }
  const check = parseJsonc(next);
  if (!isRecord(check?.experimental) || check.experimental.todo !== value)
    return { ok: false, reason: "The edit could not be made safely." };
  return { ok: true, text: next, changed: true };
};
var todoFlag = (documents) => {
  let on = false;
  let lockedBy = null;
  for (const document2 of documents) {
    if (!isRecord(document2.info) || !isRecord(document2.info.experimental))
      continue;
    const value = document2.info.experimental.todo;
    if (typeof value !== "boolean")
      continue;
    on = value;
    lockedBy = typeof document2.path === "string" && /managed/i.test(document2.path) ? document2.path : null;
  }
  return { on, lockedBy };
};
var editableConfig = (documents) => {
  for (const document2 of documents) {
    if (document2.type !== "document" || typeof document2.path !== "string")
      continue;
    if (!/\.jsonc?$/i.test(document2.path) || /managed/i.test(document2.path))
      continue;
    return document2.path;
  }
  return null;
};
var omoPlugin = (documents) => {
  let listed = false;
  for (const document2 of documents) {
    if (!isRecord(document2.info))
      continue;
    for (const entries of [document2.info.plugins, document2.info.plugin]) {
      if (!Array.isArray(entries))
        continue;
      listed = true;
      if (/oh-my-open(?:agent|code)/i.test(JSON.stringify(entries)))
        return true;
    }
  }
  return listed ? false : null;
};
var newConfigPath = (documents, join) => {
  for (const document2 of documents) {
    if (document2.type === "directory" && typeof document2.path === "string")
      return join(document2.path, "opencode.json");
  }
  return null;
};
var OMO_DEFAULT_DEPTH = 3;
var OMO_CONFIG_FILES = ["oh-my-openagent.jsonc", "oh-my-openagent.json", "oh-my-opencode.jsonc", "oh-my-opencode.json"];
var configuredDepth = (documents, omoLoaded, omoConfigs) => {
  const found = [];
  for (const document2 of documents) {
    if (isRecord(document2.info) && isRecord(document2.info.experimental) && typeof document2.info.experimental.subagent_depth === "number")
      found.push(document2.info.experimental.subagent_depth);
  }
  if (omoLoaded) {
    let omo = null;
    for (const text2 of omoConfigs) {
      const parsed = parseJsonc(text2);
      const task = isRecord(parsed) ? parsed.background_task : null;
      if (isRecord(task) && typeof task.maxDepth === "number")
        omo = task.maxDepth;
    }
    found.push(omo ?? OMO_DEFAULT_DEPTH);
  }
  return found.length > 0 ? Math.max(...found) : null;
};
var TODO_SNIPPET = '"experimental": { "todo": true }';
var chooseDatabase = (candidates, holds) => {
  const sorted = [...candidates].sort((left, right) => right.newestMs - left.newestMs);
  return sorted.find((candidate) => holds(candidate.path)) ?? sorted[0] ?? null;
};
var dataDirFromConfig = (configPath, join) => {
  if (!configPath)
    return null;
  const parts = configPath.replace(/\\/g, "/").split("/");
  const at = parts.lastIndexOf("config");
  if (at < 1 || parts[at + 1] !== "opencode")
    return null;
  return join(...parts.slice(0, at), "data", "opencode");
};
var databaseDirs = (env, home, platform, join) => {
  const dirs = [];
  if (env.XDG_DATA_HOME)
    dirs.push(join(env.XDG_DATA_HOME, "opencode"));
  dirs.push(join(home, ".local", "share", "opencode"));
  if (platform === "win32") {
    if (env.LOCALAPPDATA)
      dirs.push(join(env.LOCALAPPDATA, "opencode"));
    dirs.push(join(home, "AppData", "Local", "opencode"));
  }
  if (platform === "darwin")
    dirs.push(join(home, "Library", "Application Support", "opencode"));
  return [...new Set(dirs)];
};

// service/redirect-plugin.ts
var REDIRECT_FILE = "session-todos-redirect.js";
var REDIRECT_MARK = "// Installed by Session Todos.";
var REDIRECT_PLUGIN = `${REDIRECT_MARK} Turn it off from its setup check, or delete this file.
//
// Stops agents creating project backlog todos with openchamber_knowledge and points them at
// todowrite. Notes, plans, edits to existing items and the Project panel are untouched.
const TOOL = 'openchamber_knowledge';
const MESSAGE = 'Not saved, and retrying will not save it: agents do not create project backlog todos here. To track work in this session, use the todowrite tool. If the user wants a backlog item, tell them to add it in the Project panel.';

export const isNewBacklogTodo = (tool, input) => {
  if (!String(tool ?? '').endsWith(TOOL) || typeof input !== 'object' || input === null) return false;
  if (input.action !== 'knowledge.save') return false;
  // The arguments sit beside action, or under parameters, depending on the harness.
  const parameters = typeof input.parameters === 'object' && input.parameters !== null ? input.parameters : input;
  return parameters.kind === 'todo' && !parameters.id;
};

export default {
  id: 'session-todos.redirect-knowledge-todos',
  async setup(context) {
    if (typeof context?.tool?.hook !== 'function') return;
    await context.tool.hook('execute.before', async (event) => {
      if (isNewBacklogTodo(event?.tool, event?.input ?? event?.args)) throw new Error(MESSAGE);
    });
  },
};
`;

// service/main.ts
var port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
var token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? "";
var settings = DEFAULTS;
var serverOrigin = null;
var offeredOrigin = null;
var settingsFiles = () => [
  ...process.env.XDG_CONFIG_HOME ? [path.join(process.env.XDG_CONFIG_HOME, "openchamber", "settings.json")] : [],
  path.join(os.homedir(), ".config", "openchamber", "settings.json")
];
var isOpenChamber = async (origin) => {
  try {
    const response = await fetch(new URL("/health", origin), { signal: AbortSignal.timeout(1500), redirect: "manual" });
    if (!response.ok)
      return false;
    const body = await response.json();
    return isRecord(body) && typeof body.openchamberVersion === "string";
  } catch {
    return false;
  }
};
var resolveOrigin = async () => {
  if (serverOrigin && await isOpenChamber(serverOrigin))
    return serverOrigin;
  serverOrigin = null;
  const candidates = [];
  if (offeredOrigin)
    candidates.push(offeredOrigin);
  for (const file of settingsFiles()) {
    try {
      const raw = JSON.parse(await readFile(file, "utf8"));
      if (isRecord(raw) && typeof raw.desktopLocalPort === "number")
        candidates.push(`http://127.0.0.1:${raw.desktopLocalPort}`);
    } catch {}
  }
  for (const candidate of candidates) {
    if (await isOpenChamber(candidate))
      return serverOrigin = candidate;
  }
  return null;
};
var api = async (route, options = {}) => {
  const origin = await resolveOrigin();
  if (!origin)
    return { status: 0, body: null };
  const response = await fetch(new URL(route, origin), {
    method: options.method ?? "GET",
    headers: { Accept: "application/json", ...options.directory ? { "x-opencode-directory": options.directory } : {} },
    signal: AbortSignal.timeout(options.timeoutMs ?? 6000),
    redirect: "manual"
  });
  const text2 = await response.text();
  let body = null;
  try {
    body = text2 ? JSON.parse(text2) : null;
  } catch {}
  return { status: response.status, body };
};
var dbCtor;
var sqlite = () => {
  if (dbCtor !== undefined)
    return dbCtor;
  try {
    const require2 = createRequire(import.meta.url);
    dbCtor = require2("node:sqlite").DatabaseSync;
  } catch {
    dbCtor = null;
  }
  return dbCtor;
};
var withDb = (file, run) => {
  const Ctor = sqlite();
  if (!Ctor)
    return null;
  let db = null;
  try {
    db = new Ctor(file, { readOnly: true, timeout: 1500 });
    return run(db);
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {}
  }
};
var tables = (db) => new Set(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all().map((row) => String(row.name)));
var extraDataDir = null;
var databaseCandidates = () => {
  if (settings.databasePath.trim()) {
    const file = settings.databasePath.trim().replace(/^~(?=[/\\])/, os.homedir());
    return fs.existsSync(file) ? [{ path: file, newestMs: Date.now() }] : [];
  }
  const out = [];
  const dirs = databaseDirs(process.env, os.homedir(), process.platform, path.join);
  for (const dir of extraDataDir ? [extraDataDir, ...dirs] : dirs) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/^opencode(?:-[\w.-]+)?\.db$/.test(name))
        continue;
      const file = path.join(dir, name);
      const main = fs.statSync(file, { throwIfNoEntry: false });
      const wal = fs.statSync(`${file}-wal`, { throwIfNoEntry: false });
      if (main)
        out.push({ path: file, newestMs: Math.max(main.mtimeMs, wal?.mtimeMs ?? 0) });
    }
  }
  return out;
};
var holdsSession = (file, sessionId) => withDb(file, (db) => {
  const names = tables(db);
  if (names.has("session_v2") && db.prepare("SELECT 1 FROM session_v2 WHERE id = ?").get(sessionId))
    return true;
  return names.has("session") && db.prepare("SELECT 1 FROM session WHERE id = ?").get(sessionId) !== undefined;
}) === true;
var databaseFor = (sessionId) => chooseDatabase(databaseCandidates(), (file) => sessionId ? holdsSession(file, sessionId) : false)?.path ?? null;
var found = (hit, source) => ({
  todos: hit.todos,
  at: hit.at,
  source: hit.behind ? `${source}, an older version` : source
});
var fromDatabase = (sessionId) => {
  const file = databaseFor(sessionId);
  if (!file || !holdsSession(file, sessionId))
    return null;
  return withDb(file, (db) => {
    const names = tables(db);
    if (names.has("session_part")) {
      const rows = db.prepare("SELECT data, time_created AS at FROM session_part WHERE session_id = ? AND data LIKE '%todowrite%' ORDER BY time_created DESC LIMIT 60").all(sessionId);
      const hit = pickFromRows(rows.map((row) => ({ data: row.data, at: row.at })));
      if (hit)
        return found(hit, "database");
    }
    if (names.has("session_message")) {
      const rows = db.prepare("SELECT data, time_created AS at FROM session_message WHERE session_id = ? AND type = 'assistant' AND data LIKE '%todowrite%' ORDER BY seq DESC LIMIT 60").all(sessionId);
      const hit = pickFromRows(rows.map((row) => ({ data: row.data, at: row.at })));
      if (hit)
        return found(hit, "database");
    }
    if (names.has("todo")) {
      const rows = db.prepare("SELECT content, status, priority, time_updated AS at FROM todo WHERE session_id = ? ORDER BY position").all(sessionId);
      if (rows.length > 0)
        return { todos: readTodos(rows), at: Math.max(...rows.map((row) => Number(row.at) || 0)), source: "old list" };
    }
    return null;
  });
};
var omoRead = async (directory, name) => {
  const file = path.join(directory, ...settings.omoDir.split("/"), name);
  try {
    const [text2, info] = await Promise.all([readFile(file, "utf8"), stat(file)]);
    const value = parseTodosFile(text2);
    return value ? { value, at: info.mtimeMs } : null;
  } catch {
    return null;
  }
};
var created = new Map;
var sessionCreatedAt = async (sessionId, directory) => {
  const known = created.get(sessionId);
  if (known !== undefined)
    return known;
  try {
    const answer = await api(`/api/session/${encodeURIComponent(sessionId)}`, { directory });
    const data = isRecord(answer.body) && isRecord(answer.body.data) ? answer.body.data : isRecord(answer.body) ? answer.body : {};
    const time = isRecord(data.time) ? data.time : {};
    if (typeof time.created !== "number")
      return null;
    created.set(sessionId, time.created);
    return time.created;
  } catch {
    return null;
  }
};
var fromOmo = async (sessionId, directory, anySession = false) => {
  if (!settings.useOmo || !directory)
    return null;
  const file = await omoRead(directory, "todos.json");
  if (!file || !Object.hasOwn(file.value, sessionId))
    return null;
  const switchedAt = settings.nativeFolders[directory];
  if (!anySession && switchedAt !== undefined && !readsOwnFile(await sessionCreatedAt(sessionId, directory), switchedAt))
    return null;
  return { todos: todosForSession(file.value, sessionId), at: file.at, source: "oh-my-openagent" };
};
var fromLog = async (sessionId, directory) => {
  if (!settings.useLog)
    return null;
  const session = await api(`/api/session/${encodeURIComponent(sessionId)}`, { directory });
  if (session.status !== 200 || !isRecord(session.body))
    return null;
  const data = isRecord(session.body.data) ? session.body.data : session.body;
  const revert = isRecord(data.revert) && typeof data.revert.messageID === "string" ? data.revert.messageID : null;
  let cursor = null;
  for (let page = 0;page < 4; page += 1) {
    const query = cursor ? `limit=100&cursor=${encodeURIComponent(cursor)}` : "limit=100&order=desc";
    const answer = await api(`/api/session/${encodeURIComponent(sessionId)}/message?${query}`, { directory, timeoutMs: 8000 });
    if (answer.status !== 200 || !isRecord(answer.body) || !Array.isArray(answer.body.data))
      return null;
    const hit = pickFromMessages(answer.body.data, revert);
    if (hit)
      return found(hit, "OpenCode session");
    cursor = answer.body.data.length > 0 ? nextCursor(answer.body) : null;
    if (!cursor)
      return null;
  }
  return null;
};
var cache = new Map;
var freshFor = (answer) => {
  if (answer.status === "none")
    return 8000;
  return answer.source === "oh-my-openagent" ? 1500 : 4000;
};
var readList = async (sessionId, directory, atLeastMs = 0) => {
  const hit = cache.get(sessionId);
  if (hit && Date.now() - hit.at < Math.max(atLeastMs, freshFor(hit.answer)))
    return hit.answer;
  let list = await fromOmo(sessionId, directory);
  if (!list) {
    try {
      list = await fromLog(sessionId, directory);
    } catch {
      list = null;
    }
  }
  if (!list && settings.useDatabase)
    list = fromDatabase(sessionId);
  if (!list)
    list = await fromOmo(sessionId, directory, true);
  const answer = list ? { status: "ok", ...list } : { status: "none", reason: "No todo list in this session." };
  cache.set(sessionId, { at: Date.now(), answer });
  if (cache.size > 400)
    cache.delete(cache.keys().next().value);
  if (list)
    record(sessionId, list);
  return answer;
};
var historyDir = () => path.join(settings.dataDir.trim().replace(/^~(?=[/\\])/, os.homedir()) || path.join(os.homedir(), ".local", "share", "openchamber-session-todos"), "history");
var historyFile = (sessionId) => path.join(historyDir(), `${sessionId.replace(/[^\w.-]/g, "_")}.json`);
var histories = new Map;
var loadHistory = async (sessionId) => {
  const known = histories.get(sessionId);
  if (known)
    return known;
  let revisions = [];
  try {
    const raw = JSON.parse(await readFile(historyFile(sessionId), "utf8"));
    if (Array.isArray(raw))
      revisions = raw.flatMap((entry) => isRecord(entry) && typeof entry.at === "number" ? [{ at: entry.at, source: String(entry.source ?? ""), todos: readTodos(entry.todos) }] : []);
  } catch {}
  histories.set(sessionId, revisions);
  return revisions;
};
var record = async (sessionId, list) => {
  if (!settings.history || list.todos.length === 0)
    return;
  try {
    const revisions = await loadHistory(sessionId);
    const next = appendRevision(revisions, list.todos, list.at || Date.now(), list.source);
    if (next === revisions)
      return;
    histories.set(sessionId, next);
    const file = historyFile(sessionId);
    await mkdir(path.dirname(file), { recursive: true });
    const scratch = `${file}.${process.pid}.tmp`;
    await writeFile(scratch, JSON.stringify(next));
    await rename(scratch, file);
  } catch {}
};
var watched = new Map;
var WATCH_MS = 5000;
var WATCH_MAX = 12;
setInterval(() => {
  if (!settings.history)
    return;
  for (const [id, directory] of [...watched].slice(-WATCH_MAX))
    readList(id, directory).catch(() => {
      return;
    });
}, WATCH_MS).unref();
var readConfig = async (directory = null) => {
  const answer = await api("/api/config", { directory });
  return answer.status === 200 && Array.isArray(answer.body) ? answer.body : null;
};
var readDepth = async (documents) => {
  const plugin = omoPlugin(documents);
  const config = editableConfig(documents);
  const texts = plugin && config ? (await Promise.all(OMO_CONFIG_FILES.map((name) => readFile(path.join(path.dirname(config), name), "utf8").catch(() => null)))).filter((text2) => text2 !== null) : [];
  return configuredDepth(documents, plugin, texts);
};
var depthCache = null;
var DEPTH_FRESH_MS = 30000;
var cachedDepth = async () => {
  if (depthCache && Date.now() - depthCache.at < DEPTH_FRESH_MS)
    return depthCache.value;
  const documents = await readConfig().catch(() => null);
  const value = documents ? await readDepth(documents) : null;
  depthCache = { at: Date.now(), value };
  return value;
};
var report = async (sessionId, directory) => {
  const origin = await resolveOrigin();
  let version = null;
  let configPath = null;
  let plugin = null;
  let todo = null;
  let redirect = { on: false, path: null };
  let access = origin ? "open" : "unreachable";
  if (origin) {
    const info = await api("/api/opencode/version").catch(() => null);
    if (info?.status === 401 || info?.status === 403)
      access = "locked";
    if (isRecord(info?.body) && typeof info.body.version === "string")
      version = info.body.version;
    const documents = await readConfig(directory).catch(() => null);
    if (documents) {
      redirect = await redirectState(redirectPath(documents));
      todo = todoFlag(documents);
      configPath = editableConfig(documents) ?? newConfigPath(documents, path.join);
      plugin = omoPlugin(documents);
      extraDataDir = dataDirFromConfig(configPath, path.join);
    }
  }
  const omoFolder = directory ? path.join(directory, ...settings.omoDir.split("/")) : null;
  const database = databaseFor(sessionId);
  const omoFile = directory ? await omoRead(directory, "todos.json") : null;
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
    omo: { found: omoFolder ? fs.existsSync(path.join(omoFolder, "todos.json")) : false, folder: omoFolder, plugin, holdsSession: Boolean(omoFile && sessionId && Object.hasOwn(omoFile.value, sessionId)) },
    database: { path: database, sqlite: sqlite() !== null, holdsSession: Boolean(database && sessionId && holdsSession(database, sessionId)) },
    historyDir: historyDir(),
    subagentDepth: await cachedDepth(),
    node: process.versions.node
  };
};
var folderConfig = (directory) => path.join(directory, ".opencode", "opencode.json");
var setTodo = async (options) => {
  const { reload, directory, value } = options;
  const documents = directory ? null : await readConfig();
  const file = directory ? folderConfig(directory) : documents ? editableConfig(documents) ?? newConfigPath(documents, path.join) : null;
  if (!file)
    return { ok: false, reason: "OpenChamber did not say which config file to change.", snippet: TODO_SNIPPET };
  let text2;
  let existed = true;
  try {
    text2 = await readFile(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT")
      return { ok: false, reason: `Could not read ${file}.`, path: file, snippet: TODO_SNIPPET };
    if (!value)
      return { ok: true, path: file, backup: null, changed: false, reloaded: false };
    text2 = `{}
`;
    existed = false;
  }
  const edit = enableTodoInText(text2, value);
  if (!edit.ok)
    return { ok: false, reason: edit.reason, path: file, snippet: TODO_SNIPPET };
  let backup = null;
  if (edit.changed) {
    try {
      if (existed) {
        backup = `${file}.session-todos.bak`;
        await copyFile(file, backup);
      } else
        await mkdir(path.dirname(file), { recursive: true });
      const scratch = `${file}.${process.pid}.tmp`;
      await writeFile(scratch, edit.text);
      await rename(scratch, file);
    } catch {
      return { ok: false, reason: `Could not write ${file}.`, path: file, snippet: TODO_SNIPPET };
    }
  }
  let reloaded = false;
  if (reload) {
    const answer = await api("/api/location/reload", { method: "POST", timeoutMs: 15000, directory }).catch(() => null);
    reloaded = answer !== null && answer.status >= 200 && answer.status < 300;
  }
  return { ok: true, path: file, backup, changed: edit.changed, reloaded };
};
var redirectPath = (documents) => {
  const config = documents ? editableConfig(documents) ?? newConfigPath(documents, path.join) : null;
  return config ? path.join(path.dirname(config), "plugins", REDIRECT_FILE) : null;
};
var redirectState = async (file) => ({
  on: file ? (await readFile(file, "utf8").catch(() => "")).startsWith(REDIRECT_MARK) : false,
  path: file
});
var setRedirect = async (on) => {
  const file = redirectPath(await readConfig().catch(() => null));
  if (!file)
    return { ok: false, reason: "OpenChamber did not say where your config is." };
  const current = await readFile(file, "utf8").catch(() => null);
  if (current !== null && !current.startsWith(REDIRECT_MARK))
    return { ok: false, path: file, reason: `${file} is not ours, so it was left alone.` };
  if (on === (current !== null) && (!on || current === REDIRECT_PLUGIN))
    return { ok: true, path: file, changed: false };
  try {
    if (on) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, REDIRECT_PLUGIN);
    } else
      await unlink(file);
  } catch {
    return { ok: false, path: file, reason: `Could not change ${file}.` };
  }
  return { ok: true, path: file, changed: true };
};
var sessionTitle = async (sessionId, directory) => {
  try {
    const answer = await api(`/api/session/${encodeURIComponent(sessionId)}`, { directory });
    const data = isRecord(answer.body) ? isRecord(answer.body.data) ? answer.body.data : answer.body : {};
    return { title: typeof data.title === "string" ? data.title : null, agent: typeof data.agent === "string" ? data.agent : null, cost: typeof data.cost === "number" ? data.cost : null };
  } catch {
    return { title: null, agent: null, cost: null };
  }
};
var claims = new Map;
var sessionList = null;
var SESSIONS_FRESH_MS = 15000;
var SESSION_PAGES = 10;
var LISTS_FRESH_MS = 15000;
var LISTS_AT_ONCE = 6;
var routes = {
  "/v1/hello": async (body) => {
    if (typeof body.origin === "string" && /^https?:\/\//.test(body.origin))
      offeredOrigin = body.origin;
    if (body.settings !== undefined)
      settings = readSettings(body.settings);
    return { ok: true };
  },
  "/v1/report": (body) => report(typeof body.sessionId === "string" ? body.sessionId : null, typeof body.directory === "string" ? body.directory : null),
  "/v1/list": async (body) => {
    const id = String(body.sessionId ?? "");
    const directory = typeof body.directory === "string" ? body.directory : null;
    if (!id)
      return { status: "none", reason: "No session." };
    watched.delete(id);
    watched.set(id, directory);
    if (watched.size > WATCH_MAX * 4)
      watched.delete(watched.keys().next().value);
    return readList(id, directory);
  },
  "/v1/lists": async (body) => {
    const sessions = Array.isArray(body.sessions) ? body.sessions.filter(isRecord).slice(0, 200) : [];
    const out = {};
    const queue = [...sessions];
    const worker = async () => {
      for (let session = queue.shift();session; session = queue.shift()) {
        const id = String(session.id ?? "");
        if (!id)
          continue;
        const directory = typeof session.directory === "string" ? session.directory : null;
        out[id] = { ...await readList(id, directory, LISTS_FRESH_MS).catch(() => ({ status: "none", reason: "" })), ...body.titles === true ? await sessionTitle(id, directory) : {} };
      }
    };
    await Promise.all(Array.from({ length: LISTS_AT_ONCE }, worker));
    return { lists: out };
  },
  "/v1/children": async (body) => {
    const id = String(body.sessionId ?? "");
    const directory = typeof body.directory === "string" ? body.directory : null;
    if (!directory)
      return { children: [], parents: {}, depth: await cachedDepth() };
    const parents = await omoRead(directory, "parents.json");
    const file = await omoRead(directory, "todos.json");
    const ids = parents ? Object.entries(parents.value).filter(([, parent]) => parent === id).map(([child]) => child) : [];
    return { children: ids, lists: file ? ids.filter((child) => Object.hasOwn(file.value, child)) : [], parents: parents?.value ?? {}, depth: await cachedDepth() };
  },
  "/v1/backlog": async (body) => {
    const id = typeof body.projectId === "string" ? body.projectId : "";
    if (!id)
      return { todos: [] };
    const answer = await api(`/api/project-context/${encodeURIComponent(id)}`).catch(() => null);
    return { todos: answer?.status === 200 && isRecord(answer.body) && Array.isArray(answer.body.todos) ? answer.body.todos : [] };
  },
  "/v1/sessions": async () => {
    if (sessionList && Date.now() - sessionList.at < SESSIONS_FRESH_MS)
      return { sessions: sessionList.value };
    const value = [];
    let cursor = null;
    let complete = false;
    for (let page = 0;page < SESSION_PAGES; page += 1) {
      const answer = await api(`/api/session?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { timeoutMs: 8000 }).catch(() => null);
      if (answer?.status !== 200 || !isRecord(answer.body) || !Array.isArray(answer.body.data))
        break;
      for (const raw of answer.body.data)
        if (isRecord(raw))
          value.push({ id: raw.id, title: raw.title, parentID: raw.parentID, location: raw.location, time: raw.time });
      cursor = answer.body.data.length > 0 ? nextCursor(answer.body) : null;
      if (!cursor) {
        complete = true;
        break;
      }
    }
    if (complete || value.length > 0)
      sessionList = { at: Date.now(), value };
    return { sessions: value };
  },
  "/v1/session": async (body) => {
    const answer = await api(`/api/session/${encodeURIComponent(String(body.sessionId ?? ""))}`, { directory: typeof body.directory === "string" ? body.directory : null }).catch(() => null);
    return { session: isRecord(answer?.body) ? isRecord(answer.body.data) ? answer.body.data : answer.body : null };
  },
  "/v1/history": async (body) => ({ revisions: await loadHistory(String(body.sessionId ?? "")) }),
  "/v1/redirect": (body) => setRedirect(body.on === true),
  "/v1/enable-todo": (body) => setTodo({ reload: body.reload === true, directory: typeof body.directory === "string" ? body.directory : null, value: body.value !== false }),
  "/v1/reload": async (body) => {
    const answer = await api("/api/location/reload", { method: "POST", timeoutMs: 15000, directory: typeof body.directory === "string" ? body.directory : null }).catch(() => null);
    return { ok: answer !== null && answer.status >= 200 && answer.status < 300 };
  },
  "/v1/claim": async (body) => {
    const key = String(body.key ?? "");
    if (!key || claims.has(key))
      return { first: false };
    claims.set(key, Date.now());
    if (claims.size > 500)
      claims.delete(claims.keys().next().value);
    return { first: true };
  },
  "/v1/export": async (body) => {
    const dir = path.dirname(historyDir());
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `export-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    await writeFile(file, JSON.stringify(body.data ?? {}, null, 2));
    return { path: file };
  }
};
var readBody = (request) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  request.on("data", (chunk) => {
    size += chunk.length;
    if (size > 8000000) {
      reject(new Error("Too large"));
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.on("end", () => {
    try {
      const value = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      resolve(isRecord(value) ? value : {});
    } catch {
      resolve({});
    }
  });
  request.on("error", reject);
});
var server = http.createServer(async (request, response) => {
  const send = (status, value) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  };
  if (request.headers.authorization !== `Bearer ${token}`)
    return send(401, { ok: false, error: "unauthorized" });
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/health")
    return send(200, { ok: true });
  const route = routes[url.pathname];
  if (!route || request.method !== "POST")
    return send(404, { ok: false, error: "not found" });
  try {
    send(200, await route(await readBody(request)));
  } catch (error) {
    send(500, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
server.listen(port, "127.0.0.1", () => {
  console.log(`[session-todos] listening on 127.0.0.1:${port} (node ${process.versions.node})`);
});
