// Mouse / keyboard reference for the viewport, opened from the "?" button in the viewport bar.
// It follows the active tool (Look, Orbit, Director) while open.

import type { Studio } from '../../engine/studio';
import type { Disposer } from '../types';
import { h, icon } from './dom';

type Which = 'free' | 'pivot' | 'director';

/** `[x]` renders as a key cap. */
const CONTROLS: Record<Which, { title: string; rows: [string, string][] }> = {
  free: { title: 'Look', rows: [
    ['Drag', 'Look around'],
    ['[Shift] drag · right drag', 'Move sideways / up / down'],
    ['Scroll', 'Push in / pull back'],
    ['[Alt] scroll', 'Zoom the lens'],
    ['[W] [A] [S] [D]', 'Move forward / left / back / right'],
    ['[R] [F]', 'Move up / down'],
    ['[Q] [E]', 'Roll'],
    ['[Shift] + keys', 'Move faster'],
    ['[Alt] drag', 'Fine control'],
  ] },
  pivot: { title: 'Orbit', rows: [
    ['Drag', 'Swing around the orbit point'],
    ['Drag the dot', 'Move the orbit point onto a surface'],
    ['[Shift] drag · right drag', 'Move camera and point together'],
    ['Scroll', 'Closer to / farther from the point'],
    ['[Alt] scroll', 'Zoom the lens'],
    ['[A] [D] · [R] [F]', 'Orbit left / right · up / down'],
    ['[W] [S]', 'Closer / farther'],
    ['[Q] [E]', 'Roll'],
  ] },
  director: { title: 'Director view', rows: [
    ['Drag', 'Orbit the overview'],
    ['[Shift] drag · right drag', 'Pan'],
    ['Scroll', 'Zoom'],
    ['[C]', 'Back to the camera view'],
  ] },
};

const keyCaps = (spec: string) => spec.split(/(\[[^\]]+\])/).filter(Boolean).map((p) => (p.startsWith('[') ? h('kbd', {}, p.slice(1, -1)) : p));

export function createControlsHelp(studio: Studio, d: Disposer, anchor: HTMLElement, host: HTMLElement, openAll: () => void) {
  const title = h('div', { class: 'title' });
  const list = h('dl', { class: 'controls' });
  const el = h('div', { class: 'sr-pop controls-pop', hidden: true, attrs: { role: 'dialog', 'aria-label': 'Viewport controls' } },
    h('div', { class: 'head' }, title, h('button', { type: 'button', class: 'ghost', attrs: { 'aria-label': 'Close' }, onclick: () => close() }, icon('x'))),
    list,
    h('p', { class: 'hint' }, 'Every camera change is keyed at the playhead automatically. ',
      h('button', { type: 'button', class: 'link', onclick: () => { close(); openAll(); } }, 'All shortcuts')));
  host.append(el);

  let shown: Which | null = null;
  function render() {
    const which: Which = studio.view === 'director' ? 'director' : studio.mode;
    if (which === shown) return;
    shown = which;
    title.textContent = `Controls · ${CONTROLS[which].title}`;
    list.replaceChildren(...CONTROLS[which].rows.flatMap(([keys, what]) => [h('dt', {}, ...keyCaps(keys)), h('dd', {}, what)]));
  }

  function place() {
    const a = anchor.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    Object.assign(el.style, {
      left: `${Math.min(innerWidth - r.width - 8, Math.max(8, a.right - r.width))}px`,
      top: `${Math.max(8, a.top - r.height - 8)}px`,
    });
  }

  function open() {
    shown = null;
    render();
    el.hidden = false;
    place();
    anchor.classList.add('on');
    anchor.setAttribute('aria-expanded', 'true');
  }

  function close() {
    el.hidden = true;
    anchor.classList.remove('on');
    anchor.setAttribute('aria-expanded', 'false');
  }

  const toggle = () => (el.hidden ? open() : close());
  anchor.onclick = toggle;

  d.listen(document, 'pointerdown', (e) => {
    const t = e.target;
    // Stays open while you try the controls in the viewport.
    if (el.hidden || !(t instanceof Element) || el.contains(t) || anchor.contains(t) || t.closest('.stage')) return;
    close();
  }, { capture: true });
  d.listen(document, 'keydown', (e) => {
    if (!el.hidden && e.key === 'Escape') { e.stopPropagation(); close(); }
  }, { capture: true });
  d.listen(window, 'resize', () => { if (!el.hidden) place(); });
  d.add(studio.on('settings', () => { if (!el.hidden) { render(); place(); } }));
  d.add(() => el.remove());

  return { toggle, close };
}
