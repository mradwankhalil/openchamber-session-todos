// A small DOM builder and the icon set. No markup strings for anything that holds agent text.

type Child = Node | string | null | undefined | false;
type Props = Record<string, unknown>;

export const h = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...children: Child[]): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = String(value);
      else if (key === 'style') node.setAttribute('style', String(value));
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      else if (key === 'value' && 'value' in node) (node as unknown as { value: string }).value = String(value);
      else if (key === 'checked' && 'checked' in node) (node as unknown as { checked: boolean }).checked = value === true;
      else if (value === true) node.setAttribute(key, '');
      else node.setAttribute(key, String(value));
    }
  }
  for (const child of children) if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
};

const PATHS: Record<string, string> = {
  ring: '<circle cx="12" cy="12" r="8"/>',
  active: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.4" fill="currentColor" stroke="none"/>',
  check: '<circle cx="12" cy="12" r="8.4" fill="currentColor" fill-opacity=".16"/><path d="m8.2 12.3 2.6 2.6 5-5.4"/>',
  mine: '<circle cx="12" cy="12" r="8.4" stroke-dasharray="2.6 2.6"/><path d="m8.2 12.3 2.6 2.6 5-5.4"/>',
  cancel: '<circle cx="12" cy="12" r="8"/><path d="m9.2 9.2 5.6 5.6m0-5.6-5.6 5.6"/>',
  gone: '<circle cx="12" cy="12" r="8" stroke-dasharray="2.4 3"/>',
  caret: '<path d="m6.5 9.5 5.5 5.5 5.5-5.5"/>',
  alert: '<path d="M12 4 3.5 19h17z"/><path d="M12 10v4.4M12 17v.1"/>',
  quiet: '<circle cx="12" cy="12" r="8.4"/><path d="M12 7.5V12l3 2"/>',
  flag: '<path d="M6 21V4h11l-2.4 4 2.4 4H6"/>',
  tree: '<path d="M6 4v12a3 3 0 0 0 3 3h3M6 9h6"/><circle cx="16" cy="9" r="2.4"/><circle cx="16" cy="19" r="2.4"/>',
  send: '<path d="M4 12 20 4l-5 16-3-7z"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M5 15.5V6a1.5 1.5 0 0 1 1.5-1.5H15"/>',
  gear: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  list: '<path d="M8.5 6.5H20M8.5 12H20M8.5 17.5H20"/><path d="M4.5 6.5h.1M4.5 12h.1M4.5 17.5h.1"/>',
  history: '<path d="M4 12a8 8 0 1 0 2.6-5.9L4 8.5"/><path d="M4 4v4.5h4.5M12 8v4.2l3 1.8"/>',
  layers: '<path d="M12 3 3 7.5l9 4.5 9-4.5z"/><path d="m3 12 9 4.5 9-4.5"/><path d="m3 16.5 9 4.5 9-4.5"/>',
  open: '<path d="M14 5h5v5M19 5l-8 8M18 14v4a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 5 18V8a1.5 1.5 0 0 1 1.5-1.5H10"/>',
  spark: '<path d="M12 3.5 14 10l6.5 2-6.5 2-2 6.5L10 14l-6.5-2L10 10z"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  trash: '<path d="M5 7h14M10 7V4.5h4V7m-7 0 .8 12.5h8.4L17 7"/>',
  note: '<path d="M6 4h12v11l-5 5H6z"/><path d="M13 20v-5h5"/>',
};

export const icon = (name: keyof typeof PATHS | string, className = ''): SVGSVGElement => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', `i ${className}`.trim());
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  // The paths are this file's own constants, never agent text.
  svg.innerHTML = PATHS[name] ?? '';
  return svg;
};
