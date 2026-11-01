import { h, icon } from '../../shared/dom.ts';
import type { App } from '../app.ts';

export type Report = {
  origin: string | null;
  access: 'open' | 'locked' | 'unreachable';
  version: string | null;
  minVersion: string;
  versionOk: boolean | null;
  todo: { on: boolean; lockedBy: string | null } | null;
  configPath: string | null;
  redirect: { on: boolean; path: string | null };
  snippet: string;
  omo: { found: boolean; folder: string | null; plugin: boolean | null; holdsSession: boolean };
  database: { path: string | null; sqlite: boolean; holdsSession: boolean };
};

const line = (state: 'ok' | 'bad' | 'skip', title: string, help: string, extra: (HTMLElement | null)[] = []): HTMLElement => (
  h('div', { class: 'src' },
    h('span', { class: state }, icon(state === 'ok' ? 'check' : state === 'bad' ? 'alert' : 'ring')),
    h('div', null, title, help ? h('small', null, help) : null, ...extra))
);

/** Checks itself, and changes nothing unless the user ticks the box. */
export const viewSetup = (app: Pick<App, 'state' | 'actions' | 'feed'>): HTMLElement[] => {
  const { state, actions, feed } = app;
  const report = state.report;
  const again = h('button', { type: 'button', class: 'btn', onClick: () => void actions.runSetupCheck() }, 'Check again');
  const parts: (HTMLElement | null)[] = [
    h('h1', null, 'Setting up Session Todos'),
    h('p', { class: 'muted', style: 'margin:4px 0 10px' }, 'Checks run on their own. Nothing changes unless you ask.'),
  ];

  if (state.reportError) {
    parts.push(line('bad', 'The local service did not answer', 'Approve Session Todos in Settings → Extensions. Lists from oh-my-openagent still work without it.', [h('div', { class: 'btns' }, again)]));
  } else if (!report) {
    parts.push(h('p', { class: 'empty' }, 'Checking.'));
  } else {
    // The config says whether the plugin is loaded. A list file may be left over from before it was removed.
    const omoLoaded = report.omo.plugin ?? report.omo.holdsSession;
    const omoInUse = omoLoaded && feed.settings.useOmo;
    const folder = feed.directory;
    const switched = folder ? feed.settings.nativeFolders[folder] !== undefined : false;
    const tooOld = report.versionOk === false;

    if (report.version === null) parts.push(line('skip', 'OpenCode version unknown', report.access === 'locked' ? 'OpenChamber has a password set, so this can\'t be read.' : 'OpenChamber did not answer.'));
    else if (tooOld) parts.push(line('bad', `OpenCode ${report.version} is too old`, `Todo lists need ${report.minVersion} or newer. Upgrade OpenCode, then check again.`, [h('div', { class: 'btns' }, again)]));
    else parts.push(line('ok', `OpenCode ${report.version}`, `Needs ${report.minVersion} or newer.`));

    if (omoInUse) parts.push(line('ok', 'oh-my-openagent found', 'Reading its lists from each session\'s folder.'));
    else if (omoLoaded) parts.push(line('skip', 'oh-my-openagent is loaded, but not read', 'You switched its store off in Settings, so its lists aren\'t read anywhere. It keeps writing them while loaded.'));
    else if (report.omo.found) parts.push(line('skip', 'Old oh-my-openagent lists here', 'The plugin isn\'t loaded, so nothing new will appear in them. Old sessions still show theirs.'));
    else parts.push(line('skip', 'oh-my-openagent not found here', 'Fine. It is optional.'));

    const result = state.setupResult;
    if (state.needsRestart) {
      const busy = actions.agentsBusy();
      parts.push(line('skip', 'Saved. It takes effect the next time OpenChamber restarts', 'Nothing running has been touched. Until then everything keeps working as it did.', [
        result?.backup ? h('small', null, `Your previous config is saved at ${String(result.backup)}.`) : null,
        h('div', { class: 'btns' }, h('button', { type: 'button', class: 'btn', disabled: busy, title: busy ? 'An agent is working. Wait for it, or restart later.' : 'Reloads OpenCode\'s config now', onClick: () => void actions.applyNow() }, 'Apply now')),
        busy ? h('small', null, 'Apply now is off while an agent is working.') : null,
      ]));
    }
    if (omoInUse && switched) {
      parts.push(line('ok', 'This folder uses OpenCode\'s todo tool for new sessions', 'Sessions that were already here keep their oh-my-openagent lists. oh-my-openagent stays loaded and keeps its own copy. To stop it everywhere, remove it from "plugins" in your OpenCode config.', [
        result?.path ? h('small', null, `Saved in ${String(result.path)}.`) : null,
        h('div', { class: 'btns' }, h('button', { type: 'button', class: 'btn', onClick: () => void actions.stopNative() }, 'Stop using it in this folder')),
      ]));
    } else
    if (omoInUse && !report.todo?.on && !state.wantNative) {
      parts.push(line('skip', 'OpenCode\'s todo tool is off', 'You don\'t need it while oh-my-openagent writes your lists. You can try it in this folder: running sessions and other folders stay as they are.', [
        h('div', { class: 'btns' }, h('button', { type: 'button', class: 'btn', onClick: () => actions.setWantNative(true) }, 'Use OpenCode\'s todo tool in this folder')),
      ]));
    }
    else if (state.needsRestart) { /* said above */ }
    else if (tooOld) parts.push(line('skip', 'OpenCode\'s todo tool', 'Checked after you upgrade.'));
    else if (report.todo?.on) {
      parts.push(line('ok', 'OpenCode\'s todo tool is on', result?.backup ? `Turned on. Your previous config is saved at ${String(result.backup)}.` : 'experimental.todo is on in your config.', [
      ]));
    } else if (report.todo === null) {
      parts.push(line('skip', 'OpenCode\'s todo tool', 'Could not read your config.', [h('pre', { class: 'pre' }, report.snippet)]));
    } else if (report.todo.lockedBy) {
      parts.push(line('bad', 'OpenCode\'s todo tool is off, and managed for you', `${report.todo.lockedBy} turns it off, so a change in your own config would not take effect.`));
    } else {
      parts.push(line('bad', 'OpenCode\'s todo tool is off, so agents can\'t write a list', 'Without it, every session here will say "no todo list". It is an experimental OpenCode feature, off by default.',
        report.configPath
          ? [
              h('label', null,
                h('input', { type: 'checkbox', checked: state.setupAgree, onChange: (event: Event) => actions.setAgree((event.target as HTMLInputElement).checked) }),
                state.wantNative
                  ? h('span', null, 'Turn it on for new sessions in this folder. Adds ', h('code', null, report.snippet), ' to ', h('code', null, '.opencode/opencode.json'), ' here. Git may show that file.')
                  : h('span', null, 'Turn it on for me. Adds ', h('code', null, report.snippet), ' to ', h('code', null, report.configPath), ' and saves a backup first.')),
              h('div', { class: 'btns' },
                h('button', { type: 'button', class: `btn${state.setupAgree ? ' go' : ''}`, disabled: !state.setupAgree, onClick: () => void actions.enableTodo() }, 'Apply'),
                h('button', { type: 'button', class: 'btn', onClick: () => void actions.finishSetup() }, 'Continue without it')),
              result?.ok === false ? h('p', { class: 'empty problem', style: 'padding:8px 0 0' }, `${String(result.reason)} Add this to your OpenCode config yourself:`) : null,
              result?.ok === false ? h('pre', { class: 'pre' }, report.snippet) : null,
              h('small', { style: 'margin-top:8px' }, 'This takes effect the next time OpenChamber restarts. Nothing running is touched.'),
            ]
          : [h('small', { style: 'margin-top:6px' }, 'Add this to your OpenCode config:'), h('pre', { class: 'pre' }, report.snippet)]));
    }

    if (report.redirect.path) {
      const where = h('small', null, report.redirect.on ? `A small plugin at ${report.redirect.path}.` : `Adds a small plugin at ${report.redirect.path}. Takes effect the next time OpenChamber restarts.`);
      parts.push(report.redirect.on
        ? line('ok', 'Agents\' todos stay out of the project backlog', 'Agents asked for a todo use this session\'s list. Notes, plans and the Project panel are as before.', [where, h('div', { class: 'btns' }, h('button', { type: 'button', class: 'btn', onClick: () => void actions.setRedirect(false) }, 'Stop doing this'))])
        : line('skip', 'Agents can put todos in the project backlog', 'Asked for a todo, an agent may save it with OpenChamber\'s project tool, so it isn\'t on the session\'s list. Items like that show here under "In the project backlog".', [where, h('div', { class: 'btns' }, h('button', { type: 'button', class: 'btn', onClick: () => void actions.setRedirect(true) }, 'Keep them on the session\'s list'))]));
    }

    if (report.access === 'open') parts.push(line('ok', 'Reading lists from OpenCode', 'Through OpenChamber on this computer.'));
    else if (report.access === 'locked') {
      parts.push(report.database.holdsSession && report.database.sqlite
        ? line('ok', 'Reading lists from the OpenCode database', 'OpenChamber has a password set, so the extension reads the database directly, read-only. It never asks for or stores your password.')
        : line('bad', 'Can\'t reach OpenCode\'s lists', 'OpenChamber has a password set and no database was found. Set the database path in Settings.'));
    } else parts.push(line('bad', 'Can\'t find OpenChamber\'s server', 'Open a session and check again.', [h('div', { class: 'btns' }, again)]));

    const held = report.database.path !== null && report.database.holdsSession;
    parts.push(line(held ? 'ok' : 'skip', held ? 'OpenCode database found' : 'OpenCode database not confirmed', held ? report.database.path ?? '' : 'Only needed for a password-protected OpenChamber, and for old lists. If you need it, set the path in Settings.'));

    // The one thing nobody else's setup can answer for them: how big the text should be.
    parts.push(h('div', { class: 'opt', style: 'border:0;margin-top:6px' },
      h('div', null, 'Text size', h('small', null, 'Match it to the other sections in your sidebar.')),
      h('input', { type: 'range', id: 'setup-size', min: '11', max: '22', step: '0.25', value: String(feed.settings.sectionTextSize), 'aria-label': 'Section text size', onInput: (event: Event) => feed.saveSettings({ ...feed.settings, sectionTextSize: Number((event.target as HTMLInputElement).value) }) }),
      h('span', { class: 'num', style: 'width:3.4em' }, `${feed.settings.sectionTextSize} px`)));
  }

  parts.push(h('div', { class: 'btns', style: 'margin-top:14px' }, h('button', { type: 'button', class: 'btn go', onClick: () => void actions.finishSetup() }, 'Done'), report ? again : null));
  return [h('div', { class: 'set' }, ...parts.filter((part): part is HTMLElement => part !== null))];
};
