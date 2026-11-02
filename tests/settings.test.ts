import { describe, expect, test } from 'bun:test';

import { DEFAULTS, applySettings, readSettings } from '../shared/settings.ts';

const fakeRoot = (): { root: HTMLElement; props: Map<string, string>; dataset: Record<string, string> } => {
  const props = new Map<string, string>();
  const dataset: Record<string, string> = {};
  const style = { setProperty: (key: string, value: string) => props.set(key, value), removeProperty: (key: string) => props.delete(key) };
  return { root: { style, dataset } as unknown as HTMLElement, props, dataset };
};

describe('sidebar hover', () => {
  test('is on by default and independent of tags', () => {
    expect(DEFAULTS.sectionHover).toBe(true);
    expect(readSettings({ sectionTags: true }).sectionHover).toBe(true);
    expect(readSettings({ sectionHover: false }).sectionHover).toBe(false);
    expect(readSettings({ sectionHover: false }).sectionTags).toBe(false);
  });
});

describe('the section has its own look', () => {
  test('saved before they were separate, the section keeps the look it had', () => {
    const settings = readSettings({ textSize: 16, rowHeight: 'roomy', font: 'custom', customFont: 'Inter', colors: 'custom', colorActive: '#111111' });
    expect(settings.sectionTextSize).toBe(16);
    expect(settings.sectionRowHeight).toBe('roomy');
    expect(settings.sectionFont).toBe('custom');
    expect(settings.sectionCustomFont).toBe('Inter');
    expect(settings.sectionColors).toBe('custom');
    expect(settings.sectionColorActive).toBe('#111111');
  });

  test('a new install: 15 px panel, 13.75 px section, the same look otherwise', () => {
    const settings = readSettings({});
    expect(settings.textSize).toBe(15);
    expect(settings.sectionTextSize).toBe(13.75);
    expect(settings.sectionRowHeight).toBe(DEFAULTS.rowHeight);
    expect(settings.sectionColors).toBe(DEFAULTS.colors);
  });

  test('saved text sizes survive a change to the defaults', () => {
    const settings = readSettings({ textSize: 14, sectionTextSize: 12 });
    expect(settings.textSize).toBe(14);
    expect(settings.sectionTextSize).toBe(12);
  });

  test('the fractional section default reaches the stylesheet unchanged', () => {
    const section = fakeRoot();
    applySettings(readSettings({}), 'section', section.root);
    expect(section.props.get('--todo-size')).toBe('13.75px');
  });

  test('a bad value falls back, and nothing unsafe reaches a style rule', () => {
    const settings = readSettings({ sectionRowHeight: 'huge', sectionColors: 'pink', sectionColorDone: 'red;}', sectionCustomFont: 'A;}<b>' });
    expect(settings.sectionRowHeight).toBe('normal');
    expect(settings.sectionColors).toBe('theme');
    expect(settings.sectionColorDone).toBe(DEFAULTS.colorDone);
    expect(settings.sectionCustomFont).toBe('Ab');
  });

  test('each surface applies only its own values', () => {
    const settings = readSettings({
      textSize: 20, rowHeight: 'roomy', font: 'mono', colors: 'classic',
      sectionTextSize: 10 + 2, sectionRowHeight: 'tight', sectionFont: 'custom', sectionCustomFont: 'Inter', sectionColors: 'custom', sectionColorActive: '#222222',
    });
    const panel = fakeRoot();
    applySettings(settings, 'panel', panel.root);
    expect(panel.props.get('--todo-size')).toBe('20px');
    expect(panel.props.get('--todo-row')).toBe('48px');
    expect(panel.props.get('--todo-font')).toContain('--oc-mono');
    expect(panel.dataset.colors).toBe('classic');
    expect(panel.props.has('--todo-custom-active')).toBe(false);

    const section = fakeRoot();
    applySettings(settings, 'section', section.root);
    expect(section.props.get('--todo-size')).toBe('12px');
    expect(section.props.get('--todo-row')).toBe('21px');
    expect(section.props.get('--todo-font')).toContain('Inter');
    expect(section.dataset.colors).toBe('custom');
    expect(section.props.get('--todo-custom-active')).toBe('#222222');
  });
});
