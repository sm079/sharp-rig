// Small DOM toolkit for the Studio UI: element builder, icons, popover menus and toasts.

type Child = Node | string | null | undefined | false;

interface Props {
  class?: string;
  style?: Partial<CSSStyleDeclaration> | Record<string, string>;
  attrs?: Record<string, string>;
  dataset?: Record<string, string>;
  [prop: string]: unknown;
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined) continue;
    if (k === 'class') el.className = v as string;
    else if (k === 'style') {
      for (const [sk, sv] of Object.entries(v as Record<string, string>)) {
        if (sk.startsWith('--')) el.style.setProperty(sk, sv);
        else (el.style as unknown as Record<string, string>)[sk] = sv;
      }
    } else if (k === 'attrs') for (const [ak, av] of Object.entries(v as Record<string, string>)) el.setAttribute(ak, av);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else (el as unknown as Record<string, unknown>)[k] = v;
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

// ------------------------------------------------------------------ icons

const PATHS = {
  down: '<path d="m6 9 6 6 6-6"/>',
  move: '<path d="m5 9-3 3 3 3"/><path d="m9 5 3-3 3 3"/><path d="m15 19-3 3-3-3"/><path d="m19 9 3 3-3 3"/><path d="M2 12h20"/><path d="M12 2v20"/>',
  orbit: '<circle cx="12" cy="12" r="3"/><ellipse cx="12" cy="12" rx="10" ry="4.5"/>',
  reset: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  play: '<path d="M7 4v16l13-8L7 4Z"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
  diamond: '<path d="M12 2 22 12 12 22 2 12Z"/>',
  loop: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  once: '<path d="M4 12h15"/><path d="m14 7 5 5-5 5"/><path d="M20 5v14"/>',
  bounce: '<path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.2a2.6 2.6 0 0 1 5 1c0 1.8-2.5 2.3-2.5 3.8"/><path d="M12 17.2h.01"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  paste: '<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4V3h6v1"/><path d="M9 10h6"/><path d="M9 14h4"/>',
  clear: '<path d="M12 3 21 12 12 21 3 12Z"/><path d="m9.5 9.5 5 5"/><path d="m14.5 9.5-5 5"/>',
  zoomIn: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/><path d="M11 8v6"/><path d="M8 11h6"/>',
  zoomOut: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/><path d="M8 11h6"/>',
  fit: '<path d="M3 5v14"/><path d="M21 5v14"/><path d="M7 12h10"/><path d="m10 9-3 3 3 3"/><path d="m14 9 3 3-3 3"/>',
} as const;

export type IconName = keyof typeof PATHS;

function iconSvg(name: IconName) {
  return `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${PATHS[name]}</svg>`;
}

export function icon(name: IconName): SVGElement {
  const t = document.createElement('template');
  t.innerHTML = iconSvg(name);
  return t.content.firstElementChild as SVGElement;
}

/** Replace every `<i data-i="name">` placeholder under `root` with its SVG icon. */
export function hydrateIcons(root: ParentNode) {
  for (const el of root.querySelectorAll<HTMLElement>('i[data-i]')) el.replaceWith(icon(el.dataset.i as IconName));
}

// ------------------------------------------------------------------ menus

export type MenuItem =
  | { label: string; hint?: string; checked?: boolean; disabled?: boolean; danger?: boolean; onSelect: () => void }
  | { heading: string }
  | 'sep';

let openMenu: { el: HTMLElement; close: () => void } | null = null;

export function closeMenus() {
  openMenu?.close();
}

/** Show a popover menu next to `anchor`. It closes on selection, outside click or Escape. */
export function showMenu(anchor: HTMLElement, items: MenuItem[], opts: { align?: 'start' | 'end'; side?: 'below' | 'above' } = {}) {
  const wasOpenHere = openMenu?.el.dataset.anchor === anchorId(anchor);
  closeMenus();
  if (wasOpenHere) return; // a second click on the same anchor toggles it closed

  const el = h('div', { class: 'sr-menu', attrs: { role: 'menu' }, dataset: { anchor: anchorId(anchor) } });
  for (const it of items) {
    if (it === 'sep') { el.append(h('div', { class: 'sep', attrs: { role: 'separator' } })); continue; }
    if ('heading' in it) { el.append(h('div', { class: 'head' }, it.heading)); continue; }
    const b = h('button', {
      type: 'button', class: `item${it.checked ? ' on' : ''}${it.danger ? ' danger' : ''}`, disabled: !!it.disabled,
      attrs: { role: it.checked === undefined ? 'menuitem' : 'menuitemradio', ...(it.checked !== undefined ? { 'aria-checked': String(it.checked) } : {}) },
      onclick: () => { close(); it.onSelect(); },
    }, h('span', { class: 'chk' }, it.checked ? icon('check') : ''), h('span', { class: 'lbl' }, it.label), it.hint ? h('span', { class: 'hint' }, it.hint) : null);
    el.append(b);
  }
  (anchor.closest('.sr') ?? document.body).append(el);

  const r = anchor.getBoundingClientRect();
  const m = el.getBoundingClientRect();
  const below = opts.side !== 'above' && r.bottom + 6 + m.height <= innerHeight - 8;
  const top = below ? r.bottom + 6 : Math.max(8, r.top - 6 - m.height);
  let left = opts.align === 'end' ? r.right - m.width : r.left;
  left = Math.min(innerWidth - m.width - 8, Math.max(8, left));
  Object.assign(el.style, { top: `${top}px`, left: `${left}px` });
  anchor.setAttribute('aria-expanded', 'true');

  const onDown = (e: PointerEvent) => { if (!el.contains(e.target as Node) && !anchor.contains(e.target as Node)) close(); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); anchor.focus(); } };
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  function close() {
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    anchor.setAttribute('aria-expanded', 'false');
    el.remove();
    if (openMenu?.el === el) openMenu = null;
  }
  openMenu = { el, close };
  el.querySelector<HTMLButtonElement>('button.item.on, button.item:not(:disabled)')?.focus();
}

let anchorSeq = 0;
function anchorId(el: HTMLElement) {
  return (el.dataset.menuAnchor ??= String(++anchorSeq));
}

// ------------------------------------------------------------------ toasts

export function createToasts() {
  const el = h('div', { class: 'sr-toasts', attrs: { role: 'status', 'aria-live': 'polite' } });
  function show(message: string, opts: { kind?: 'info' | 'error'; action?: { label: string; run: () => void }; ms?: number } = {}) {
    const t = h('div', { class: `sr-toast${opts.kind === 'error' ? ' err' : ''}` }, h('span', {}, message));
    if (opts.action) {
      const { label, run } = opts.action;
      t.append(h('button', { type: 'button', onclick: () => { run(); t.remove(); } }, label));
    }
    el.append(t);
    while (el.children.length > 3) el.firstElementChild!.remove();
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 200); }, opts.ms ?? (opts.kind === 'error' ? 6000 : 3200));
  }
  return { el, show };
}

// ------------------------------------------------------------------ misc

/** Keep a range input's filled track (`--p`) in sync with its value. */
export function paintRange(r: HTMLInputElement) {
  const min = Number(r.min || 0), max = Number(r.max || 100);
  r.style.setProperty('--p', `${((Number(r.value) - min) / (max - min || 1)) * 100}%`);
}

/** Toggle `.on` within a pill group by `data-v`. */
export function setPills(group: HTMLElement, value: string | null) {
  for (const b of group.querySelectorAll<HTMLButtonElement>('button[data-v]')) {
    const on = b.dataset.v === value;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  }
}
