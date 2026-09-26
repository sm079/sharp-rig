// Viewport -> Pose Keyframes -> Motion Segments -> Easing.
//
// A keyframe stores a complete 6DoF camera pose (+ lens zoom) and, optionally, the pivot it was
// authored around. Every pair of neighbouring keyframes forms a segment whose single easing curve
// E(u) drives progress from pose A to pose B:
//   position:    interpolated (linear, Catmull-Rom spline, or pivot arc)
//   orientation: quaternion slerp

import { quat, v3, type Quat, type Vec3 } from '../math';
import { easingFn, type EasingSpec } from './easing';

export interface Pose {
  position: Vec3;
  rotation: Quat;
  /** focal-length multiplier (1 = the source photo's field of view) */
  zoom: number;
}

export type PathMode = 'auto' | 'linear' | 'spline' | 'arc';

export interface Keyframe {
  id: string;
  time: number;
  pose: Pose;
  /** pivot the pose was authored around (enables arc interpolation) */
  pivot: Vec3 | null;
  /** easing of the segment that STARTS at this keyframe */
  easing: EasingSpec;
  /** position interpolation of the segment that starts here */
  path: PathMode;
}

export interface Motion {
  name: string;
  duration: number;
  keyframes: Keyframe[];
}

let idCounter = 0;
export const newId = () => `k${Date.now().toString(36)}${(idCounter++).toString(36)}`;

export const identityPose = (): Pose => ({ position: [0, 0, 0], rotation: [0, 0, 0, 1], zoom: 1 });

export const clonePose = (p: Pose): Pose => ({
  position: v3.clone(p.position),
  rotation: [...p.rotation] as Quat,
  zoom: p.zoom,
});

export function makeKeyframe(time: number, pose: Pose, opts: Partial<Keyframe> = {}): Keyframe {
  return {
    id: newId(),
    time,
    pose: clonePose(pose),
    pivot: opts.pivot ? v3.clone(opts.pivot) : null,
    easing: opts.easing ?? { name: 'easeInOutCubic' },
    path: opts.path ?? 'auto',
  };
}

export function sortKeyframes(m: Motion) {
  m.keyframes.sort((a, b) => a.time - b.time);
}

/** Resolve 'auto': arc when both ends share an authored pivot, otherwise linear. */
export function resolvePath(a: Keyframe, b: Keyframe): Exclude<PathMode, 'auto'> {
  if (a.path !== 'auto') {
    if (a.path === 'arc' && !(a.pivot || b.pivot)) return 'linear';
    return a.path;
  }
  return a.pivot && b.pivot ? 'arc' : 'linear';
}

function catmullRom(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, t: number): Vec3 {
  const t2 = t * t, t3 = t2 * t;
  const out: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    out[i] = 0.5 * (2 * p1[i] + (-p0[i] + p2[i]) * t + (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * t2 +
      (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * t3);
  }
  return out;
}

export function interpolateSegment(
  kfs: Keyframe[], i: number, u: number,
): Pose {
  const a = kfs[i], b = kfs[i + 1];
  const e = easingFn(a.easing)(u);
  const rotation = quat.slerp(a.pose.rotation, b.pose.rotation, e);
  const zoom = a.pose.zoom + (b.pose.zoom - a.pose.zoom) * e;
  const mode = resolvePath(a, b);
  let position: Vec3;
  if (mode === 'arc') {
    // Rigid camera arm: express the arm (camera - pivot) in each camera's local frame,
    // interpolate it there, then re-attach it to the slerped orientation. A front pivot
    // yields subject orbits; rear/side/top pivots yield boom / jib sweeps.
    const pa = a.pivot ?? b.pivot!;
    const pb = b.pivot ?? a.pivot!;
    const armA = quat.rotate(quat.conj(a.pose.rotation), v3.sub(a.pose.position, pa));
    const armB = quat.rotate(quat.conj(b.pose.rotation), v3.sub(b.pose.position, pb));
    const la = v3.len(armA), lb = v3.len(armB);
    let arm = v3.lerp(armA, armB, e);
    const l = v3.len(arm);
    if (l > 1e-9) arm = v3.scale(arm, (la + (lb - la) * e) / l); // keep radius on the arc
    position = v3.add(v3.lerp(pa, pb, e), quat.rotate(rotation, arm));
  } else if (mode === 'spline') {
    const p0 = (kfs[i - 1] ?? a).pose.position;
    const p3 = (kfs[i + 2] ?? b).pose.position;
    // Extrapolate ghost points at the ends so the curve does not stall.
    const g0 = kfs[i - 1] ? p0 : v3.sub(v3.scale(a.pose.position, 2), b.pose.position);
    const g3 = kfs[i + 2] ? p3 : v3.sub(v3.scale(b.pose.position, 2), a.pose.position);
    position = catmullRom(g0, a.pose.position, b.pose.position, g3, e);
  } else {
    position = v3.lerp(a.pose.position, b.pose.position, e);
  }
  return { position, rotation, zoom };
}

/** Evaluate the camera pose at time t (seconds). Holds first / last pose outside the keyed range. */
export function evaluate(m: Motion, t: number): Pose | null {
  const k = m.keyframes;
  if (k.length === 0) return null;
  if (k.length === 1 || t <= k[0].time) return clonePose(k[0].pose);
  const last = k[k.length - 1];
  if (t >= last.time) return clonePose(last.pose);
  for (let i = 0; i < k.length - 1; i++) {
    const a = k[i], b = k[i + 1];
    if (t >= a.time && t <= b.time) {
      const span = b.time - a.time;
      const u = span > 1e-9 ? (t - a.time) / span : 1;
      return interpolateSegment(k, i, u);
    }
  }
  return clonePose(last.pose);
}

/** Pivot at time t (for gizmo display during playback). */
export function evaluatePivot(m: Motion, t: number): Vec3 | null {
  const k = m.keyframes;
  if (!k.length) return null;
  for (let i = 0; i < k.length - 1; i++) {
    const a = k[i], b = k[i + 1];
    if (t >= a.time && t <= b.time && resolvePath(a, b) === 'arc') {
      const e = easingFn(a.easing)((t - a.time) / Math.max(1e-9, b.time - a.time));
      return v3.lerp(a.pivot ?? b.pivot!, b.pivot ?? a.pivot!, e);
    }
  }
  return null;
}

export function cloneMotion(m: Motion): Motion {
  return JSON.parse(JSON.stringify(m));
}
