import { describe, expect, test } from 'bun:test';

import {
  atLeast,
  chooseDatabase,
  configuredDepth,
  dataDirFromConfig,
  databaseDirs,
  editableConfig,
  enableTodoInText,
  newConfigPath,
  nextCursor,
  omoPlugin,
  parseJsonc,
  pickFromMessages,
  pickFromRow,
  pickFromRows,
  readScriptTodos,
  todoFlag,
} from '../service/sources.ts';

const tool = (status: string, content: string, extra: Record<string, unknown> = {}) => ({
  type: 'tool', name: 'todowrite', state: { status, input: { todos: [{ content, status: 'pending' }] } }, ...extra,
});

describe('atLeast', () => {
  test('compares numerically, not as text', () => {
    expect(atLeast('2.10.0', '2.9.0')).toBe(true);
    expect(atLeast('2.1.0', '2.1.0')).toBe(true);
    expect(atLeast('v2.2.4', '2.1.0')).toBe(true);
    expect(atLeast('2.0.25', '2.1.0')).toBe(false);
    expect(atLeast('2.2.0-beta.1', '2.1.0')).toBe(true);
  });
  test('an unreadable version is not new enough', () => {
    expect(atLeast('dev', '2.1.0')).toBe(false);
  });
});

describe('pickFromMessages', () => {
  test('takes the newest completed call, in the shape the route returned on a real turn', () => {
    const messages = [
      { id: 'msg_3', time: { created: 30 }, content: [tool('running', 'not yet')] },
      { id: 'msg_2', time: { created: 20 }, content: [{ type: 'text', text: 'x' }, tool('completed', 'latest')] },
      { id: 'msg_1', time: { created: 10 }, content: [tool('completed', 'older')] },
    ];
    expect(pickFromMessages(messages)).toEqual({ todos: [{ content: 'latest', status: 'pending' }], at: 20 });
  });
  test('skips a failed call', () => {
    expect(pickFromMessages([{ id: 'm', content: [tool('error', 'failed')] }])).toBeNull();
  });
  test('a call after the revert boundary does not count', () => {
    const messages = [{ id: 'msg_5', content: [tool('completed', 'undone')] }, { id: 'msg_2', content: [tool('completed', 'kept')] }];
    expect(pickFromMessages(messages, 'msg_4')?.todos[0]?.content).toBe('kept');
  });
  test('an empty list is still an answer', () => {
    const empty = { type: 'tool', name: 'todowrite', state: { status: 'completed', input: { todos: [] } } };
    expect(pickFromMessages([{ id: 'm', content: [empty] }])?.todos).toEqual([]);
  });
});

describe('todowrite inside a Code Mode script', () => {
  const script = (code: string, status = 'completed') => ({ type: 'tool', name: 'execute', state: { status, input: { code } } });
  const real = `await tools.todowrite({ todos: [
{content:"Model: move to shared/",status:"completed",priority:"high"},
{content:'it\\'s next', status:'in_progress', priority:'high',},
// a comment
{ "content": \`plain template\`, "status": "pending" }]}); return "ok";`;

  test('reads the list the way agents really write it', () => {
    expect(readScriptTodos(real)).toEqual([
      { content: 'Model: move to shared/', status: 'completed', priority: 'high' },
      { content: "it's next", status: 'in_progress', priority: 'high' },
      { content: 'plain template', status: 'pending' },
    ]);
  });

  test('the last call in a script wins', () => {
    expect(readScriptTodos('await tools.todowrite({todos:[{content:"a",status:"pending"}]}); await tools.todowrite({todos:[{content:"b",status:"pending"}]});')?.[0]?.content).toBe('b');
  });

  test('never runs anything, and gives up on what is computed', () => {
    const globals = globalThis as Record<string, unknown>;
    delete globals.__ran;
    expect(readScriptTodos('await tools.todowrite({todos:[{content:(globalThis.__ran=1,"x"),status:"pending"}]})')).toBeNull();
    expect(globals.__ran).toBeUndefined();
    expect(readScriptTodos('await tools.todowrite({todos: items})')).toBeNull();
    expect(readScriptTodos('await tools.todowrite({todos:[...old]})')).toBeNull();
    expect(readScriptTodos('await tools.todowrite({todos:[{content:`a ${b}`,status:"pending"}]})')).toBeNull();
    expect(readScriptTodos('await tools.todowrite(')).toBeNull();
    expect(readScriptTodos('nothing here')).toBeNull();
  });

  test('a real script in a session log is a list', () => {
    expect(pickFromMessages([{ id: 'm', time: { created: 9 }, content: [script(real)] }])?.todos).toHaveLength(3);
  });

  test('a script that failed does not count', () => {
    expect(pickFromMessages([{ id: 'm', content: [script(real, 'error')] }])).toBeNull();
  });

  test('a newer script it cannot read marks the older list as behind', () => {
    const hit = pickFromMessages([
      { id: 'b', content: [script('await tools.todowrite({todos: computed})')] },
      { id: 'a', content: [script('await tools.todowrite({todos:[{content:"older",status:"pending"}]})')] },
    ]);
    expect(hit?.todos[0]?.content).toBe('older');
    expect(hit?.behind).toBe(true);
    expect(pickFromMessages([{ id: 'b', content: [script('tools.todowrite({todos: computed})')] }])).toBeNull();
  });

  test('database rows read the same way', () => {
    const rows = [
      { data: JSON.stringify(script('tools.todowrite({todos: computed})')), at: 3 },
      { data: JSON.stringify(script('tools.todowrite({todos:[{content:"kept",status:"pending"}]})')), at: 2 },
    ];
    expect(pickFromRows(rows)).toEqual({ todos: [{ content: 'kept', status: 'pending' }], at: 2, behind: true });
    expect(pickFromRows([])).toBeNull();
  });
});

describe('omoPlugin', () => {
  test('reads the plugin list, whichever key and shape', () => {
    expect(omoPlugin([{ info: { plugins: ['file:///x/oh-my-openagent-fix-v2-int', 'other'] } }])).toBe(true);
    expect(omoPlugin([{ info: { plugin: [['oh-my-opencode', { a: 1 }]] } }])).toBe(true);
    expect(omoPlugin([{ info: { plugins: ['other'] } }])).toBe(false);
  });
  test('a config that lists no plugins says nothing', () => {
    expect(omoPlugin([{ info: {} }, { type: 'directory' }])).toBeNull();
  });
});

describe('nextCursor', () => {
  test('reads the shape the route really returns, and the older one', () => {
    expect(nextCursor({ data: [], cursor: { previous: 'p', next: 'n' } })).toBe('n');
    expect(nextCursor({ cursor: 's' })).toBe('s');
  });
  test('no more pages', () => {
    expect(nextCursor({ cursor: { previous: 'p' } })).toBeNull();
    expect(nextCursor({ cursor: null })).toBeNull();
    expect(nextCursor({ cursor: '' })).toBeNull();
    expect(nextCursor(null)).toBeNull();
  });
});

describe('pickFromRow', () => {
  test('reads an inline assistant row and a separate part row', () => {
    expect(pickFromRow(JSON.stringify({ content: [tool('completed', 'inline')] }), 5)).toEqual({ todos: [{ content: 'inline', status: 'pending' }], at: 5 });
    expect(pickFromRow(JSON.stringify(tool('completed', 'part')), 5)).toEqual({ todos: [{ content: 'part', status: 'pending' }], at: 5 });
  });
  test('ignores broken JSON and unrelated rows', () => {
    expect(pickFromRow('{"todowrite', 1)).toBeNull();
    expect(pickFromRow('{"a":1}', 1)).toBeNull();
    expect(pickFromRow(null, 1)).toBeNull();
  });
});

describe('enableTodoInText', () => {
  const on = (text: string): boolean => {
    const edit = enableTodoInText(text);
    if (!edit.ok) throw new Error(edit.reason);
    const value = parseJsonc(edit.text)?.experimental as { todo?: unknown };
    return value.todo === true;
  };

  test('adds it to a plain file', () => {
    expect(on('{\n  "shell": "bash"\n}\n')).toBe(true);
    expect(on('{}')).toBe(true);
  });

  test('keeps comments and neighbours', () => {
    const edit = enableTodoInText('{\n  // my shell\n  "shell": "bash", /* keep */\n  "experimental": {\n    "subagent_depth": 2,\n  },\n}\n');
    if (!edit.ok) throw new Error(edit.reason);
    expect(edit.text).toContain('// my shell');
    expect(edit.text).toContain('/* keep */');
    const parsed = parseJsonc(edit.text);
    expect(parsed?.shell).toBe('bash');
    expect(parsed?.experimental).toEqual({ todo: true, subagent_depth: 2 });
  });

  test('flips an explicit false', () => {
    const edit = enableTodoInText('{ "experimental": { "todo": false, "x": 1 } }');
    if (!edit.ok) throw new Error(edit.reason);
    expect(parseJsonc(edit.text)?.experimental).toEqual({ todo: true, x: 1 });
  });

  test('a key of the same name in a nested object is left alone', () => {
    const edit = enableTodoInText('{ "provider": { "experimental": { "todo": false } } }');
    if (!edit.ok) throw new Error(edit.reason);
    const parsed = parseJsonc(edit.text);
    expect(parsed?.experimental).toEqual({ todo: true });
    expect(parsed?.provider).toEqual({ experimental: { todo: false } });
  });

  test('turns off again, keeping comments and neighbours', () => {
    const edit = enableTodoInText('{\n  // mine\n  "experimental": { "todo": true, "x": 1 }\n}\n', false);
    if (!edit.ok) throw new Error(edit.reason);
    expect(edit.text).toContain('// mine');
    expect(parseJsonc(edit.text)?.experimental).toEqual({ todo: false, x: 1 });
    expect(enableTodoInText('{ "shell": "bash" }', false)).toEqual({ ok: true, text: '{ "shell": "bash" }', changed: false });
  });

  test('already on means no change', () => {
    expect(enableTodoInText('{ "experimental": { "todo": true } }')).toEqual({ ok: true, text: '{ "experimental": { "todo": true } }', changed: false });
  });

  test('refuses what it cannot read, rather than guess', () => {
    expect(enableTodoInText('{ broken').ok).toBe(false);
    expect(enableTodoInText('{ "experimental": 3 }').ok).toBe(false);
  });
});

describe('todoFlag and editableConfig', () => {
  const home = { type: 'document', path: '/h/opencode.json', info: { experimental: { todo: true } } };
  const managed = { type: 'document', path: '/run/opencode.managed.json', info: { experimental: { todo: false } } };

  test('a later document wins, and a managed one says who locked it', () => {
    expect(todoFlag([home])).toEqual({ on: true, lockedBy: null });
    expect(todoFlag([home, managed])).toEqual({ on: false, lockedBy: '/run/opencode.managed.json' });
    expect(todoFlag([{ type: 'directory', path: '/x' }])).toEqual({ on: false, lockedBy: null });
  });

  test('never picks a managed file or a folder to edit', () => {
    expect(editableConfig([{ type: 'directory', path: '/h' }, managed, home])).toBe('/h/opencode.json');
    expect(editableConfig([managed])).toBeNull();
    expect(editableConfig([{ type: 'document', info: {} }])).toBeNull();
  });
});

describe('configuredDepth', () => {
  const opencode = (depth: number) => ({ info: { experimental: { subagent_depth: depth } } });
  test('reads OpenCode\'s setting', () => {
    expect(configuredDepth([opencode(2)], false, [])).toBe(2);
  });
  test('with oh-my-openagent loaded, the larger limit decides', () => {
    expect(configuredDepth([opencode(2)], true, ['{ "background_task": { "maxDepth": 4 } }'])).toBe(4);
    expect(configuredDepth([opencode(3)], true, ['{ "background_task": { "maxDepth": 1 } }'])).toBe(3);
  });
  test('its default applies when it is loaded and says nothing; its comments are fine', () => {
    expect(configuredDepth([], true, ['{ // mine\n "x": 1 }'])).toBe(3);
  });
  test('a broken file or a plugin that is not loaded counts for nothing', () => {
    expect(configuredDepth([], false, ['{ "background_task": { "maxDepth": 4 } }'])).toBeNull();
    expect(configuredDepth([], true, ['{ broken'])).toBe(3);
    expect(configuredDepth([{ info: { experimental: { subagent_depth: 'x' } } }], false, [])).toBeNull();
  });
});

describe('newConfigPath', () => {
  const join = (...parts: string[]): string => parts.join('/');
  test('a fresh install with no config file gets one in its config folder', () => {
    expect(newConfigPath([{ type: 'directory', path: '/h/.config/opencode' }, { type: 'document', path: '/run/opencode.managed.json' }], join)).toBe('/h/.config/opencode/opencode.json');
    expect(newConfigPath([{ type: 'document', path: '/x.json' }], join)).toBeNull();
  });
});

describe('chooseDatabase', () => {
  const stale = { path: '/stale.db', newestMs: 900 };
  const real = { path: '/real.db', newestMs: 100 };

  test('the file holding the session beats a fresher one', () => {
    expect(chooseDatabase([stale, real], (path) => path === '/real.db')).toBe(real);
  });
  test('with no match, the freshest is the best guess', () => {
    expect(chooseDatabase([real, stale], () => false)).toBe(stale);
    expect(chooseDatabase([], () => true)).toBeNull();
  });
});

describe('dataDirFromConfig', () => {
  const join = (...parts: string[]): string => parts.join('/');
  test('follows a config folder that was moved', () => {
    expect(dataDirFromConfig('C:\\u\\.oc\\config\\opencode\\opencode.json', join)).toBe('C:/u/.oc/data/opencode');
    expect(dataDirFromConfig('/h/x/config/opencode/opencode.jsonc', join)).toBe('/h/x/data/opencode');
  });
  test('has nothing to say about an ordinary or unknown path', () => {
    expect(dataDirFromConfig('/h/.config/opencode/opencode.json', join)).toBeNull();
    expect(dataDirFromConfig(null, join)).toBeNull();
  });
});

describe('databaseDirs', () => {
  const join = (...parts: string[]): string => parts.join('/');
  test('uses only what a service can see', () => {
    expect(databaseDirs({}, '/h', 'linux', join)).toEqual(['/h/.local/share/opencode']);
    expect(databaseDirs({ XDG_DATA_HOME: '/x' }, '/h', 'linux', join)).toEqual(['/x/opencode', '/h/.local/share/opencode']);
    expect(databaseDirs({}, '/h', 'win32', join)).toContain('/h/AppData/Local/opencode');
    expect(databaseDirs({}, '/h', 'darwin', join)).toContain('/h/Library/Application Support/opencode');
  });
});
