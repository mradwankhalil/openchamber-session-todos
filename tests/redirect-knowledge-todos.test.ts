import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { REDIRECT_PLUGIN } from '../service/redirect-plugin.ts';

// The exact text the service writes, loaded the way OpenCode loads it.
const file = path.join(mkdtempSync(path.join(tmpdir(), 'session-todos-plugin-')), 'plugin.mjs');
writeFileSync(file, REDIRECT_PLUGIN);
const { default: plugin, isNewBacklogTodo } = await import(pathToFileURL(file).href) as {
  default: { setup: (context: unknown) => Promise<void> };
  isNewBacklogTodo: (tool: unknown, input: unknown) => boolean;
};

const save = (parameters: Record<string, unknown>) => ({ action: 'knowledge.save', parameters });

describe('isNewBacklogTodo', () => {
  test('catches a new todo, however the tool name is prefixed', () => {
    expect(isNewBacklogTodo('openchamber_knowledge', save({ kind: 'todo', body: 'x' }))).toBe(true);
    expect(isNewBacklogTodo('mcp__openchamber__openchamber_knowledge', save({ kind: 'todo', body: 'x' }))).toBe(true);
  });
  test('reads the flat arguments the real tool call carries', () => {
    expect(isNewBacklogTodo('openchamber_knowledge', { action: 'knowledge.save', body: 'Buy milk', kind: 'todo' })).toBe(true);
    expect(isNewBacklogTodo('openchamber_knowledge', { action: 'knowledge.save', body: 'x', kind: 'note' })).toBe(false);
  });
  test('leaves notes, plans, edits and other actions alone', () => {
    expect(isNewBacklogTodo('openchamber_knowledge', save({ kind: 'note', body: 'x' }))).toBe(false);
    expect(isNewBacklogTodo('openchamber_knowledge', save({ kind: 'plan', body: 'x' }))).toBe(false);
    expect(isNewBacklogTodo('openchamber_knowledge', save({ kind: 'todo', id: 't1', completed: true }))).toBe(false);
    expect(isNewBacklogTodo('openchamber_knowledge', { action: 'knowledge.list', parameters: {} })).toBe(false);
    expect(isNewBacklogTodo('todowrite', save({ kind: 'todo' }))).toBe(false);
    expect(isNewBacklogTodo('openchamber_knowledge', null)).toBe(false);
  });
});

describe('the hook', () => {
  const run = async () => {
    let hook: (event: Record<string, unknown>) => Promise<void> = async () => undefined;
    await plugin.setup({ tool: { hook: async (_name, handler) => { hook = handler; } } });
    return hook;
  };
  const call = { tool: 'openchamber_knowledge', sessionID: 'a', input: save({ kind: 'todo', body: 'x' }) };

  test('refuses every new backlog todo, so a retry does not get through', async () => {
    const hook = await run();
    await expect(hook(call)).rejects.toThrow('todowrite');
    await expect(hook(call)).rejects.toThrow('todowrite');
  });
  test('other uses of the tool pass', async () => {
    const hook = await run();
    await expect(hook({ ...call, input: save({ kind: 'note', body: 'x' }) })).resolves.toBeUndefined();
    await expect(hook({ ...call, input: save({ kind: 'todo', id: 't1', completed: true }) })).resolves.toBeUndefined();
  });
  test('a host without hooks is left alone', async () => {
    await expect(plugin.setup({})).resolves.toBeUndefined();
  });
});
