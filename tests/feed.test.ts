import { beforeEach, describe, expect, test } from 'bun:test';

import { createFeed } from '../shared/feed.ts';

// The read loop's one promise: a list on screen is never blanked by a bad read.

const flush = async (): Promise<void> => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

type Session = { id: string; title: string };

const fakeHost = () => {
  const state = {
    file: '{}' as string | null,
    mtime: 1,
    service: async (_path: string): Promise<unknown> => ({ status: 'none', reason: 'No todo list in this session.' }),
    onSession: (_: Session | null): void => undefined,
    onDirectory: (_: string | null): void => undefined,
    onRead: null as null | (() => Promise<void>),
  };
  const host = {
    stat: async () => {
      if (state.file === null) throw new Error('no file');
      return { kind: 'file', size: state.file.length, mtime: state.mtime };
    },
    readFile: async () => {
      const content = state.file ?? '';
      if (state.onRead) await state.onRead();
      return { content };
    },
    serviceRequest: async ({ path }: { path: string }) => ({ status: 200, body: JSON.stringify(await state.service(path)) }),
    storage: { get: async () => null, set: async () => undefined },
    onSession: (listener: (session: Session | null) => void) => { state.onSession = listener; },
    onDirectory: (listener: (directory: string | null) => void) => { state.onDirectory = listener; },
    onSessionLifecycle: () => undefined,
  };
  return { state, host: host as never };
};

const list = (id: string, content: string): string => JSON.stringify({ [id]: [{ content, status: 'pending' }] });

// Left in place after each test: a feed's settle retry may still fire.
beforeEach(() => {
  Object.assign(globalThis, {
    window: { setInterval: () => 0, setTimeout: (run: () => void, ms: number) => setTimeout(run, ms), location: { href: 'about:srcdoc' } },
    document: { visibilityState: 'hidden' },
  });
});

const started = async (file: string) => {
  const { state, host } = fakeHost();
  state.file = file;
  const feed = createFeed(host, () => undefined);
  feed.start();
  state.onDirectory('/project');
  state.onSession({ id: 'a', title: 'A' });
  await flush();
  return { state, feed };
};

const shown = (feed: ReturnType<typeof createFeed>): string[] => (feed.view.kind === 'list' ? feed.view.todos.map((todo) => todo.content) : []);

describe('never blank', () => {
  test('reads the session\'s own list', async () => {
    const { feed } = await started(list('a', 'first'));
    expect(shown(feed)).toEqual(['first']);
  });

  test('a half-written file keeps what is on screen', async () => {
    const { state, feed } = await started(list('a', 'first'));
    state.file = '{"a":[{"content":"fir';
    state.mtime = 2;
    await feed.check();
    expect(shown(feed)).toEqual(['first']);
  });

  test('a file that went missing, with no service, keeps what is on screen', async () => {
    const { state, feed } = await started(list('a', 'first'));
    state.file = null;
    state.service = async () => { throw new Error('service down'); };
    await feed.check();
    expect(shown(feed)).toEqual(['first']);
  });

  test('a source that finds nothing does not blank a list', async () => {
    const { state, feed } = await started(list('a', 'first'));
    state.file = '{}';
    state.mtime = 2;
    await feed.check();
    expect(shown(feed)).toEqual(['first']);
  });

  test('an agent that emptied its own list is believed', async () => {
    const { state, feed } = await started(list('a', 'first'));
    state.file = JSON.stringify({ a: [] });
    state.mtime = 2;
    await feed.check();
    expect(shown(feed)).toEqual([]);
    expect(feed.view.kind).toBe('list');
  });
});

describe('session switch', () => {
  test('an answer for the old session is dropped', async () => {
    const { state, feed } = await started(list('a', 'first'));
    let release: () => void = () => undefined;
    state.onRead = () => new Promise((resolve) => { release = resolve; });
    state.file = JSON.stringify({ a: [{ content: 'late for a', status: 'pending' }], b: [{ content: 'for b', status: 'pending' }] });
    state.mtime = 2;
    const reading = feed.check();
    await flush();
    state.onRead = null;
    state.onSession({ id: 'b', title: 'B' });
    release();
    await reading;
    await flush();
    expect(shown(feed)).toEqual(['for b']);
  });

  test('the other session\'s list never shows for this one', async () => {
    const { state, feed } = await started(JSON.stringify({ other: [{ content: 'not mine', status: 'pending' }] }));
    await feed.check();
    expect(shown(feed)).toEqual([]);
    expect(state.file).toContain('not mine');
  });
});
