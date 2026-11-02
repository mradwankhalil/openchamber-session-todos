import { isRecord, type DepthSetting } from './model.ts';

// Everything a user can change. Stored once, in extension storage, read by every frame.

export type Settings = {
  /** The panel and its pages. */
  textSize: number;
  /** The Work Status section, which sits beside other sections and is matched to them. */
  sectionTextSize: number;
  /** The right column of a split, in px. */
  sideWidth: number;
  rowHeight: 'tight' | 'normal' | 'roomy';
  font: 'host' | 'mono' | 'custom';
  customFont: string;
  colors: 'theme' | 'classic' | 'mono' | 'custom';
  colorActive: string;
  colorNext: string;
  colorDone: string;
  colorAttention: string;
  /** The section's own look, apart from the panel's. */
  sectionRowHeight: 'tight' | 'normal' | 'roomy';
  sectionFont: 'host' | 'mono' | 'custom';
  sectionCustomFont: string;
  sectionColors: 'theme' | 'classic' | 'mono' | 'custom';
  motion: boolean;
  sectionLayout: 'glance' | 'groups';
  sectionRows: number;
  sectionTags: boolean;
  sectionHover: boolean;
  sectionWho: boolean;
  subagentDepth: DepthSetting;
  tags: boolean;
  refs: boolean;
  priority: boolean;
  ticking: boolean;
  quietMinutes: number;
  notify: boolean;
  badge: boolean;
  digest: boolean;
  overviewDays: number;
  useOmo: boolean;
  useLog: boolean;
  useDatabase: boolean;
  history: boolean;
  /** Folder -> when it switched to OpenCode's todo tool. Sessions started before that keep their source. */
  nativeFolders: Record<string, number>;
  omoDir: string;
  databasePath: string;
  dataDir: string;
};

export const DEFAULTS: Settings = {
  textSize: 15,
  sectionTextSize: 13.75,
  sideWidth: 248,
  rowHeight: 'normal',
  font: 'host',
  customFont: '',
  colors: 'theme',
  colorActive: '#5b9fe8',
  colorNext: '#a3a1a9',
  colorDone: '#7fc15f',
  colorAttention: '#e6a457',
  sectionRowHeight: 'normal',
  sectionFont: 'host',
  sectionCustomFont: '',
  sectionColors: 'theme',
  motion: true,
  sectionLayout: 'groups',
  sectionRows: 5,
  sectionTags: false,
  sectionHover: true,
  sectionWho: true,
  subagentDepth: 'auto',
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
  omoDir: '.omo/v2-state',
  databasePath: '',
  dataDir: '',
};

const clamp = (value: unknown, min: number, max: number, fallback: number): number => (
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
);
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => (
  typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : fallback
);
const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);
const text = (value: unknown, fallback: string, max = 400): string => (typeof value === 'string' ? value.slice(0, max) : fallback);
// Only a plain hex colour reaches a style rule.
const color = (value: unknown, fallback: string): string => (typeof value === 'string' && /^#[0-9a-f]{3,8}$/i.test(value) ? value : fallback);

/** Anything from storage, made safe. Unknown keys go; missing ones take the default. */
export const readSettings = (raw: unknown): Settings => {
  const value = isRecord(raw) ? raw : {};
  const d = DEFAULTS;
  const fontName = (raw: unknown, fallback: string): string => text(raw, fallback, 120).replace(/[;{}<>]/g, '');
  const rowHeight = oneOf(value.rowHeight, ['tight', 'normal', 'roomy'], d.rowHeight);
  const font = oneOf(value.font, ['host', 'mono', 'custom'], d.font);
  const customFont = fontName(value.customFont, d.customFont);
  const colors = oneOf(value.colors, ['theme', 'classic', 'mono', 'custom'], d.colors);
  // The panel and the section each had a set of custom colours. They now share one. The old default means
  // never chosen, so a colour picked on either surface survives; where both were picked, the section's does.
  const customColor = (key: 'colorActive' | 'colorNext' | 'colorDone' | 'colorAttention', sectionKey: string, oldDefault: string): string => {
    if (!(sectionKey in value)) return color(value[key], d[key]);
    return color([value[sectionKey], value[key]].find((candidate) => color(candidate, oldDefault) !== oldDefault), d[key]);
  };
  return {
    textSize: clamp(value.textSize, 11, 22, d.textSize),
    // Before these were separate, one size served both.
    sectionTextSize: clamp(value.sectionTextSize, 11, 22, clamp(value.textSize, 11, 22, d.sectionTextSize)),
    sideWidth: Math.round(clamp(value.sideWidth, 160, 700, d.sideWidth)),
    rowHeight,
    font,
    customFont,
    colors,
    colorActive: customColor('colorActive', 'sectionColorActive', '#7fc15f'),
    colorNext: customColor('colorNext', 'sectionColorNext', '#a3a1a9'),
    colorDone: customColor('colorDone', 'sectionColorDone', '#a3a1a9'),
    colorAttention: customColor('colorAttention', 'sectionColorAttention', '#e6a457'),
    // Before these were separate, the panel's look served both.
    sectionRowHeight: oneOf(value.sectionRowHeight, ['tight', 'normal', 'roomy'], rowHeight),
    sectionFont: oneOf(value.sectionFont, ['host', 'mono', 'custom'], font),
    sectionCustomFont: fontName(value.sectionCustomFont, customFont),
    sectionColors: oneOf(value.sectionColors, ['theme', 'classic', 'mono', 'custom'], colors),
    motion: bool(value.motion, d.motion),
    sectionLayout: oneOf(value.sectionLayout, ['glance', 'groups'], d.sectionLayout),
    sectionRows: Math.round(clamp(value.sectionRows, 1, 10, d.sectionRows)),
    sectionTags: bool(value.sectionTags, d.sectionTags),
    sectionHover: bool(value.sectionHover, d.sectionHover),
    sectionWho: bool(value.sectionWho, d.sectionWho),
    subagentDepth: value.subagentDepth === 0 || value.subagentDepth === 1 || value.subagentDepth === 2 || value.subagentDepth === 3 || value.subagentDepth === 4 ? value.subagentDepth : 'auto',
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
    nativeFolders: isRecord(value.nativeFolders)
      ? Object.fromEntries(Object.entries(value.nativeFolders).filter((entry): entry is [string, number] => typeof entry[1] === 'number'))
      : {},
    omoDir: text(value.omoDir, d.omoDir, 200).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/(^|\/)\.\.(?=\/|$)/g, '') || d.omoDir,
    databasePath: text(value.databasePath, d.databasePath),
    dataDir: text(value.dataDir, d.dataDir),
  };
};

const ROW_PX: Record<Settings['rowHeight'], number> = { tight: 1.72, normal: 2, roomy: 2.4 };

/** Puts the settings on the page root; the stylesheet does the rest. */
export const applySettings = (settings: Settings, where: 'panel' | 'section' = 'panel', root: HTMLElement = document.documentElement): void => {
  const { style, dataset } = root;
  const section = where === 'section';
  const size = section ? settings.sectionTextSize : settings.textSize;
  const rowHeight = section ? settings.sectionRowHeight : settings.rowHeight;
  const font = section ? settings.sectionFont : settings.font;
  const customFont = section ? settings.sectionCustomFont : settings.customFont;
  const colors = section ? settings.sectionColors : settings.colors;
  style.setProperty('--todo-size', `${size}px`);
  style.setProperty('--todo-row', `${Math.round(size * ROW_PX[rowHeight])}px`);
  dataset.colors = colors;
  dataset.motion = settings.motion ? 'on' : 'off';
  if (font === 'mono') style.setProperty('--todo-font', 'var(--oc-mono, ui-monospace, monospace)');
  else if (font === 'custom' && customFont.trim()) style.setProperty('--todo-font', `${customFont}, var(--oc-font, system-ui, sans-serif)`);
  else style.removeProperty('--todo-font');
  if (colors === 'custom') {
    style.setProperty('--todo-custom-active', settings.colorActive);
    style.setProperty('--todo-custom-next', settings.colorNext);
    style.setProperty('--todo-custom-done', settings.colorDone);
    style.setProperty('--todo-custom-attention', settings.colorAttention);
  }
};

export const SETTINGS_KEY = 'settings';
export const SETUP_KEY = 'setup-done';
export const foldsKey = (surface: string): string => `folds:${surface}`;
export const marksKey = (sessionId: string): string => `marks:${sessionId}`;
export const ownKey = (sessionId: string): string => `own:${sessionId}`;

// ----- Remembered folds, per surface, across sessions -----

export type Folds = Record<string, boolean>;

export const readFolds = (raw: unknown): Folds => {
  if (!isRecord(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'));
};

// ----- The user's own items, a list of their own beside the agent's -----

export type OwnItem = { id: string; text: string; done: boolean; at: number };

export const readOwn = (raw: unknown): OwnItem[] => {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => (
    isRecord(entry) && typeof entry.id === 'string' && typeof entry.text === 'string'
      ? [{ id: entry.id, text: entry.text, done: entry.done === true, at: typeof entry.at === 'number' ? entry.at : 0 }]
      : []
  ));
};
