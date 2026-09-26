// Interactive easing curve: progress (y) over the segment's time (x). Two ways to make your own:
//   handles: drag the two cubic-bezier handles (starting from the current curve's closest bezier)
//   draw:    sketch over the curve; wherever the stroke passes, the curve follows it
// Both allow overshoot (−0.3…1.3). A sketch keeps progress 0 at the start and 1 at the end, so
// the camera still lands exactly on each keyframe.

import { easingFn, type EasingSpec } from '../../motion/easing';
import { bezierFor, curvePath, hasExactBezier, samplesFor, SKETCH_SAMPLES, Y_MAX, Y_MIN, type Bezier } from './curves';

export type CurveMode = 'handles' | 'draw';

const NS = 'http://www.w3.org/2000/svg';
const W = 292, H = 176, PAD = 14;
const LIM_LO = -0.3, LIM_HI = 1.3;

const sx = (x: number) => PAD + x * (W - 2 * PAD);
const sy = (y: number) => PAD + (1 - (y - Y_MIN) / (Y_MAX - Y_MIN)) * (H - 2 * PAD);
const clampY = (y: number) => Math.max(LIM_LO, Math.min(LIM_HI, y));

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

export class CurveEditor {
  readonly el: SVGSVGElement;
  /** Called continuously while the curve is being shaped. */
  onChange: (spec: EasingSpec) => void = () => {};
  mode: CurveMode = 'handles';
  private spec: EasingSpec = { name: 'linear' };
  private handles: Bezier = [0, 0, 1, 1];
  private curve: SVGPathElement;
  private arms: [SVGLineElement, SVGLineElement];
  private knobs: [SVGCircleElement, SVGCircleElement];
  private dot: SVGCircleElement;
  private drag: 0 | 1 | null = null;
  private sketch: { points: number[]; last: [number, number] } | null = null;

  constructor() {
    this.el = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'curve-editor', role: 'img', 'aria-label': 'Easing curve editor' });
    const grid = el('g', { class: 'grid' });
    for (const y of [0, 1]) grid.append(el('line', { x1: sx(0), x2: sx(1), y1: sy(y), y2: sy(y) }));
    for (const x of [0, 0.25, 0.5, 0.75, 1]) grid.append(el('line', { class: x % 1 ? 'minor' : '', x1: sx(x), x2: sx(x), y1: sy(LIM_LO), y2: sy(LIM_HI) }));
    const lbl = (text: string, x: number, y: number, anchor = 'start') => { const t = el('text', { x, y, 'text-anchor': anchor }); t.textContent = text; grid.append(t); };
    lbl('start', sx(0) + 3, sy(0) + 12);
    lbl('end', sx(1) - 3, sy(1) - 5, 'end');
    this.curve = el('path', { class: 'curve' });
    this.arms = [el('line', { class: 'arm' }), el('line', { class: 'arm' })];
    this.knobs = [el('circle', { class: 'knob', r: 6 }), el('circle', { class: 'knob', r: 6 })];
    this.dot = el('circle', { class: 'dot', r: 4 });
    this.el.append(grid, ...this.arms, this.curve, ...this.knobs, this.dot);

    this.el.addEventListener('pointerdown', (e) => this.down(e));
    this.el.addEventListener('pointermove', (e) => this.move(e));
    const end = () => this.up();
    this.el.addEventListener('pointerup', end);
    this.el.addEventListener('pointercancel', end);
  }

  get dragging() {
    return this.drag !== null || this.sketch !== null;
  }

  setMode(mode: CurveMode) {
    this.mode = mode;
    this.el.dataset.mode = mode;
  }

  set(spec: EasingSpec) {
    this.spec = spec;
    this.handles = bezierFor(spec);
    this.el.classList.toggle('approx', !hasExactBezier(spec));
    this.draw();
  }

  /** Show where the playhead is on the curve (u in 0…1), or hide with null. */
  showProgress(u: number | null) {
    this.dot.style.display = u === null ? 'none' : '';
    if (u === null) return;
    this.dot.setAttribute('cx', String(sx(u)));
    this.dot.setAttribute('cy', String(sy(Math.max(Y_MIN, Math.min(Y_MAX, easingFn(this.spec)(u))))));
  }

  // ---------------------------------------------------------------- input

  private down(e: PointerEvent) {
    const [x, y] = this.toCurve(e);
    if (this.mode === 'handles') {
      const d0 = Math.hypot(x - this.handles[0], (y - this.handles[1]) * 0.6);
      const d1 = Math.hypot(x - this.handles[2], (y - this.handles[3]) * 0.6);
      if (Math.min(d0, d1) > 0.2) return;
      this.drag = d0 <= d1 ? 0 : 1;
    } else {
      this.sketch = { points: samplesFor(this.spec), last: [x, clampY(y)] };
      this.paint(x, clampY(y));
    }
    this.el.setPointerCapture(e.pointerId);
    this.el.classList.add('dragging');
    e.preventDefault();
  }

  private move(e: PointerEvent) {
    const [x, y] = this.toCurve(e);
    if (this.drag !== null) {
      const b = [...this.handles] as Bezier;
      b[this.drag * 2] = Math.round(Math.max(0, Math.min(1, x)) * 100) / 100;
      b[this.drag * 2 + 1] = Math.round(clampY(y) * 100) / 100;
      this.emit({ name: 'custom', bezier: b });
    } else if (this.sketch) {
      this.paint(x, clampY(y));
    }
  }

  private up() {
    if (this.sketch) {
      // One light smoothing pass takes the hand jitter out; the ends stay pinned.
      const p = this.sketch.points;
      const s = p.map((v, i) => (i === 0 || i === p.length - 1 ? v : (p[i - 1] + 2 * v + p[i + 1]) / 4));
      this.sketch = null;
      this.emit({ name: 'sketch', points: s.map((v) => Math.round(v * 1000) / 1000) });
    }
    this.drag = null;
    this.el.classList.remove('dragging');
  }

  /** Write the stroke from the last pointer position to (x, y) into the samples it crosses. */
  private paint(x: number, y: number) {
    const sk = this.sketch!;
    const n = SKETCH_SAMPLES - 1;
    const [x0, y0] = sk.last;
    const i0 = Math.round(Math.max(0, Math.min(1, Math.min(x0, x))) * n);
    const i1 = Math.round(Math.max(0, Math.min(1, Math.max(x0, x))) * n);
    for (let i = i0; i <= i1; i++) {
      const t = x === x0 ? 1 : (i / n - x0) / (x - x0);
      sk.points[i] = clampY(y0 + (y - y0) * Math.max(0, Math.min(1, t)));
    }
    sk.points[0] = 0;
    sk.points[n] = 1;
    sk.last = [x, y];
    this.emit({ name: 'sketch', points: [...sk.points] });
  }

  private emit(spec: EasingSpec) {
    this.set(spec);
    this.onChange(spec);
  }

  // ---------------------------------------------------------------- drawing

  private draw() {
    this.curve.setAttribute('d', curvePath(this.spec, W - 2 * PAD, H - 2 * PAD, 0, 120));
    this.curve.setAttribute('transform', `translate(${PAD} ${PAD})`);
    const [x1, y1, x2, y2] = this.handles;
    const set = (e: Element, a: Record<string, number>) => { for (const [k, v] of Object.entries(a)) e.setAttribute(k, String(v)); };
    set(this.arms[0], { x1: sx(0), y1: sy(0), x2: sx(x1), y2: sy(y1) });
    set(this.arms[1], { x1: sx(1), y1: sy(1), x2: sx(x2), y2: sy(y2) });
    set(this.knobs[0], { cx: sx(x1), cy: sy(y1) });
    set(this.knobs[1], { cx: sx(x2), cy: sy(y2) });
  }

  private toCurve(e: PointerEvent): [number, number] {
    const r = this.el.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const py = ((e.clientY - r.top) / r.height) * H;
    return [(px - PAD) / (W - 2 * PAD), Y_MIN + (1 - (py - PAD) / (H - 2 * PAD)) * (Y_MAX - Y_MIN)];
  }
}
