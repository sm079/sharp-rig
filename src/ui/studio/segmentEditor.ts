// "Ease" popover for one motion segment (the span between two keyframes), opened by clicking it
// in the timeline. It controls how the camera speeds up and slows down between the two keys:
//   · the curve itself: shape it with handles, or draw it freehand
//   · four basic curves, with the whole library behind "All curves"
//   · My curves: name and save your own, reuse them on any segment
//   · Camera route (collapsed): the path the position takes between the keys
//   · use the curve on every segment

import type { Studio } from '../../engine/studio';
import type { EasingSpec } from '../../motion/easing';
import { resolvePath, type PathMode } from '../../motion/timeline';
import type { Disposer } from '../types';
import { CurveEditor, type CurveMode } from './curveEditor';
import { BASIC_CURVES, CURVE_GROUPS, curveLabel, curvePath, deleteCurve, sameCurve, saveCurve, savedCurves } from './curves';
import { h, icon, setPills } from './dom';

const ROUTES: { v: Exclude<PathMode, 'auto'>; label: string; desc: string }[] = [
  { v: 'linear', label: 'Straight line', desc: 'Moves directly from one position to the next.' },
  { v: 'spline', label: 'Smooth curve', desc: 'Bends through the keyframes before and after, for flowing moves with several keys.' },
  { v: 'arc', label: 'Around the orbit point', desc: 'Swings around the orbit point at a constant distance. Needs keyframes made in Orbit mode.' },
];

const MODE_KEY = 'sharprig.curveMode';

export function createSegmentEditor(studio: Studio, d: Disposer, host: HTMLElement) {
  let index: number | null = null;
  let showAll = false;
  let naming = false;

  // ---------------------------------------------------------------- skeleton
  const sub = h('div', { class: 'sub' });
  const closeBtn = h('button', { type: 'button', class: 'ghost', attrs: { 'aria-label': 'Close' } }, icon('x'));
  const editor = new CurveEditor();
  const curveName = h('span', { class: 'cname' });
  const modes = h('div', { class: 'seg', attrs: { role: 'group', 'aria-label': 'How to shape the curve' } },
    h('button', { type: 'button', dataset: { v: 'handles' }, title: 'Drag two handles to shape the curve' }, 'Handles'),
    h('button', { type: 'button', dataset: { v: 'draw' }, title: 'Draw the curve freehand' }, 'Draw'));
  const hint = h('p', { class: 'hint' });

  const saveOpen = h('button', { type: 'button', class: 'ghost small accent' }, 'Save curve…');
  const nameInput = h('input', { type: 'text', placeholder: 'Name, e.g. Slow reveal', maxLength: 32, attrs: { 'aria-label': 'Curve name' } });
  const nameForm = h('form', { class: 'name-form' }, nameInput,
    h('button', { type: 'submit', class: 'btn pri small' }, 'Save'),
    h('button', { type: 'button', class: 'ghost small', onclick: () => { naming = false; render(); } }, 'Cancel'));

  const basics = h('div', { class: 'chips' });
  const allToggle = h('button', { type: 'button', class: 'ghost small' });
  const allBox = h('div', { class: 'all-curves' });
  const mine = h('div', { class: 'chips' });
  const mineSec = h('div', {}, h('div', { class: 'lbl' }, 'My curves'), mine);

  const routeSummary = h('span', { class: 'rsum' });
  const routes = h('div', { class: 'routes', attrs: { role: 'radiogroup', 'aria-label': 'Camera route' } });
  const route = h('details', { class: 'route' },
    h('summary', {}, h('span', {}, 'Camera route'), routeSummary, icon('down')),
    h('p', { class: 'hint' }, 'The path the camera\'s position follows between these two keyframes. The curve above only sets the timing.'),
    routes);

  const applyAll = h('button', { type: 'button', class: 'ghost small' }, 'Use on all segments');

  const el = h('div', { class: 'sr-pop seg-editor', hidden: true, attrs: { role: 'dialog', 'aria-label': 'Ease' } },
    h('div', { class: 'head' }, h('div', {}, h('div', { class: 'title' }, 'Ease'), sub), closeBtn),
    h('div', { class: 'ed-bar' }, curveName, modes),
    editor.el,
    hint,
    h('div', { class: 'save-row' }, saveOpen, nameForm),
    h('div', { class: 'lbl row-between' }, h('span', {}, 'Curves'), allToggle),
    basics,
    allBox,
    mineSec,
    route,
    h('div', { class: 'foot' }, applyAll));
  host.append(el);

  // ---------------------------------------------------------------- state helpers
  const seg = () => (index === null ? null : studio.segmentKey(index));
  const setEasing = (spec: EasingSpec) => { if (index !== null) studio.setSegmentEasing(index, spec); };
  const isOwn = (s: EasingSpec) => s.name === 'custom' || s.name === 'sketch';

  let mode: CurveMode = (() => { try { return localStorage.getItem(MODE_KEY) === 'draw' ? 'draw' : 'handles'; } catch { return 'handles'; } })();
  const setMode = (m: CurveMode) => {
    mode = m;
    editor.setMode(m);
    setPills(modes, m);
    hint.textContent = m === 'handles'
      ? 'Drag the two handles to shape the curve. Steeper means faster.'
      : 'Draw over the curve to reshape it. Start and end stay fixed so the camera lands on each keyframe.';
    try { localStorage.setItem(MODE_KEY, m); } catch { /* storage unavailable */ }
  };
  modes.onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-v]');
    if (b) setMode(b.dataset.v as CurveMode);
  };
  setMode(mode);

  editor.onChange = (spec) => setEasing(spec);

  function chip(spec: EasingSpec, label: string, onDelete?: () => void) {
    const on = sameCurve(seg()?.easing, spec);
    const b = h('button', { type: 'button', class: `chip${on ? ' on' : ''}`, title: label, attrs: { 'aria-pressed': String(on) }, onclick: () => setEasing(spec) });
    b.innerHTML = `<svg viewBox="0 0 44 26" aria-hidden="true"><path d="${curvePath(spec, 44, 26, 3, 36)}"/></svg>`;
    b.append(h('span', {}, label));
    if (onDelete) {
      b.append(h('span', {
        class: 'del', title: `Delete "${label}"`, attrs: { role: 'button', 'aria-label': `Delete ${label}` },
        onclick: (e: MouseEvent) => { e.stopPropagation(); onDelete(); },
      }, icon('x')));
    }
    return b;
  }

  // ---------------------------------------------------------------- render
  function render() {
    const k = seg();
    if (!k || index === null) return close();
    const ks = studio.motion.keyframes;
    const b = ks[index + 1];
    const spec = k.easing;
    sub.textContent = `Segment ${index + 1} of ${ks.length - 1} · ${k.time.toFixed(2)} → ${b.time.toFixed(2)} s`;
    curveName.textContent = curveLabel(spec);
    if (!editor.dragging) editor.set(spec);

    // Saving: only for your own shapes that aren't saved under a name yet.
    const saved = savedCurves();
    const alreadySaved = !!spec.label && saved.some((s) => sameCurve(s, spec) && s.label === spec.label);
    const canSave = isOwn(spec) && !alreadySaved;
    if (!canSave) naming = false;
    saveOpen.hidden = !canSave || naming;
    nameForm.hidden = !naming;

    basics.replaceChildren(...BASIC_CURVES.map((c) => chip({ name: c.name }, c.label)));
    allToggle.textContent = showAll ? 'Fewer' : 'All curves';
    allToggle.setAttribute('aria-expanded', String(showAll));
    allBox.hidden = !showAll;
    if (showAll) {
      allBox.replaceChildren(...CURVE_GROUPS.flatMap((g) => [
        h('div', { class: 'grp' }, g.label),
        h('div', { class: 'chips' }, ...g.curves.map((c) => chip({ name: c.name }, c.label))),
      ]));
    }

    mineSec.hidden = saved.length === 0;
    mine.replaceChildren(...saved.map((s) => chip(s, s.label ?? curveLabel(s), () => { deleteCurve(s); render(); })));

    renderRoute(k, b);
    renderProgress();
  }

  function renderRoute(k: NonNullable<ReturnType<typeof seg>>, b: typeof k) {
    const resolved = resolvePath(k, b);
    const auto = k.path === 'auto';
    const hasPivot = !!(k.pivot || b.pivot);
    routeSummary.textContent = `${ROUTES.find((r) => r.v === resolved)!.label}${auto ? ' · automatic' : ''}`;
    routes.replaceChildren(...ROUTES.map((r) => {
      const on = r.v === resolved;
      const disabled = r.v === 'arc' && !hasPivot;
      return h('button', {
        type: 'button', class: `route-opt${on ? ' on' : ''}`, disabled,
        attrs: { role: 'radio', 'aria-checked': String(on) },
        onclick: () => { if (index !== null) studio.setSegmentPath(index, r.v); },
      }, h('span', { class: 'radio' }), h('span', {}, h('b', {}, r.label), h('small', {}, r.desc)));
    }), ...(auto ? [] : [h('button', {
      type: 'button', class: 'ghost small', onclick: () => { if (index !== null) studio.setSegmentPath(index, 'auto'); },
    }, 'Back to automatic')]));
  }

  function renderProgress() {
    const k = seg();
    if (!k || index === null) return;
    const b = studio.motion.keyframes[index + 1];
    const t = studio.time;
    editor.showProgress(t >= k.time && t <= b.time && b.time > k.time ? (t - k.time) / (b.time - k.time) : null);
  }

  // ---------------------------------------------------------------- actions
  allToggle.onclick = () => { showAll = !showAll; render(); };
  saveOpen.onclick = () => {
    naming = true;
    render();
    nameInput.value = `My curve ${savedCurves().length + 1}`;
    nameInput.select();
  };
  nameForm.onsubmit = (e) => {
    e.preventDefault();
    const k = seg();
    const name = nameInput.value.trim();
    if (!k || !name) return nameInput.focus();
    const named = saveCurve(k.easing, name);
    naming = false;
    setEasing(named);
    studio.notify(`Saved "${name}" to My curves`);
  };
  applyAll.onclick = () => {
    const k = seg();
    if (!k) return;
    studio.applyEasingToAll(k.easing);
    studio.notify(`"${curveLabel(k.easing)}" used on every segment`);
  };
  closeBtn.onclick = () => { close(); studio.selectSegment(null); };

  // ---------------------------------------------------------------- open / close / position
  function open(i: number, anchor: { x: number; top: number }) {
    index = i;
    naming = false;
    el.hidden = false;
    render();
    // Anchored by its bottom edge just above the timeline, so it grows upwards (All curves,
    // Camera route) and scrolls inside itself if it runs out of room.
    const r = el.getBoundingClientRect();
    const left = Math.min(innerWidth - r.width - 8, Math.max(8, anchor.x - r.width / 2));
    const bottom = innerHeight - anchor.top + 10;
    Object.assign(el.style, { left: `${left}px`, top: 'auto', bottom: `${bottom}px`, maxHeight: `${Math.max(240, anchor.top - 18)}px` });
  }

  function close() {
    index = null;
    el.hidden = true;
  }

  // Clicking elsewhere closes it (clicks on timeline segments are handled by the timeline).
  d.listen(document, 'pointerdown', (e) => {
    if (el.hidden) return;
    const t = e.target;
    if (t instanceof Element && (el.contains(t) || t.closest('.lseg') || t.closest('.sr-menu'))) return;
    close();
  }, { capture: true });
  d.listen(document, 'keydown', (e) => {
    if (el.hidden || e.key !== 'Escape') return;
    e.stopPropagation();
    // Esc while naming cancels the name; otherwise it closes the popover.
    if (naming && e.target === nameInput) { naming = false; render(); return; }
    close();
    studio.selectSegment(null);
  }, { capture: true });

  d.add(studio.on('motion', () => { if (index !== null) render(); }));
  d.add(studio.on('selection', () => { if (index !== null && studio.selectedSegment !== index) close(); }));
  d.add(studio.on('time', () => { if (index !== null) renderProgress(); }));
  d.add(() => el.remove());

  return { open, close, get index() { return index; } };
}
