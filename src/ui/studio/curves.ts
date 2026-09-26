// Easing curves as the UI presents them: four basics up front, the full library grouped behind
// "All curves", cubic-bezier equivalents (so a named curve can be the starting point for shaping
// your own), sampling (so any curve can be the starting point for sketching one), and the user's
// own named curves.

import { EASINGS, cloneEasing, easingFn, easingLabel, type EasingSpec } from '../../motion/easing';

export type Bezier = [number, number, number, number];

/** Shown up front. */
export const BASIC_CURVES: { name: string; label: string }[] = [
  { name: 'linear', label: 'Linear' },
  { name: 'easeInOutCubic', label: 'Smooth' },
  { name: 'easeInCubic', label: 'Ease in' },
  { name: 'easeOutCubic', label: 'Ease out' },
];

/** Behind "All curves", grouped by character rather than by formula. */
export const CURVE_GROUPS: { label: string; curves: { name: string; label: string }[] }[] = [
  { label: 'Gentle', curves: [
    { name: 'easeInOutSine', label: 'Gentle' }, { name: 'easeInSine', label: 'Gentle in' }, { name: 'easeOutSine', label: 'Gentle out' },
    { name: 'easeInOutQuad', label: 'Soft' }, { name: 'easeInQuad', label: 'Soft in' }, { name: 'easeOutQuad', label: 'Soft out' },
    { name: 'smoothstep', label: 'Smoothstep' }, { name: 'smootherstep', label: 'Smoother' },
  ] },
  { label: 'Strong', curves: [
    { name: 'easeInOutQuart', label: 'Firm' }, { name: 'easeInQuart', label: 'Firm in' }, { name: 'easeOutQuart', label: 'Firm out' },
    { name: 'easeInOutQuint', label: 'Strong' }, { name: 'easeInQuint', label: 'Strong in' }, { name: 'easeOutQuint', label: 'Strong out' },
    { name: 'easeInOutExpo', label: 'Sharp' }, { name: 'easeInExpo', label: 'Sharp in' }, { name: 'easeOutExpo', label: 'Sharp out' },
    { name: 'easeInOutCirc', label: 'Snap' }, { name: 'easeInCirc', label: 'Snap in' }, { name: 'easeOutCirc', label: 'Snap out' },
  ] },
  { label: 'Playful', curves: [
    { name: 'easeInBack', label: 'Anticipate' }, { name: 'easeOutBack', label: 'Overshoot' }, { name: 'easeInOutBack', label: 'Both' },
    { name: 'easeOutElastic', label: 'Elastic' }, { name: 'easeInElastic', label: 'Elastic in' }, { name: 'easeInOutElastic', label: 'Elastic both' },
    { name: 'easeOutBounce', label: 'Bounce' }, { name: 'easeInBounce', label: 'Bounce in' }, { name: 'easeInOutBounce', label: 'Bounce both' },
  ] },
  { label: 'Other', curves: [{ name: 'hold', label: 'Hold, then cut' }] },
];

const LABELS = new Map<string, string>([...BASIC_CURVES, ...CURVE_GROUPS.flatMap((g) => g.curves)].map((c) => [c.name, c.label]));

export function curveLabel(spec: EasingSpec): string {
  if (spec.label) return spec.label;
  if (spec.name === 'custom') return 'Custom';
  if (spec.name === 'sketch') return 'Sketch';
  return LABELS.get(spec.name) ?? easingLabel(spec);
}

/** cubic-bezier equivalents (easings.net) of the named curves that have one. */
const BEZIER: Record<string, Bezier> = {
  linear: [0, 0, 1, 1],
  smoothstep: [1 / 3, 0, 2 / 3, 1],
  smootherstep: [0.5, 0, 0.5, 1],
  easeInSine: [0.12, 0, 0.39, 0], easeOutSine: [0.61, 1, 0.88, 1], easeInOutSine: [0.37, 0, 0.63, 1],
  easeInQuad: [0.11, 0, 0.5, 0], easeOutQuad: [0.5, 1, 0.89, 1], easeInOutQuad: [0.45, 0, 0.55, 1],
  easeInCubic: [0.32, 0, 0.67, 0], easeOutCubic: [0.33, 1, 0.68, 1], easeInOutCubic: [0.65, 0, 0.35, 1],
  easeInQuart: [0.5, 0, 0.75, 0], easeOutQuart: [0.25, 1, 0.5, 1], easeInOutQuart: [0.76, 0, 0.24, 1],
  easeInQuint: [0.64, 0, 0.78, 0], easeOutQuint: [0.22, 1, 0.36, 1], easeInOutQuint: [0.83, 0, 0.17, 1],
  easeInExpo: [0.7, 0, 0.84, 0], easeOutExpo: [0.16, 1, 0.3, 1], easeInOutExpo: [0.87, 0, 0.13, 1],
  easeInCirc: [0.55, 0, 1, 0.45], easeOutCirc: [0, 0.55, 0.45, 1], easeInOutCirc: [0.85, 0, 0.15, 1],
  easeInBack: [0.36, 0, 0.66, -0.56], easeOutBack: [0.34, 1.56, 0.64, 1], easeInOutBack: [0.68, -0.6, 0.32, 1.6],
};

/** Handles to start from when the user begins shaping `spec` by hand. */
export function bezierFor(spec: EasingSpec): Bezier {
  if (spec.name === 'custom' && spec.bezier) return [...spec.bezier] as Bezier;
  return [...(BEZIER[spec.name] ?? [0.42, 0, 0.58, 1])] as Bezier;
}

/** True when the handles describe the curve exactly (otherwise they're only a starting point). */
export const hasExactBezier = (spec: EasingSpec) => spec.name === 'custom' || spec.name in BEZIER;

export const SKETCH_SAMPLES = 33;

/** Any curve as evenly spaced progress samples: the starting point for sketching over it. */
export function samplesFor(spec: EasingSpec, n = SKETCH_SAMPLES): number[] {
  if (spec.name === 'sketch' && spec.points?.length === n) return [...spec.points];
  const fn = easingFn(spec);
  return Array.from({ length: n }, (_, i) => fn(i / (n - 1)));
}

/** Vertical range drawn by every curve view, so overshoot stays visible. */
export const Y_MIN = -0.35, Y_MAX = 1.35;

/** SVG path of the curve inside a w×h box. */
export function curvePath(spec: EasingSpec, w: number, h: number, pad = 2, samples = 48): string {
  const fn = easingFn(spec);
  let d = '';
  for (let i = 0; i <= samples; i++) {
    const u = i / samples;
    const x = pad + u * (w - 2 * pad);
    const y = pad + (1 - (Math.max(Y_MIN, Math.min(Y_MAX, fn(u))) - Y_MIN) / (Y_MAX - Y_MIN)) * (h - 2 * pad);
    d += `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
  }
  return d;
}

/** Closed area between the curve and the progress-0 baseline (same box and range as `curvePath`). */
export function curveAreaPath(spec: EasingSpec, w: number, h: number, samples = 48): string {
  const base = ((1 - (0 - Y_MIN) / (Y_MAX - Y_MIN)) * h).toFixed(1);
  return `${curvePath(spec, w, h, 0, samples)}L${w},${base}L0,${base}Z`;
}

export function sameCurve(a: EasingSpec | undefined, b: EasingSpec): boolean {
  if (!a || a.name !== b.name) return false;
  const eq = (x?: number[], y?: number[]) => !!x && !!y && x.length === y.length && x.every((v, i) => Math.abs(v - y[i]) < 1e-3);
  if (a.name === 'custom') return eq(a.bezier, b.bezier);
  if (a.name === 'sketch') return eq(a.points, b.points);
  return a.name in EASINGS;
}

// ------------------------------------------------------------------ saved curves ("My curves")

const KEY = 'sharprig.curves';
const MAX_SAVED = 24;

/** Named custom / sketched curves, newest first. */
export function savedCurves(): EasingSpec[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || '[]');
    if (!Array.isArray(list)) return [];
    return list.filter((s): s is EasingSpec => !!s && typeof s === 'object' && (
      (s.name === 'custom' && Array.isArray(s.bezier) && s.bezier.length === 4) ||
      (s.name === 'sketch' && Array.isArray(s.points) && s.points.length >= 2)));
  } catch {
    return [];
  }
}

function store(list: EasingSpec[]) {
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX_SAVED))); } catch { /* storage unavailable */ }
}

/** Save under `name`, replacing a saved curve with the same name or the same shape. */
export function saveCurve(spec: EasingSpec, name: string): EasingSpec {
  const named = { ...cloneEasing(spec), label: name };
  store([named, ...savedCurves().filter((s) => s.label !== name && !sameCurve(s, named))]);
  return named;
}

export function deleteCurve(spec: EasingSpec) {
  store(savedCurves().filter((s) => !(s.label === spec.label && sameCurve(s, spec))));
}
