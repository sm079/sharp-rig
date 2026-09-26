// Easing curves E(u): [0,1] -> progress. Each motion segment owns exactly one.

export interface EasingSpec {
  /** a named curve, 'custom' (cubic-bezier) or 'sketch' (hand-drawn samples) */
  name: string;
  /** control points for name === 'custom' (CSS cubic-bezier semantics) */
  bezier?: [number, number, number, number];
  /** progress at evenly spaced times 0…1 for name === 'sketch' (first 0, last 1) */
  points?: number[];
  /** display name the user gave a custom or sketched curve */
  label?: string;
}

/** Deep copy (bezier / points arrays are not shared). */
export function cloneEasing(spec: EasingSpec): EasingSpec {
  const out: EasingSpec = { name: spec.name };
  if (spec.name === 'custom') out.bezier = [...(spec.bezier ?? [0.42, 0, 0.58, 1])] as EasingSpec['bezier'];
  if (spec.name === 'sketch') out.points = [...(spec.points ?? [0, 1])];
  if (spec.label && (spec.name === 'custom' || spec.name === 'sketch')) out.label = spec.label;
  return out;
}

type Fn = (t: number) => number;

const pow = Math.pow;
const PI = Math.PI;
const c1 = 1.70158;
const c2 = c1 * 1.525;
const c3 = c1 + 1;
const c4 = (2 * PI) / 3;
const c5 = (2 * PI) / 4.5;

function bounceOut(x: number) {
  const n1 = 7.5625, d1 = 2.75;
  if (x < 1 / d1) return n1 * x * x;
  if (x < 2 / d1) return n1 * (x -= 1.5 / d1) * x + 0.75;
  if (x < 2.5 / d1) return n1 * (x -= 2.25 / d1) * x + 0.9375;
  return n1 * (x -= 2.625 / d1) * x + 0.984375;
}

export const EASINGS: Record<string, Fn> = {
  linear: (t) => t,
  hold: (t) => (t >= 1 ? 1 : 0),
  easeInSine: (t) => 1 - Math.cos((t * PI) / 2),
  easeOutSine: (t) => Math.sin((t * PI) / 2),
  easeInOutSine: (t) => -(Math.cos(PI * t) - 1) / 2,
  easeInQuad: (t) => t * t,
  easeOutQuad: (t) => 1 - (1 - t) * (1 - t),
  easeInOutQuad: (t) => (t < 0.5 ? 2 * t * t : 1 - pow(-2 * t + 2, 2) / 2),
  easeInCubic: (t) => t * t * t,
  easeOutCubic: (t) => 1 - pow(1 - t, 3),
  easeInOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - pow(-2 * t + 2, 3) / 2),
  easeInQuart: (t) => t * t * t * t,
  easeOutQuart: (t) => 1 - pow(1 - t, 4),
  easeInOutQuart: (t) => (t < 0.5 ? 8 * t * t * t * t : 1 - pow(-2 * t + 2, 4) / 2),
  easeInQuint: (t) => t * t * t * t * t,
  easeOutQuint: (t) => 1 - pow(1 - t, 5),
  easeInOutQuint: (t) => (t < 0.5 ? 16 * t * t * t * t * t : 1 - pow(-2 * t + 2, 5) / 2),
  easeInExpo: (t) => (t === 0 ? 0 : pow(2, 10 * t - 10)),
  easeOutExpo: (t) => (t === 1 ? 1 : 1 - pow(2, -10 * t)),
  easeInOutExpo: (t) =>
    t === 0 ? 0 : t === 1 ? 1 : t < 0.5 ? pow(2, 20 * t - 10) / 2 : (2 - pow(2, -20 * t + 10)) / 2,
  easeInCirc: (t) => 1 - Math.sqrt(1 - t * t),
  easeOutCirc: (t) => Math.sqrt(1 - pow(t - 1, 2)),
  easeInOutCirc: (t) =>
    t < 0.5 ? (1 - Math.sqrt(1 - pow(2 * t, 2))) / 2 : (Math.sqrt(1 - pow(-2 * t + 2, 2)) + 1) / 2,
  easeInBack: (t) => c3 * t * t * t - c1 * t * t,
  easeOutBack: (t) => 1 + c3 * pow(t - 1, 3) + c1 * pow(t - 1, 2),
  easeInOutBack: (t) =>
    t < 0.5
      ? (pow(2 * t, 2) * ((c2 + 1) * 2 * t - c2)) / 2
      : (pow(2 * t - 2, 2) * ((c2 + 1) * (t * 2 - 2) + c2) + 2) / 2,
  easeInElastic: (t) => (t === 0 ? 0 : t === 1 ? 1 : -pow(2, 10 * t - 10) * Math.sin((t * 10 - 10.75) * c4)),
  easeOutElastic: (t) => (t === 0 ? 0 : t === 1 ? 1 : pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1),
  easeInOutElastic: (t) =>
    t === 0 ? 0 : t === 1 ? 1 : t < 0.5
      ? -(pow(2, 20 * t - 10) * Math.sin((20 * t - 11.125) * c5)) / 2
      : (pow(2, -20 * t + 10) * Math.sin((20 * t - 11.125) * c5)) / 2 + 1,
  easeInBounce: (t) => 1 - bounceOut(1 - t),
  easeOutBounce: bounceOut,
  easeInOutBounce: (t) => (t < 0.5 ? (1 - bounceOut(1 - 2 * t)) / 2 : (1 + bounceOut(2 * t - 1)) / 2),
  smoothstep: (t) => t * t * (3 - 2 * t),
  smootherstep: (t) => t * t * t * (t * (t * 6 - 15) + 10),
};

/** CSS-style cubic-bezier(x1, y1, x2, y2). */
function cubicBezier(x1: number, y1: number, x2: number, y2: number): Fn {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sy = (t: number) => ((ay * t + by) * t + cy) * t;
  const dx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = sx(t) - x;
      if (Math.abs(err) < 1e-6) return sy(t);
      const d = dx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    let lo = 0, hi = 1;
    t = x;
    for (let i = 0; i < 40; i++) {
      const v = sx(t);
      if (Math.abs(v - x) < 1e-7) break;
      if (v < x) lo = t; else hi = t;
      t = (lo + hi) / 2;
    }
    return sy(t);
  };
}

const bezierCache = new Map<string, Fn>();
const sketchCache = new Map<string, Fn>();

/** Smooth (Catmull-Rom) interpolation through evenly spaced samples. */
function sampled(points: number[]): Fn {
  const p = points.length >= 2 ? points : [0, 1];
  const n = p.length - 1;
  const at = (i: number) => p[Math.max(0, Math.min(n, i))];
  return (x: number) => {
    if (x <= 0) return p[0];
    if (x >= 1) return p[n];
    const f = x * n, i = Math.floor(f), t = f - i;
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
  };
}

export function easingFn(spec: EasingSpec): Fn {
  if (spec.name === 'custom') {
    const b = spec.bezier ?? [0.42, 0, 0.58, 1];
    const key = b.join(',');
    let fn = bezierCache.get(key);
    if (!fn) bezierCache.set(key, (fn = cubicBezier(b[0], b[1], b[2], b[3])));
    return fn;
  }
  if (spec.name === 'sketch') {
    const key = (spec.points ?? []).join(',');
    let fn = sketchCache.get(key);
    if (!fn) {
      if (sketchCache.size > 200) sketchCache.clear();
      sketchCache.set(key, (fn = sampled(spec.points ?? [])));
    }
    return fn;
  }
  return EASINGS[spec.name] ?? EASINGS.linear;
}

export function easingLabel(spec: EasingSpec): string {
  if (spec.label) return spec.label;
  if (spec.name === 'sketch') return 'Sketch';
  if (spec.name === 'custom') return `bezier(${(spec.bezier ?? []).map((v) => +v.toFixed(2)).join(', ')})`;
  return spec.name.replace(/^ease/, '').replace(/([a-z])([A-Z])/g, '$1 $2') || spec.name;
}
