import { h, icon } from '../../shared/dom.ts';
import { resolveDepth } from '../../shared/model.ts';
import { DEFAULTS, type Settings } from '../../shared/settings.ts';
import type { App } from '../app.ts';
import { pageTop } from './parts.ts';

type BoolKey = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];
type TextKey = 'customFont' | 'sectionCustomFont' | 'omoDir' | 'databasePath' | 'dataDir';
type ColorKey = 'colorActive' | 'colorNext' | 'colorDone' | 'colorAttention' | 'sectionColorActive' | 'sectionColorNext' | 'sectionColorDone' | 'sectionColorAttention';

/** Every option there is. Changes apply at once, in every frame. */
export const viewSettings = (app: Pick<App, 'feed' | 'actions' | 'state'>): HTMLElement[] => {
  const { feed, actions, state } = app;
  const s = feed.settings;
  const save = (patch: Partial<Settings>): void => feed.saveSettings({ ...feed.settings, ...patch });

  const opt = (title: string, help: string, control: HTMLElement | HTMLElement[]): HTMLElement => (
    h('div', { class: 'opt' }, h('div', null, title, help ? h('small', null, help) : null), ...(Array.isArray(control) ? control : [control]))
  );
  const toggle = (key: BoolKey, label: string): HTMLElement => h('input', { type: 'checkbox', class: 'sw', id: `set-${key}`, 'aria-label': label, checked: s[key], onChange: (event: Event) => save({ [key]: (event.target as HTMLInputElement).checked } as Partial<Settings>) });
  const pick = <K extends keyof Settings>(key: K, choices: [Settings[K], string][]): HTMLElement => (
    h('span', { class: 'seg', role: 'group' }, ...choices.map(([value, label]) => h('button', { type: 'button', 'aria-pressed': String(s[key] === value), onClick: () => save({ [key]: value } as Partial<Settings>) }, label)))
  );
  const range = (key: 'textSize' | 'sectionTextSize' | 'sectionRows' | 'quietMinutes' | 'overviewDays', min: number, max: number, step: number, unit: string, label: string): HTMLElement[] => [
    h('input', { type: 'range', id: `set-${key}`, min: String(min), max: String(max), step: String(step), value: String(s[key]), 'aria-label': label, onInput: (event: Event) => save({ [key]: Number((event.target as HTMLInputElement).value) } as Partial<Settings>) }),
    h('span', { class: 'num', style: 'width:3.4em' }, `${s[key]}${unit}`),
  ];
  const textField = (key: TextKey, placeholder: string, label: string): HTMLElement => h('input', {
    type: 'text', id: `set-${key}`, placeholder, value: s[key], 'aria-label': label,
    onChange: (event: Event) => save({ [key]: (event.target as HTMLInputElement).value } as Partial<Settings>),
  });
  const swatch = (key: ColorKey, label: string): HTMLElement => h('input', { type: 'color', value: s[key], 'aria-label': label, title: label, onChange: (event: Event) => save({ [key]: (event.target as HTMLInputElement).value } as Partial<Settings>) });

  const box = (title: string, ...rows: (HTMLElement | (HTMLElement | null)[] | null)[]): HTMLElement => h('section', { class: 'set-box' }, h('h2', null, title), ...rows.flat());
  const looks = (keys: { row: 'rowHeight' | 'sectionRowHeight'; font: 'font' | 'sectionFont'; custom: 'customFont' | 'sectionCustomFont'; colors: 'colors' | 'sectionColors'; swatches: [ColorKey, ColorKey, ColorKey, ColorKey] }): (HTMLElement | null)[] => [
    opt('Row height', '', pick(keys.row, [['tight', 'Tight'], ['normal', 'Normal'], ['roomy', 'Roomy']])),
    opt('Font', '', pick(keys.font, [['host', 'OpenChamber'], ['mono', 'Monospace'], ['custom', 'Custom']])),
    s[keys.font] === 'custom' ? opt('Font name', 'Any font installed on this computer.', textField(keys.custom, 'Inter', 'Font name')) : null,
    opt('Status colours', 'Classic is green, orange and red headings.', pick(keys.colors, [['theme', 'Theme'], ['classic', 'Classic'], ['mono', 'Mono'], ['custom', 'Custom']])),
    s[keys.colors] === 'custom' ? opt('Your colours', 'In progress, next, done, needs you.', [swatch(keys.swatches[0], 'In progress'), swatch(keys.swatches[1], 'Next'), swatch(keys.swatches[2], 'Done'), swatch(keys.swatches[3], 'Needs you')]) : null,
  ];

  return [pageTop('Settings'), h('div', { class: 'set' },
    box('Panel',
      opt('Panel text size', 'This panel and its pages. The sidebar section has its own look, below.', range('textSize', 11, 22, 0.25, ' px', 'Panel text size')),
      looks({ row: 'rowHeight', font: 'font', custom: 'customFont', colors: 'colors', swatches: ['colorActive', 'colorNext', 'colorDone', 'colorAttention'] })),

    box('Sidebar section',
      opt('Section text size', 'OpenChamber doesn\'t tell extensions its text size. Set this once to match your other sections.', range('sectionTextSize', 11, 22, 0.25, ' px', 'Section text size')),
      looks({ row: 'sectionRowHeight', font: 'sectionFont', custom: 'sectionCustomFont', colors: 'sectionColors', swatches: ['sectionColorActive', 'sectionColorNext', 'sectionColorDone', 'sectionColorAttention'] }),
      opt('Layout', 'At a glance shows what is happening and what is next. Groups has headed sections that fold.', pick('sectionLayout', [['glance', 'At a glance'], ['groups', 'Groups']])),
      opt('Next items shown', '', range('sectionRows', 1, 10, 1, '', 'Next items shown')),
      opt('Show the session name', '', toggle('sectionWho', 'Show the session name')),
      opt('Show tags in the sidebar', 'Off by default. They take width from the title.', toggle('sectionTags', 'Show tags in the sidebar'))),

    box('Lists',
      opt('Show tags in the panel', 'NEXT-COORD | Confirm the pin becomes a tag and a title. Off hides the prefix.', toggle('tags', 'Show tags in the panel')),
      opt('Link session ids', 'ses_e70a shows the session\'s name and opens it.', toggle('refs', 'Link session ids')),
      opt('Mark high priority', 'Only in lists that mix priorities. Where everything is high, a mark tells you nothing.', toggle('priority', 'Mark high priority')),
      opt('Subagent lists', s.subagentDepth === 'auto' ? `Following your config: ${resolveDepth('auto', state.configuredDepth)} level${resolveDepth('auto', state.configuredDepth) === 1 ? '' : 's'} deep. A subagent's own subagents show under it.` : 'A subagent\'s own subagents show under it, as far as you choose.', pick('subagentDepth', [['auto', 'Auto'], [0, 'None'], [1, '1'], [2, '2'], [3, '3'], [4, '4']])),
      opt('Motion', 'A row glides when its state changes. Always off under reduced motion.', toggle('motion', 'Motion'))),

    box('Your marks',
      opt('Let me tick items', 'Off means read-only: no controls and no marks anywhere. Your ticks are kept. Agents never see them unless you tell them.', toggle('ticking', 'Let me tick items')),
      opt('Clear my ticks and notes', `${Object.keys(state.marks.ticks).length} ticks, ${Object.keys(state.marks.notes).length} notes in this session`, h('button', { type: 'button', class: 'btn', onClick: () => actions.clearTicks() }, 'Clear'))),

    box('Attention',
      opt('Say "no activity" after', 'For a session that has gone quiet with items still open.', range('quietMinutes', 1, 120, 1, ' min', 'Minutes before saying no activity')),
      opt('Tell me when a session needs me', 'One toast when it starts waiting on you.', toggle('notify', 'Tell me when a session needs me')),
      opt('Open items on the rail icon', '', toggle('badge', 'Open items on the rail icon'))),

    box('Every session',
      opt('Show sessions active in the last', '', range('overviewDays', 1, 90, 1, ' d', 'Days of sessions to show')),
      opt('Offer a digest', 'Runs only when you ask, with the Small Model you set in OpenChamber.', toggle('digest', 'Offer a digest'))),

    box('Where lists come from',
      h('p', { class: 'muted small', style: 'margin:0 0 6px' }, 'Found automatically, tried in this order. Change a path only if yours is different.'),
      opt('oh-my-openagent store', 'Inside each session\'s folder. Off means its lists aren\'t read. It keeps writing them while it is loaded.', [toggle('useOmo', 'Use the oh-my-openagent store'), textField('omoDir', DEFAULTS.omoDir, 'Folder inside each session\'s folder')]),
      opt('OpenCode session', 'The newest todo list in the session\'s messages. Needs experimental.todo.', toggle('useLog', 'Use OpenCode sessions')),
      opt('OpenCode database', 'Read-only. Used when OpenChamber has a password set, and for old lists.', [toggle('useDatabase', 'Use the OpenCode database'), textField('databasePath', 'Found automatically', 'Database path')]),
      Object.keys(s.nativeFolders).length > 0 ? opt('Folders on OpenCode\'s todo tool', Object.keys(s.nativeFolders).join(', '), h('span', { class: 'num' }, String(Object.keys(s.nativeFolders).length))) : null,
      h('div', { class: 'btns' }, h('button', { type: 'button', class: 'btn', onClick: () => { void actions.runSetupCheck(); actions.go('setup'); } }, icon('gear'), 'Run the setup check'))),

    box('History and data',
      opt('Keep history', 'Each version of a list, on this computer. Powers the replay and "Dropped without a word".', toggle('history', 'Keep history')),
      opt('History folder', 'Blank uses ~/.local/share/openchamber-session-todos.', textField('dataDir', 'Default', 'History folder')),
      opt('Export', 'This session\'s list, history, ticks and notes, as JSON.', h('button', { type: 'button', class: 'btn', onClick: () => actions.exportAll() }, 'Export')),
      opt('Reset settings', 'Back to the defaults. Keeps your ticks and history.', h('button', { type: 'button', class: 'btn', onClick: () => feed.saveSettings(DEFAULTS) }, 'Reset'))))];
};
